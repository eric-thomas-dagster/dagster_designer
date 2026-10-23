import pytest

from app.services import llm_endpoints as ep


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in ("LOCAL_LLM_BASE_URL", "LOCAL_LLM_MODEL", "LOCAL_LLM_API_KEY", "LOCAL_LLM_PREFER", "OPENAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)


@pytest.mark.parametrize("raw,expected", [
    ("http://localhost:11434", "http://localhost:11434/v1"),
    ("http://localhost:11434/", "http://localhost:11434/v1"),
    ("http://localhost:1234/v1", "http://localhost:1234/v1"),
    ("http://localhost:1234/v1/", "http://localhost:1234/v1"),
    ("  https://gpu-box.internal:8000  ", "https://gpu-box.internal:8000/v1"),
    ("", ""),
])
def test_base_url_normalization(raw, expected):
    assert ep.normalize_base_url(raw) == expected


def test_only_the_local_prefix_selects_the_local_server():
    assert ep.is_local_model("local:llama3.1") and ep.is_local_model("LOCAL:x") and ep.is_local_model("local:")
    assert not ep.is_local_model("gpt-4o") and not ep.is_local_model("claude-sonnet-4-5") and not ep.is_local_model(None)
    assert not ep.is_local_model("localhost-model")


def test_openai_target_needs_a_key(monkeypatch):
    with pytest.raises(ep.EndpointNotConfigured, match="OPENAI_API_KEY"):
        ep.resolve_chat_target("gpt-4o")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    t = ep.resolve_chat_target("gpt-4o")
    assert (t.url, t.model, t.label, t.is_local) == (ep.OPENAI_URL, "gpt-4o", "OpenAI", False)
    assert t.headers["Authorization"] == "Bearer sk-x"


def test_local_target_uses_the_configured_server_and_model(monkeypatch):
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:11434")
    t = ep.resolve_chat_target("local:llama3.1:70b")  # model names may contain colons
    assert t.url == "http://localhost:11434/v1/chat/completions"
    assert t.model == "llama3.1:70b" and t.is_local and "Authorization" not in t.headers


def test_local_default_model_and_optional_key(monkeypatch):
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:1234/v1")
    monkeypatch.setenv("LOCAL_LLM_MODEL", "qwen2.5")
    monkeypatch.setenv("LOCAL_LLM_API_KEY", "secret")
    t = ep.resolve_chat_target("local:")
    assert t.model == "qwen2.5" and t.headers["Authorization"] == "Bearer secret"


def test_local_target_errors_are_actionable(monkeypatch):
    with pytest.raises(ep.EndpointNotConfigured, match="Settings"):
        ep.resolve_chat_target("local:x")
    monkeypatch.setenv("LOCAL_LLM_BASE_URL", "http://localhost:1234")
    with pytest.raises(ep.EndpointNotConfigured, match="model name"):
        ep.resolve_chat_target("local:")


def test_local_never_falls_back_to_openai(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    with pytest.raises(ep.EndpointNotConfigured):
        ep.resolve_chat_target("local:llama")


def test_json_mode_rejection_detection():
    assert ep.json_mode_rejected(400, "{'error': \"'response_format.type' must be 'json_schema' or 'text'\"}")
    assert not ep.json_mode_rejected(400, "model not found")
    assert not ep.json_mode_rejected(500, "response_format")


def test_prefer_flag(monkeypatch):
    assert ep.prefers_local() is False
    monkeypatch.setenv("LOCAL_LLM_PREFER", "1")
    assert ep.prefers_local() is True
