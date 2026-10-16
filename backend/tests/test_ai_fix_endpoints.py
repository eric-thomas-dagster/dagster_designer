"""HTTP plumbing for the AI fix feature, with a fake `claude` binary so it costs
nothing and never touches real projects: run (stream) -> result -> undo/keep."""
import json
import os
import stat
import textwrap
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import ai_fix_service as svc
from app.services import dagster_ai_service
from app.api import ai_fix as api


FAKE_CLAUDE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, sys, pathlib
    args = sys.argv[1:]
    mode_fix = "acceptEdits" in args
    print(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "x"}}]}}), flush=True)
    if mode_fix:
        p = pathlib.Path("src/mod/defs/a/defs.yaml")
        p.write_text(p.read_text().replace("lots", "200"))
        pathlib.Path("src/mod/defs/created.yaml").write_text("new: 1\\n")
    print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}}), flush=True)
    print(json.dumps({"type": "result", "result": "all fixed", "total_cost_usd": 0.12, "is_error": False}), flush=True)
''')


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(svc.settings, "data_dir", tmp_path / "data")
    proj = tmp_path / "proj"
    (proj / "src/mod/defs/a").mkdir(parents=True)
    (proj / "src/mod/defs/a/defs.yaml").write_text("row_count: lots\n")
    fake = tmp_path / "claude"
    fake.write_text(FAKE_CLAUDE)
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)

    fake_project = SimpleNamespace(id="p1", name="P", is_dagster_plus=False, component_install_mode="as_package")
    monkeypatch.setattr(api.project_service, "get_project", lambda pid: fake_project if pid == "p1" else None)
    monkeypatch.setattr(api.project_service, "_get_project_dir", lambda p: proj)
    monkeypatch.setattr(api.project_service, "get_project_root_module", lambda p: "mod")
    monkeypatch.setattr(dagster_ai_service, "find_claude_cli", lambda: str(fake))

    async def fake_validate(project):
        return True, None
    monkeypatch.setattr(api.asset_introspection_service, "validate_project_defs_async", fake_validate)

    async def fake_status():
        return {"cli_available": True, "dagster_expert_installed": True}
    monkeypatch.setattr(dagster_ai_service, "status", fake_status)
    return SimpleNamespace(client=TestClient(app), proj=proj)


def _run(env, mode):
    r = env.client.post("/api/v1/projects/p1/ai-fix/run", json={"mode": mode, "error_text": "boom"})
    assert r.status_code == 200, r.text
    return [json.loads(l) for l in r.text.splitlines() if l.strip()]


def test_status(env):
    assert env.client.get("/api/v1/ai-fix/status").json() == {
        "claude_found": True, "skill_installed": True, "can_run": True, "reason": None}


def test_fix_stream_result_undo_roundtrip(env):
    events = _run(env, "fix")
    started = events[0]
    assert started["event"] == "started" and started["mode"] == "fix" and started["snapshot_id"]
    assert any(e.get("type") == "result" and e["result"] == "all fixed" for e in events)
    assert events[-1]["event"] == "finished" and events[-1]["returncode"] == 0
    sid = started["snapshot_id"]

    res = env.client.get(f"/api/v1/projects/p1/ai-fix/{sid}/result").json()
    assert res["valid"] is True
    by = {c["path"]: c["status"] for c in res["changes"]}
    assert by == {"src/mod/defs/a/defs.yaml": "modified", "src/mod/defs/created.yaml": "added"}

    u = env.client.post(f"/api/v1/projects/p1/ai-fix/{sid}/undo").json()
    assert sorted(u["restored"]) == sorted(by)
    assert (env.proj / "src/mod/defs/a/defs.yaml").read_text() == "row_count: lots\n"
    assert not (env.proj / "src/mod/defs/created.yaml").exists()
    # snapshot is consumed -> a second undo is a clean 404, not a crash
    assert env.client.post(f"/api/v1/projects/p1/ai-fix/{sid}/undo").status_code == 404


def test_keep_leaves_changes_and_drops_the_snapshot(env):
    sid = _run(env, "fix")[0]["snapshot_id"]
    assert env.client.post(f"/api/v1/projects/p1/ai-fix/{sid}/keep").json() == {"kept": True}
    assert (env.proj / "src/mod/defs/a/defs.yaml").read_text() == "row_count: 200\n"
    assert env.client.get(f"/api/v1/projects/p1/ai-fix/{sid}/result").status_code == 404


def test_explain_mode_takes_no_snapshot_and_changes_nothing(env):
    events = _run(env, "explain")
    assert events[0]["snapshot_id"] is None
    assert (env.proj / "src/mod/defs/a/defs.yaml").read_text() == "row_count: lots\n"


def test_rejects_bad_requests(env):
    c = env.client
    assert c.post("/api/v1/projects/nope/ai-fix/run", json={"mode": "fix", "error_text": "x"}).status_code == 404
    assert c.post("/api/v1/projects/p1/ai-fix/run", json={"mode": "fix", "error_text": "  "}).status_code == 400
    assert c.post("/api/v1/projects/p1/ai-fix/run", json={"mode": "yolo", "error_text": "x"}).status_code == 422
    assert c.post("/api/v1/projects/p1/ai-fix/..%2F..%2Fx/undo").status_code in (400, 404)
    assert c.get("/api/v1/projects/p1/ai-fix/not-an-id/result").status_code == 400


def test_dagster_plus_projects_are_refused(env, monkeypatch):
    cloud = SimpleNamespace(id="p1", name="P", is_dagster_plus=True, component_install_mode=None)
    monkeypatch.setattr(api.project_service, "get_project", lambda pid: cloud)
    r = env.client.post("/api/v1/projects/p1/ai-fix/run", json={"mode": "fix", "error_text": "x"})
    assert r.status_code == 400 and "local projects" in r.json()["detail"]
