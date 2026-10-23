"""Where an OpenAI-style chat request goes: OpenAI itself, or a local / self-hosted OpenAI-compatible server.

Ollama, LM Studio, vLLM and llama.cpp all serve `/v1/chat/completions`, so supporting them is a base URL, an optional key and a
model name -- not a new protocol. A model id of the form ``local:<name>`` (what the UI's model picker sends for the local entry)
selects the local server; ``local:`` alone means "the default model from Settings". Anything else keeps meaning OpenAI.

Configuration lives in env vars (set from Settings -> AI Providers, same as the hosted keys, applied without a restart):
  LOCAL_LLM_BASE_URL   e.g. http://localhost:11434 (Ollama) or http://localhost:1234/v1 (LM Studio); "/v1" is added if missing
  LOCAL_LLM_MODEL      default model name when the request names none
  LOCAL_LLM_API_KEY    optional; most local servers ignore it
  LOCAL_LLM_PREFER     "1" = Dagster AI chat uses the local model even when a hosted key is also set
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

LOCAL_PREFIX = "local:"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"


def is_local_model(model: str | None) -> bool:
    return bool(model) and model.lower().startswith(LOCAL_PREFIX)


def normalize_base_url(raw: str) -> str:
    """`http://localhost:11434` -> `http://localhost:11434/v1`; an explicit `/v1` (or `/v2`...) is left alone."""
    base = (raw or "").strip().rstrip("/")
    if not base:
        return ""
    if not re.search(r"/v\d+$", base):
        base += "/v1"
    return base


def local_base_url() -> str:
    return normalize_base_url(os.getenv("LOCAL_LLM_BASE_URL", ""))


def local_available() -> bool:
    return bool(local_base_url())


def local_default_model() -> str:
    return os.getenv("LOCAL_LLM_MODEL", "").strip()


def prefers_local() -> bool:
    return os.getenv("LOCAL_LLM_PREFER", "").strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class ChatTarget:
    url: str
    headers: dict[str, str]
    model: str
    label: str
    is_local: bool


class EndpointNotConfigured(RuntimeError):
    pass


def resolve_chat_target(model: str) -> ChatTarget:
    """The URL/headers/model name for an OpenAI-style request. Raises EndpointNotConfigured with a user-facing message."""
    if is_local_model(model):
        base = local_base_url()
        if not base:
            raise EndpointNotConfigured("No local model server is configured. Add its URL in Settings -> AI Providers, then try again.")
        name = model[len(LOCAL_PREFIX):].strip() or local_default_model()
        if not name:
            raise EndpointNotConfigured("Pick a model name for your local server in Settings -> AI Providers (e.g. llama3.1:70b).")
        headers = {"Content-Type": "application/json"}
        key = os.getenv("LOCAL_LLM_API_KEY", "").strip()
        if key:
            headers["Authorization"] = f"Bearer {key}"
        return ChatTarget(f"{base}/chat/completions", headers, name, "Your local model", True)
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise EndpointNotConfigured("OPENAI_API_KEY is not set on the backend. Set it in Settings -> AI Providers, then try again.")
    return ChatTarget(OPENAI_URL, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, model, "OpenAI", False)


def json_mode_rejected(status_code: int, body: str) -> bool:
    """True when a server refused `response_format: json_object` (LM Studio, some llama.cpp builds), so the caller can retry
    without it and rely on the prompt's own "respond with ONLY JSON" instruction."""
    return status_code == 400 and "response_format" in body.lower()


def unreachable_message(target: ChatTarget, error: Exception) -> str:
    return (
        f"Couldn't reach your local model server at {target.url.rsplit('/chat/completions', 1)[0]} ({type(error).__name__}). "
        "Is Ollama / LM Studio running, and is the URL right in Settings -> AI Providers?"
    )
