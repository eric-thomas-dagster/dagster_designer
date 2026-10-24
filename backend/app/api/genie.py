"""Genie planning API — natural-language → asset graph diff."""

from __future__ import annotations

import json
import os
from typing import Any

from dotenv import set_key, unset_key
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..core.config import settings
from ..services.genie_service import (
    _SCOPE_COMPONENT_ID_RESOLVERS,
    DEFAULT_MODEL,
    GenieError,
    fetch_manifest,
    plan,
)
from ..services import dagster_ai_service
from ..services import llm_endpoints
from .assets import get_known_schemas

router = APIRouter(prefix="/ai", tags=["ai"])

# settings.data_dir, NOT a path relative to this file. A path relative to
# this file resolves inside the packaged app's Resources/backend/ (or
# wherever this specific build's source lives) -- fine for a stable dev
# checkout, but `tauri build` regenerates that directory from scratch on
# every rebuild, SILENTLY WIPING any saved API key/workspace ID. Confirmed
# live: a real saved ANTHROPIC_API_KEY + ANTHROPIC_WORKSPACE_ID vanished
# after a routine rebuild+reinstall mid-session, forcing the user to
# re-enter them. data_dir already exists for exactly this reason --
# main.rs's own comment on it: "backend-internal working state... goes
# under Tauri's app-data dir, which survives rebuilds, reinstalls, and app
# updates." Same file main.py loads at startup (see its own comment).
_ENV_PATH = settings.data_dir / ".env"


class AiProvidersStatus(BaseModel):
    openai_available: bool
    anthropic_available: bool
    any_available: bool
    # Whether ANTHROPIC_WORKSPACE_ID is set -- only relevant for Anthropic
    # keys that are org-level rather than scoped to a single workspace (see
    # the anthropic-workspace-id header logic in genie_service.py /
    # dagster_ai_service.py). Most keys don't need this, so it's surfaced
    # as informational status, never required for anthropic_available.
    anthropic_workspace_id_configured: bool = False
    # A local / self-hosted OpenAI-compatible server (Ollama, LM Studio, vLLM, ...). `local_base_url` and `local_model` are
    # echoed back (not secret) so Settings can show what's configured; the optional key never is.
    local_available: bool = False
    local_base_url: str = ""
    local_model: str = ""
    local_api_key_configured: bool = False
    local_prefer: bool = False


def _providers_status() -> AiProvidersStatus:
    openai = bool(os.getenv("OPENAI_API_KEY"))
    anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
    local = llm_endpoints.local_available()
    return AiProvidersStatus(
        openai_available=openai,
        anthropic_available=anthropic,
        any_available=openai or anthropic or local,
        anthropic_workspace_id_configured=bool(os.getenv("ANTHROPIC_WORKSPACE_ID")),
        local_available=local,
        local_base_url=os.getenv("LOCAL_LLM_BASE_URL", "").strip(),
        local_model=llm_endpoints.local_default_model(),
        local_api_key_configured=bool(os.getenv("LOCAL_LLM_API_KEY", "").strip()),
        local_prefer=llm_endpoints.prefers_local(),
    )


@router.get("/providers", response_model=AiProvidersStatus)
async def ai_providers_status() -> AiProvidersStatus:
    """Report which LLM providers have their API keys configured. The
    frontend uses this to hide models the user can't reach and to show
    setup instructions when nothing's configured."""
    return _providers_status()


class SetAiKeysRequest(BaseModel):
    # Omit a field to leave that key untouched; pass an empty string to
    # clear it. Distinguishing "omitted" from "empty" is why these are
    # plain optional strings rather than defaulting to "".
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    # Only needed for an Anthropic key that isn't scoped to a single
    # workspace -- such a key 400s on every request with "This API key is
    # not scoped to a workspace... must include the anthropic-workspace-id
    # header". Find the workspace ID in the Anthropic console under
    # Settings > Workspaces.
    anthropic_workspace_id: str | None = None
    # Local server: a URL (empty clears it), default model, optional key, and "prefer for Dagster AI chat" ("1"/"0").
    local_base_url: str | None = None
    local_model: str | None = None
    local_api_key: str | None = None
    local_prefer: bool | None = None


@router.post("/keys", response_model=AiProvidersStatus)
async def set_ai_keys(request: SetAiKeysRequest) -> AiProvidersStatus:
    """Save API key(s) to backend/.env AND apply them to the running
    process immediately via os.environ, so — unlike the old "edit backend/
    .env and restart the backend" instructions — no restart is needed.
    Every place that reads these keys does so lazily via os.getenv() at
    call time, so this takes effect on the very next AI request."""
    _ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    _ENV_PATH.touch(exist_ok=True)

    for env_var, value in (
        ("OPENAI_API_KEY", request.openai_api_key),
        ("ANTHROPIC_API_KEY", request.anthropic_api_key),
        ("ANTHROPIC_WORKSPACE_ID", request.anthropic_workspace_id),
        ("LOCAL_LLM_BASE_URL", request.local_base_url),
        ("LOCAL_LLM_MODEL", request.local_model),
        ("LOCAL_LLM_API_KEY", request.local_api_key),
        ("LOCAL_LLM_PREFER", None if request.local_prefer is None else ("1" if request.local_prefer else "")),
    ):
        if value is None:
            continue
        value = value.strip()
        if value:
            set_key(str(_ENV_PATH), env_var, value)
            os.environ[env_var] = value
        else:
            unset_key(str(_ENV_PATH), env_var)
            os.environ.pop(env_var, None)

    return await ai_providers_status()


class LocalModelsResponse(BaseModel):
    models: list[str] = []
    error: str | None = None


@router.get("/local/models", response_model=LocalModelsResponse)
async def local_models(base_url: str | None = None) -> LocalModelsResponse:
    """Models the local server reports (OpenAI-compatible `GET /v1/models`; Ollama and LM Studio both serve it), so Settings
    can offer a list instead of making someone type `llama3.1:70b` from memory. `base_url` lets Settings test a URL before saving."""
    import httpx

    base = llm_endpoints.normalize_base_url(base_url) if base_url else llm_endpoints.local_base_url()
    if not base:
        return LocalModelsResponse(error="Enter your local server's URL first.")
    headers = {}
    key = os.getenv("LOCAL_LLM_API_KEY", "").strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{base}/models", headers=headers)
    except httpx.HTTPError as e:
        return LocalModelsResponse(error=f"Couldn't reach {base} ({type(e).__name__}). Is the server running?")
    if r.status_code != 200:
        return LocalModelsResponse(error=f"{base}/models answered {r.status_code}.")
    try:
        ids = sorted({m["id"] for m in (r.json().get("data") or []) if isinstance(m, dict) and m.get("id")})
    except ValueError:
        return LocalModelsResponse(error="The server's model list wasn't valid JSON.")
    return LocalModelsResponse(models=ids)


class DetectedLocalServer(BaseModel):
    name: str
    base_url: str
    models: list[str] = []


class DetectLocalResponse(BaseModel):
    servers: list[DetectedLocalServer] = []


@router.get("/local/detect", response_model=DetectLocalResponse)
async def detect_local() -> DetectLocalResponse:
    """Local model servers already running on this machine (Ollama, LM Studio, ...), so first-run setup can offer them in one click."""
    return DetectLocalResponse(servers=[DetectedLocalServer(**s) for s in await llm_endpoints.detect_local_servers()])


class GeniePlanRequest(BaseModel):
    task: str
    existing_assets: list[dict[str, Any]] | None = None
    model: str | None = None
    previous_plan: list[dict[str, Any]] | None = None
    refinement: str | None = None
    # Optional: when set, the backend fills each existing_asset's `columns`
    # and `dtypes` from the known-schemas cache before planning. Cheaper
    # than the frontend having to fetch schemas per-asset.
    project_id: str | None = None
    # Optional: restricts planning to a fixed, small component-id pool
    # instead of catalog-wide prefiltering -- see plan()'s `scope` param.
    # Currently just "agents_pipelines" (the AI/ML page's scoped "describe
    # your agent" flow).
    scope: str | None = None
    # Real multi-turn conversation: [{role: "user"|"assistant", content},
    # ...], ending in the newest user message. When sent, REPLACES
    # previous_plan/refinement -- see plan()'s `history` param docstring.
    # Optional/backward compatible: a caller that doesn't send this keeps
    # getting the previous_plan/refinement reconstruction unchanged.
    history: list[dict[str, str]] | None = None


class GeniePickResponse(BaseModel):
    component_type: str
    asset_name: str
    upstream_asset_names: list[str]
    config: dict[str, Any]
    reason: str
    action: str = "add"


class GenieClarifyingQuestionResponse(BaseModel):
    question: str
    options: list[str] | None = None


class RequiredResourceResponse(BaseModel):
    component_id: str
    resource_key: str
    reason: str = ""
    needed_by: str = ""
    installed: bool | None = None


class GeniePlanResponse(BaseModel):
    picks: list[GeniePickResponse]
    task: str
    model_used: str
    tokens_prompt: int
    tokens_completion: int
    notes: list[str]
    # None means the plan is complete and ready to apply.
    clarifying_question: GenieClarifyingQuestionResponse | None = None
    # Resources the plan refers to (e.g. the context receipt store); each is installed from the Resources tab.
    # `installed` is only filled when the request carried a project_id.
    requires_resources: list[RequiredResourceResponse] = []


@router.post("/plan", response_model=GeniePlanResponse)
async def genie_plan(req: GeniePlanRequest) -> GeniePlanResponse:
    """Plan a set of asset picks from a natural-language task."""
    # Enrich existing_assets with cached column schemas so the LLM knows
    # what columns are actually available for each already-materialized
    # asset. Only fills in columns/dtypes we've seen from a real preview —
    # nothing invented.
    existing = list(req.existing_assets or [])
    if req.project_id:
        known = get_known_schemas(req.project_id)
        for a in existing:
            name = a.get("name")
            if name and name in known:
                a.setdefault("columns", known[name].get("columns"))
                a.setdefault("dtypes", known[name].get("dtypes"))

    try:
        result = await plan(
            task=req.task,
            existing_assets=existing,
            model=req.model or DEFAULT_MODEL,
            previous_plan=req.previous_plan,
            refinement=req.refinement,
            scope=req.scope,
            history=req.history,
        )
    except GenieError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return GeniePlanResponse(
        picks=[
            GeniePickResponse(
                component_type=p.component_type,
                asset_name=p.asset_name,
                upstream_asset_names=p.upstream_asset_names,
                config=p.config,
                reason=p.reason,
                action=p.action,
            )
            for p in result.picks
        ],
        task=result.task,
        model_used=result.model_used,
        tokens_prompt=result.tokens_prompt,
        tokens_completion=result.tokens_completion,
        notes=result.notes,
        clarifying_question=(
            GenieClarifyingQuestionResponse(
                question=result.clarifying_question.question,
                options=result.clarifying_question.options,
            )
            if result.clarifying_question
            else None
        ),
        requires_resources=[
            RequiredResourceResponse(**r, installed=_resource_installed(req.project_id, r["resource_key"]))
            for r in result.requires_resources
        ],
    )


def _resource_installed(project_id: str | None, resource_key: str) -> bool | None:
    """True/False when we can tell whether the project already has a resource instance with this key, else None."""
    if not project_id:
        return None
    try:
        from app.services.project_service import project_service

        project = project_service.get_project(project_id)
        if project is None:
            return None
        for c in project.components:
            attrs = c.attributes or {}
            if attrs.get("resource_key") == resource_key and "receipt" in (c.component_type or "").lower():
                return True
        return False
    except Exception:
        return None


class BuilderInfo(BaseModel):
    id: str
    count: int


@router.get("/builders", response_model=list[BuilderInfo])
async def genie_builders() -> list[BuilderInfo]:
    """How many manifest components each scoped builder can plan with, so the hub's card counts track the catalog
    instead of a hard-coded number. Empty when the manifest can't be fetched (the UI keeps its static counts)."""
    try:
        manifest = await fetch_manifest()
    except GenieError:
        return []
    components = manifest.get("components") or []
    return [
        BuilderInfo(id=builder, count=len(resolver(components)))
        for builder, resolver in sorted(_SCOPE_COMPONENT_ID_RESOLVERS.items())
    ]


# --- "Ask Dagster AI" panel ---------------------------------------------
#
# Separate from the /plan endpoint above (Genie): that one needs a
# strictly-parseable JSON response to programmatically build the canvas,
# so it stays on its own narrow, tuned prompt. This is free-form Q&A —
# a much more natural fit for routing through the real dagster-expert
# Claude Code skill when it's available, with a direct-API fallback
# otherwise. See dagster_ai_service.py's module docstring for the tiers.

class DagsterAiStatusResponse(BaseModel):
    cli_available: bool
    dagster_expert_installed: bool
    openai_available: bool
    anthropic_available: bool
    reference_docs_available: bool
    local_available: bool = False


@router.get("/dagster-expert/status", response_model=DagsterAiStatusResponse)
async def dagster_expert_status() -> DagsterAiStatusResponse:
    return DagsterAiStatusResponse(**await dagster_ai_service.status())


@router.post("/dagster-expert/install")
async def dagster_expert_install():
    """Best-effort auto-install of the dagster-expert skill into the
    user's own Claude Code setup. Only called when cli_available is
    already true (checked by the frontend from /status first) — this
    doesn't install Claude Code CLI itself, only adds a plugin to an
    already-installed one."""
    try:
        return await dagster_ai_service.ensure_dagster_expert_installed()
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


class DagsterExpertChatRequest(BaseModel):
    question: str
    history: list[dict[str, str]] | None = None


@router.post("/dagster-expert/chat-stream")
async def dagster_expert_chat_stream(req: DagsterExpertChatRequest):
    """Tier 1: streams raw stream-json lines from a headless `claude -p
    "/dagster-expert <question>"` invocation. Newline-delimited JSON,
    not SSE — the frontend reads this with a plain fetch() stream
    reader, not EventSource (which can't send a POST body)."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Empty question")

    async def _gen():
        try:
            async for line in dagster_ai_service.stream_cli_chat(req.question):
                yield line + "\n"
        except RuntimeError as e:
            yield json.dumps({"type": "designer_error", "detail": str(e)}) + "\n"

    return StreamingResponse(_gen(), media_type="application/x-ndjson")


class DagsterExpertFallbackResponse(BaseModel):
    answer: str


@router.post("/dagster-expert/chat-fallback", response_model=DagsterExpertFallbackResponse)
async def dagster_expert_chat_fallback(req: DagsterExpertChatRequest) -> DagsterExpertFallbackResponse:
    """Tier 2: direct API call, no Claude Code involved."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Empty question")
    try:
        answer = await dagster_ai_service.fallback_chat(req.question, req.history)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return DagsterExpertFallbackResponse(answer=answer)
