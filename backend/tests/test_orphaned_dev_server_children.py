"""If a `dg dev` front process dies alone, its daemon/webserver/code-server get re-parented to init
and were never found again. A surviving daemon keeps heartbeating, so the next dev server's daemons
report "Another daemon is still sending heartbeats ... multiple daemon processes" and backfills,
schedules and sensors on that instance fail. The sweep must find those orphans -- and ONLY those."""
from types import SimpleNamespace

import pytest

from app.api import dagster_webserver as dw

class FakeProc:
    def __init__(self, pid, ppid, cmd):
        self.info = {"pid": pid, "ppid": ppid, "cmdline": cmd.split(" ") if cmd else []}
        self.pid = pid

    def cwd(self):
        raise dw.psutil.NoSuchProcess(self.pid)  # these aren't `dg dev` roots

    def children(self, recursive=False):
        return []


@pytest.fixture()
def root(tmp_path, monkeypatch):
    projects = (tmp_path / "projects").resolve()
    projects.mkdir()
    monkeypatch.setattr(dw.settings, "projects_dir", projects)
    return str(projects)


@pytest.fixture()
def sweep(monkeypatch, root):
    def run(procs):
        monkeypatch.setattr(dw.psutil, "process_iter", lambda attrs=None: iter(procs))
        return sorted(pid for pid, _, _ in dw.find_all_designer_dev_servers())
    return run


def cmds(root):
    py = f"{root}/project_1/.venv/bin/python"
    return {
        "daemon": f"{py} -m dagster._daemon run --log-level info",
        "web": f"{py} -m dagster_webserver --port 3000",
        "code": f"{py} -m dagster code-server start --socket /tmp/x",
        "grpc": f"{py} -m dagster api grpc --lazy-load-user-code",
        "train": f"{py} train.py",
    }


def test_orphaned_children_of_a_dead_dev_server_are_found(sweep, root):
    c = cmds(root)
    assert sweep([FakeProc(10, 1, c["daemon"]), FakeProc(11, 1, c["web"]), FakeProc(12, 1, c["code"]), FakeProc(13, 1, c["grpc"])]) == [10, 11, 12, 13]


def test_children_with_a_live_parent_are_left_alone(sweep, root):
    # e.g. the transient code server a one-shot `dg list defs` spawns -- killing it broke validation before
    c = cmds(root)
    assert sweep([FakeProc(20, 4242, c["code"]), FakeProc(21, 4242, c["grpc"])]) == []


def test_orphans_outside_this_installs_projects_dir_are_left_alone(sweep):
    other = "/Users/me/work/my-own-project/.venv/bin/python -m dagster._daemon run"
    assert sweep([FakeProc(30, 1, other)]) == []


def test_unrelated_orphans_and_empty_cmdlines_are_left_alone(sweep, root):
    c = cmds(root)
    assert sweep([FakeProc(40, 1, c["train"]), FakeProc(41, 1, ""), FakeProc(42, 1, "/usr/bin/some-daemon")]) == []
