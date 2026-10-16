"""Finding the run a just-clicked Materialize created, so the UI can link to it
while `dg launch` is still blocking (dg launch accepts no run id or tag)."""
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api import runs as runs_api
from app.main import app
from scripts.query_local_runs import pick_started_run


def _c(rid, created, assets=()):
    return {"run_id": rid, "status": "STARTED", "created": created, "assets": set(assets)}


def test_ignores_runs_created_before_the_click():
    assert pick_started_run([_c("old", 90)], since=100) is None


def test_picks_the_new_run():
    assert pick_started_run([_c("old", 90), _c("new", 105)], since=100)["run_id"] == "new"


def test_newest_wins_without_a_hint():
    assert pick_started_run([_c("a", 101), _c("b", 103)], since=100)["run_id"] == "b"


def test_prefers_the_run_that_overlaps_the_requested_assets():
    # Someone else's run started later, but ours is the one touching "orders".
    runs = [_c("ours", 101, {"orders", "customers"}), _c("other", 104, {"raw_events"})]
    assert pick_started_run(runs, since=100, wanted={"orders"})["run_id"] == "ours"


def test_falls_back_to_newest_when_nothing_overlaps():
    runs = [_c("a", 101, {"x"}), _c("b", 103, {"y"})]
    assert pick_started_run(runs, since=100, wanted={"zzz"})["run_id"] == "b"


def test_endpoint_normalizes_selection_syntax_and_returns_the_run(monkeypatch):
    seen = {}

    async def fake_query(project, mode, args):
        seen.update(mode=mode, args=args)
        return {"run_id": "r1", "status": "STARTED"}

    monkeypatch.setattr(runs_api.project_service, "get_project", lambda pid: SimpleNamespace(id=pid, is_dagster_plus=False))
    monkeypatch.setattr(runs_api, "_query_local", fake_query)
    r = TestClient(app).post("/api/v1/projects/p/runs/started-since", json={"since": 5.5, "asset_keys": ["+orders", "customers+", "*raw/x", ""]})
    assert r.json() == {"run_id": "r1", "status": "STARTED", "supported": True}
    assert seen["mode"] == "latest_run_since"
    assert seen["args"] == {"since": 5.5, "asset_keys": ["orders", "customers", "raw/x"]}


def test_endpoint_reports_unsupported_for_dagster_plus(monkeypatch):
    monkeypatch.setattr(runs_api.project_service, "get_project", lambda pid: SimpleNamespace(id=pid, is_dagster_plus=True))
    r = TestClient(app).post("/api/v1/projects/p/runs/started-since", json={"since": 1})
    assert r.json()["supported"] is False and r.json()["run_id"] is None


def test_endpoint_404s_for_unknown_projects(monkeypatch):
    monkeypatch.setattr(runs_api.project_service, "get_project", lambda pid: None)
    assert TestClient(app).post("/api/v1/projects/nope/runs/started-since", json={"since": 1}).status_code == 404
