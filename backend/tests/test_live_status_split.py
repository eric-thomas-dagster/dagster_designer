import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api import projects as P
from app.main import app


def _project():
    nodes = [
        SimpleNamespace(node_kind="asset", id="a", data={"asset_key": "a"}),
        SimpleNamespace(node_kind="asset", id="b", data={"asset_key": "b"}),
        SimpleNamespace(node_kind="component", id="c", data={}),
    ]
    return SimpleNamespace(id="p", is_dagster_plus=False, graph=SimpleNamespace(nodes=nodes))


def test_live_status_endpoint_returns_only_assets_with_status(monkeypatch):
    proj = _project()
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: proj)

    async def stale(p):
        p.graph.nodes[0].data["stale_status"] = "STALE"

    async def last_run(p):
        p.graph.nodes[0].data["last_run_status"] = "SUCCESS"
        p.graph.nodes[1].data["last_run_status"] = "FAILURE"

    monkeypatch.setattr(P, "_merge_local_asset_status", stale)
    monkeypatch.setattr(P, "_merge_local_last_run_status", last_run)
    r = TestClient(app).get("/api/v1/projects/p/asset-live-status").json()
    assert r["statuses"] == {"a": {"stale_status": "STALE", "last_run_status": "SUCCESS"}, "b": {"last_run_status": "FAILURE"}}


def test_live_status_survives_one_source_failing(monkeypatch):
    proj = _project()
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: proj)

    async def boom(p):
        raise RuntimeError("dg dev down")

    async def last_run(p):
        p.graph.nodes[0].data["last_run_status"] = "SUCCESS"

    monkeypatch.setattr(P, "_merge_local_asset_status", boom)
    monkeypatch.setattr(P, "_merge_local_last_run_status", last_run)
    assert TestClient(app).get("/api/v1/projects/p/asset-live-status").json()["statuses"] == {"a": {"last_run_status": "SUCCESS"}}


def test_get_project_without_live_skips_live_lookups(monkeypatch):
    proj = _project()
    proj.name = "x"
    called = []
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: proj)

    async def spy(p):
        called.append(1)

    monkeypatch.setattr(P, "_merge_local_asset_status", spy)
    monkeypatch.setattr(P, "_merge_local_last_run_status", spy)
    try:
        asyncio.run(P.get_project("p", live=False))
    except Exception:
        pass  # the stand-in project isn't a full model; only the skipped lookups matter here
    assert called == []
