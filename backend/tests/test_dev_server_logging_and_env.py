"""`dg dev` start: (1) its output goes to a log file, not an undrained pipe -- a run worker froze in
write() after the pipe filled, leaving its run STARTED and its backfill waiting forever; (2) it runs in
the PROJECT's environment, including DESIGNER_PROJECT_DATA_DIR -- without it every dbt run launched by
the daemon (backfills, schedules, sensors) failed with 'Cannot open file .../.local_defs_state/data/...'."""
import sys
import textwrap

import pytest
from fastapi import HTTPException

from app.api import dagster_webserver as dw


def spawn(tmp_path, code, *, name="dg-dev.log"):
    log = tmp_path / ".designer_dagster_home" / name
    proc = dw._spawn_dev_server([sys.executable, "-c", textwrap.dedent(code)], str(tmp_path), {"PATH": "/usr/bin:/bin"}, log)
    return proc, log


def test_a_chatty_dev_server_never_blocks_on_its_output(tmp_path):
    """After the 'Serving' line, 3 MB of further output (far past a 64 KB pipe buffer) must not stall it."""
    proc, log = spawn(tmp_path, """
        import sys
        print("Serving Dagster UI on http://0.0.0.0:3055", flush=True)
        for _ in range(3000):
            sys.stdout.write("x" * 1023 + "\\n")
            sys.stderr.write("y" * 1023 + "\\n")
    """)
    port, lines = dw._wait_for_dev_server_startup(proc, log, 3000, ["fake"], timeout=20)
    assert port == 3055 and any("Serving" in l for l in lines)
    assert proc.wait(timeout=20) == 0                       # with an unread pipe this hangs forever
    assert log.stat().st_size > 5_000_000                    # stdout and stderr both landed in the file


def test_an_early_exit_reports_the_return_code_and_the_output(tmp_path):
    proc, log = spawn(tmp_path, """
        import sys
        print("something exploded"); print("details", file=sys.stderr); sys.exit(3)
    """)
    with pytest.raises(HTTPException) as e:
        dw._wait_for_dev_server_startup(proc, log, 3000, ["dg", "dev"], timeout=20)
    d = e.value.detail
    assert e.value.status_code == 500 and d["returncode"] == 3 and "exited unexpectedly with code 3" in d["message"]
    assert "something exploded" in d["startup_log"] and "details" in d["startup_log"]


def test_a_server_that_never_prints_serving_falls_back_to_the_requested_port(tmp_path):
    proc, log = spawn(tmp_path, "import time; print('booting', flush=True); time.sleep(30)")
    try:
        port, lines = dw._wait_for_dev_server_startup(proc, log, 3123, ["x"], timeout=1.0, poll=0.05)
        assert port == 3123 and lines == ["booting"]
    finally:
        proc.kill(); proc.wait()


def test_the_previous_sessions_log_is_kept(tmp_path):
    proc, log = spawn(tmp_path, "print('first session')")
    proc.wait(); assert "first session" in log.read_text()
    proc2, log2 = spawn(tmp_path, "print('second session')")
    proc2.wait()
    assert "second session" in log.read_text() and "first session" not in log.read_text()
    assert "first session" in (log.parent / "dg-dev.log.1").read_text()


def test_the_dev_server_env_carries_the_projects_environment(tmp_path):
    project = tmp_path / "proj"
    (project / ".venv/bin").mkdir(parents=True)
    env = dw._dev_server_env(project)
    # what lets dbt profiles resolve the real data dir from inside dbt's staged copy
    assert env["DESIGNER_PROJECT_DATA_DIR"] == str((project / "data").resolve())
    assert env["VIRTUAL_ENV"] == str((project / ".venv").resolve())
    assert env["PATH"].startswith(str((project / ".venv/bin")))
    assert env["DAGSTER_HOME"] == str(project.resolve() / ".designer_dagster_home")
    assert "PYTHONHOME" not in env
    assert "DAGSTER_COMMUNITY_COMPONENTS_SKIP_LIBRARY_JSON" not in env      # must advertise the full library


# ---- keeping a long-lived dev server's log bounded ------------------------------------------

def test_small_logs_are_left_alone(tmp_path):
    log = tmp_path / "dg-dev.log"
    log.write_text("hello\n")
    assert dw.trim_dev_server_log(log, max_bytes=100, keep_bytes=50) is False
    assert log.read_text() == "hello\n"
    assert dw.trim_dev_server_log(tmp_path / "missing.log") is False       # never raises


def test_an_oversized_log_keeps_its_recent_tail_on_whole_lines(tmp_path):
    log = tmp_path / "dg-dev.log"
    log.write_text("".join(f"line {i:04d}\n" for i in range(1000)))          # 10 KB
    assert dw.trim_dev_server_log(log, max_bytes=5_000, keep_bytes=1_000) is True
    text = log.read_text()
    assert text.startswith("[... older output trimmed")
    body = text.split("\n", 1)[1].splitlines()
    assert body[-1] == "line 0999" and all(l.startswith("line ") for l in body)   # no torn first line
    assert len(text) < 1_300


def test_a_server_holding_the_file_open_keeps_writing_at_the_real_end_after_a_trim(tmp_path):
    """The dev server keeps the log open while Designer trims it. Opened in append mode its next write
    lands at the new end -- not at the old offset, which would leave a multi-MB hole of NUL bytes."""
    proc, log = spawn(tmp_path, """
        import sys, time
        print("Serving Dagster UI on http://0.0.0.0:3055", flush=True)
        for i in range(2000):
            print("before %04d " % i + "x" * 100, flush=True)
        print("TRIM-NOW", flush=True)
        time.sleep(2)
        print("after the trim", flush=True)
    """)
    deadline = __import__("time").time() + 20
    while "TRIM-NOW" not in log.read_text(errors="replace") and __import__("time").time() < deadline:
        __import__("time").sleep(0.05)
    assert dw.trim_dev_server_log(log, max_bytes=50_000, keep_bytes=10_000) is True
    assert proc.wait(timeout=20) == 0
    data = log.read_bytes()
    assert b"\x00" not in data                                  # no sparse hole
    assert data.rstrip().endswith(b"after the trim") and len(data) < 30_000
