"""Liveness logic behind reconcile_dead_runs (scripts/query_local_runs.py):
a local run whose process is gone must be closed out instead of showing
"running" forever -- without ever failing a run whose process is alive, and
without being fooled by the OS reusing a dead run's PID for an unrelated process."""
import os
import subprocess
import sys
import time

from scripts import query_local_runs as q


def test_own_live_process_is_alive():
    # `since` = now: this process necessarily started before the run "began".
    assert q._pid_alive(os.getpid(), since=time.time()) is True


def test_dead_pid_is_not_alive():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    assert q._pid_alive(p.pid, since=time.time() - 3600) is False


def test_reused_pid_is_not_the_run_process(monkeypatch):
    # A live process that STARTED AFTER the run did can't be that run's process
    # (the real case: pid 738 reused by a macOS system service days later).
    monkeypatch.setattr(q, "_process_start_time", lambda pid: time.time())
    assert q._pid_alive(os.getpid(), since=time.time() - 3 * 86400) is False


def test_live_process_that_predates_the_run_is_alive(monkeypatch):
    monkeypatch.setattr(q, "_process_start_time", lambda pid: time.time() - 7200)
    assert q._pid_alive(os.getpid(), since=time.time() - 60) is True


def test_unknown_start_time_is_assumed_alive(monkeypatch):
    # Never fail a possibly-live run just because the start time can't be read.
    monkeypatch.setattr(q, "_process_start_time", lambda pid: None)
    assert q._pid_alive(os.getpid(), since=time.time() - 3 * 86400) is True


def test_permission_error_still_gets_the_start_time_check(monkeypatch):
    def deny(pid, sig):
        raise PermissionError

    monkeypatch.setattr(os, "kill", deny)
    monkeypatch.setattr(q, "_process_start_time", lambda pid: time.time())
    assert q._pid_alive(1, since=time.time() - 3 * 86400) is False


def test_process_start_time_reads_a_real_process():
    t = q._process_start_time(os.getpid())
    assert t is not None and t <= time.time() + 5


# ---------------------------------------------------------------------------------------------
# run_process_is_gone: the decision. A wrong "yes" fails a healthy run -- 24 of 34 runs in one real
# backfill were failed this way, because runs waiting in the queue were judged against their CREATION
# time and their brand-new worker looked like an unrelated reused pid.
# ---------------------------------------------------------------------------------------------
import os as _os


def gone(status="STARTED", start_time=None, pid=None, now=None):
    return q.run_process_is_gone(status, start_time, pid, now)


def test_a_run_that_never_started_is_never_judged_dead():
    """The real failure: start_time None (queued ~36s, worker spawned 2s ago, no PIPELINE_START yet)."""
    dead_pid = subprocess.Popen([sys.executable, "-c", "pass"])
    dead_pid.wait()
    assert gone("STARTED", start_time=None, pid=dead_pid.pid) is False
    assert gone("STARTING", start_time=None, pid=dead_pid.pid) is False
    assert gone("QUEUED", start_time=time.time() - 3600, pid=dead_pid.pid) is False


def test_a_live_worker_that_booted_before_the_run_started_is_alive(monkeypatch):
    # A queued run's real timeline: created, queued ~36s, worker boots, THEN start_time is recorded.
    # So the worker is always older than start_time; judged against it, it is alive.
    start = time.time() - 120
    monkeypatch.setattr(q, "_process_start_time", lambda pid: start - 10)          # booted 10s before PIPELINE_START
    assert gone("STARTED", start_time=start, pid=_os.getpid()) is False


def test_a_recently_started_run_gets_a_grace_period():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    assert gone("STARTED", start_time=time.time() - 5, pid=p.pid) is False        # dead pid, but only 5s old


def test_a_started_run_with_a_dead_worker_is_judged_dead():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    assert gone("STARTED", start_time=time.time() - 300, pid=p.pid) is True
    assert gone("CANCELING", start_time=time.time() - 300, pid=p.pid) is True


def test_a_reused_pid_is_still_caught_once_the_run_really_started(monkeypatch):
    # the pid is alive but belongs to a process started AFTER the run did (days later, e.g. a system service)
    monkeypatch.setattr(q, "_process_start_time", lambda pid: time.time())
    assert gone("STARTED", start_time=time.time() - 3 * 86400, pid=_os.getpid()) is True


def test_finished_runs_and_missing_pids_are_left_alone():
    assert gone("SUCCESS", start_time=time.time() - 300, pid=999999) is False
    assert gone("FAILURE", start_time=time.time() - 300, pid=999999) is False
    assert gone("STARTED", start_time=time.time() - 300, pid=None) is False
