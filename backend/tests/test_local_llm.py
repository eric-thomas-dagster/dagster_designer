"""Local (OpenAI-compatible) model support: Settings API, model discovery, and the planner / Dagster AI call paths."""

import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import genie as genie_api
from app.services import dagster_ai_service as dai
from app.services import genie_service as g
from app.services import llm_endpoints as ep

LOCAL_ENV = ("LOCAL_LLM_BASE_URL", "LOCAL_LLM_MODEL", "LOCAL_LLM_API_KEY", "LOCAL_LLM_PREFER")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    for k in (*LOCAL_ENV, "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(genie_api, "_ENV_PATH", tmp_path / ".env")


def _client():
    app = FastAPI()
    app.include_router(genie_api.router, prefix="/api")
    return TestClient(app)


def _mock_httpx(monkeypatch, handler):
    """Route every httpx.AsyncClient the code under test creates through `handler` (all modules share the one httpx module)."""
    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: real(*a, transport=transport, **{k_: v for k_, v in k.items() if k_ != "transport"}))


# --- Settings API -----------------------------------------------------------------------------------------------------

def test_status_reports_local_and_counts_it_as_an_available_provider(monkeypatch):
    c = _client()
    assert c.get("/api/ai/providers").json()["any_available"] is False
    res = c.post("/api/ai/keys", json={"local_base_url": "http://localhost:11434", "local_model": "llama3.1", "local_prefer": True}).json()
    assert res["local_available"] and res["any_available"] and res["local_prefer"]
    assert res["local_base_url"] == "http://localhost:11434" and res["local_model"] == "llama3.1"
    assert res["openai_available"] is False and res["local_api_key_configured"] is False


def test_the_local_key_is_never_echoed_and_empty_values_clear(monkeypatch):
    c = _client()
    c.post("/api/ai/keys", json={"local_base_url": "http://x:1", "local_api_key": "secret", "local_model": "m"})
    body = c.get("/api/ai/providers").json()
    assert body["local_api_key_configured"] is True and "secret" not in str(body)
    cleared = c.post("/api/ai/keys", json={"local_base_url": "", "local_api_key": "", "local_prefer": False}).json()
    assert cleared["local_available"] is False and cleared["local_api_key_configured"] is False and cleared["local_prefer"] is False
    assert cleared["local_model"] == "m"  # omitted fields are left alone


def test_settings_are_persisted_to_the_env_file(monkeypatch, tmp_path):
    _client().post("/api/ai/keys", json={"local_base_url": "http://x:1", "local_model": "m"})
    text = (tmp_path / ".env").read_text()
    assert "LOCAL_LLM_BASE_URL" in text and "LOCAL_LLM_MODEL" in text


# --- model discovery ----------------------------------------------------------------------------------------------------

def test_model_discovery_lists_ids_and_normalizes_the_url(monkeypatch):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(200, json={"data": [{"id": "qwen2.5"}, {"id": "llama3.1:70b"}, {"id": "qwen2.5"}]})

    _mock_httpx(monkeypatch, handler)
    body = _client().get("/api/ai/local/models", params={"base_url": "http://localhost:11434"}).json()
    assert body == {"models": ["llama3.1:70b", "qwen2.5"], "error": None}
    assert seen == ["http://localhost:11434/v1/models"]


def test_model_discovery_errors_are_messages_not_500s(monkeypatch):
    c = _client()
    assert "URL" in c.get("/api/ai/local/models").json()["error"]

    def boom(request):
        raise httpx.ConnectError("refused")

    _mock_httpx(monkeypatch, boom)
    assert "Couldn't reach" in c.get("/api/ai/local/models", params={"base_url": "http://nowhere:1"}).json()["error"]


# --- planner call path ------------------------------------------------------------------------------------------------

def _chat_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _local_target(monkeypatch):
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
    return ep.resolve_chat_target("local:llama3.1")


def test_local_request_goes_to_the_local_server_with_the_local_model_name(monkeypatch):
    target = _local_target(monkeypatch)
    sent = {}

    def handler(request):
        sent["url"], sent["body"] = str(request.url), request.read().decode()
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    async def go():
        async with _chat_client(handler) as client:
            return await g._post_chat_completions(client, target, {"messages": [], "response_format": {"type": "json_object"}})

    assert asyncio.run(go()).status_code == 200
    assert sent["url"] == "http://localhost:11434/v1/chat/completions"
    assert '"model":"llama3.1"' in sent["body"].replace(" ", "")


def test_json_mode_is_dropped_and_retried_when_a_local_server_refuses_it(monkeypatch):
    target = _local_target(monkeypatch)
    bodies = []

    def handler(request):
        body = request.read().decode()
        bodies.append(body)
        if "response_format" in body:
            return httpx.Response(400, json={"error": {"message": "'response_format.type' must be 'json_schema' or 'text'"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    async def go():
        async with _chat_client(handler) as client:
            return await g._post_chat_completions(client, target, {"messages": [], "response_format": {"type": "json_object"}})

    assert asyncio.run(go()).status_code == 200
    assert len(bodies) == 2 and "response_format" not in bodies[1]


def test_json_mode_refusal_is_not_retried_for_openai(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    target = ep.resolve_chat_target("gpt-4o")
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(400, json={"error": {"message": "response_format is bad"}})

    async def go():
        async with _chat_client(handler) as client:
            return await g._post_chat_completions(client, target, {"messages": [], "response_format": {"type": "json_object"}})

    assert asyncio.run(go()).status_code == 400 and len(calls) == 1


def test_an_unreachable_local_server_is_a_clear_error(monkeypatch):
    target = _local_target(monkeypatch)

    def handler(request):
        raise httpx.ConnectError("refused")

    async def go():
        async with _chat_client(handler) as client:
            await g._post_chat_completions(client, target, {"messages": []})

    with pytest.raises(g.GenieError, match="local model server"):
        asyncio.run(go())


def test_plan_fails_fast_with_a_settings_hint_when_no_local_server_is_configured():
    with pytest.raises(g.GenieError, match="Settings"):
        asyncio.run(g.plan(task="anything", model="local:llama3.1"))


# --- Dagster AI chat ----------------------------------------------------------------------------------------------------

def _chat(monkeypatch, handler):
    _mock_httpx(monkeypatch, handler)
    return asyncio.run(dai.fallback_chat("what is an asset?", None))


def _ok(request):
    return httpx.Response(200, json={"choices": [{"message": {"content": "an answer"}}]})


def test_dagster_ai_uses_local_when_it_is_the_only_provider(monkeypatch):
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
    monkeypatch.setenv("LOCAL_LLM_MODEL", "llama3.1")
    urls = []
    assert _chat(monkeypatch, lambda r: (urls.append(str(r.url)), _ok(r))[1]) == "an answer"
    assert urls == ["http://localhost:11434/v1/chat/completions"]


def test_a_hosted_key_wins_unless_local_is_preferred(monkeypatch):
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
    monkeypatch.setenv("LOCAL_LLM_MODEL", "llama3.1")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    urls = []
    _chat(monkeypatch, lambda r: (urls.append(str(r.url)), _ok(r))[1])
    assert urls == ["https://api.openai.com/v1/chat/completions"]
    monkeypatch.setenv("LOCAL_LLM_PREFER", "1")
    urls.clear()
    _chat(monkeypatch, lambda r: (urls.append(str(r.url)), _ok(r))[1])
    assert urls == ["http://localhost:11434/v1/chat/completions"]


def test_dagster_ai_says_so_when_nothing_is_configured_or_local_is_down(monkeypatch):
    with pytest.raises(RuntimeError, match="local model"):
        asyncio.run(dai.fallback_chat("q", None))
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
    monkeypatch.setenv("LOCAL_LLM_MODEL", "m")

    def boom(request):
        raise httpx.ConnectError("refused")

    _mock_httpx(monkeypatch, boom)
    with pytest.raises(RuntimeError, match="Couldn't reach"):
        asyncio.run(dai.fallback_chat("q", None))
