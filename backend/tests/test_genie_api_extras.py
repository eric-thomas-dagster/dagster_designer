"""/ai/builders and the requires_resources field on /ai/plan."""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import genie as genie_api
from app.services.genie_service import GenieError, GeniePick, GeniePlan


def _client():
    app = FastAPI()
    app.include_router(genie_api.router, prefix="/api")
    return TestClient(app)


def test_builders_counts_come_from_the_manifest(monkeypatch):
    async def manifest():
        return {"components": [
            {"id": "agentic_pipeline", "category": "ai", "tags": []},
            {"id": "context_engineering_pipeline", "category": "ai", "tags": []},
            {"id": "rag_pipeline", "category": "ai", "tags": ["rag"]},
        ]}

    monkeypatch.setattr(genie_api, "fetch_manifest", manifest)
    body = {b["id"]: b["count"] for b in _client().get("/api/ai/builders").json()}
    assert body == {"agents_pipelines": 3, "rag": 2}


def test_builders_is_empty_when_the_manifest_is_unreachable(monkeypatch):
    async def manifest():
        raise GenieError("offline")

    monkeypatch.setattr(genie_api, "fetch_manifest", manifest)
    assert _client().get("/api/ai/builders").json() == []


def test_plan_response_carries_required_resources_with_installed_state(monkeypatch):
    pick = GeniePick(component_type="rag_pipeline", asset_name="qa", upstream_asset_names=[], config={}, reason="r")

    async def fake_plan(**kwargs):
        return GeniePlan(
            picks=[pick], task="t", model_used="m", tokens_prompt=1, tokens_completion=1, notes=[],
            requires_resources=[
                {"component_id": "context_receipt_store", "resource_key": "have", "reason": "x", "needed_by": "qa"},
                {"component_id": "context_receipt_store", "resource_key": "missing", "reason": "x", "needed_by": "qa"},
            ],
        )

    store = SimpleNamespace(component_type="p.components.context_receipt_store.component.ContextReceiptStoreComponent", attributes={"resource_key": "have"})
    project = SimpleNamespace(components=[store])
    import app.services.project_service as ps

    monkeypatch.setattr(genie_api, "plan", fake_plan)
    monkeypatch.setattr(ps, "project_service", SimpleNamespace(get_project=lambda pid: project))
    res = _client().post("/api/ai/plan", json={"task": "t", "project_id": "p1"}).json()
    assert [(r["resource_key"], r["installed"]) for r in res["requires_resources"]] == [("have", True), ("missing", False)]


def test_installed_is_unknown_without_a_project(monkeypatch):
    async def fake_plan(**kwargs):
        return GeniePlan(picks=[], task="t", model_used="m", tokens_prompt=0, tokens_completion=0, notes=[],
                         requires_resources=[{"component_id": "context_receipt_store", "resource_key": "k", "reason": "", "needed_by": "a"}])

    monkeypatch.setattr(genie_api, "plan", fake_plan)
    res = _client().post("/api/ai/plan", json={"task": "t"}).json()
    assert res["requires_resources"][0]["installed"] is None
