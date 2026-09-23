"""Genie planning API — natural-language → asset graph diff."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from dotenv import set_key, unset_key
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..services.genie_service import (
    DEFAULT_MODEL,
    GenieError,
    plan,
)
from ..services import dagster_ai_service
from .assets import get_known_schemas

router = APIRouter(prefix="/ai", tags=["ai"])

# backend/.env -- same file main.py loads at startup and the same one the
# "needs an API key" banner has always told users to hand-edit.
_ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"


class AiProvidersStatus(BaseModel):
    openai_available: bool
    anthropic_available: bool
    any_available: bool


@router.get("/providers", response_model=AiProvidersStatus)
async def ai_providers_status() -> AiProvidersStatus:
    """Report which LLM providers have their API keys configured. The
    frontend uses this to hide models the user can't reach and to show
    setup instructions when nothing's configured."""
    openai = bool(os.getenv("OPENAI_API_KEY"))
    anthropic = bool(os.getenv("ANTHROPIC_API_KEY"))
    return AiProvidersStatus(
        openai_available=openai,
        anthropic_available=anthropic,
        any_available=openai or anthropic,
    )


class SetAiKeysRequest(BaseModel):
    # Omit a field to leave that key untouched; pass an empty string to
    # clear it. Distinguishing "omitted" from "empty" is why these are
    # plain optional strings rather than defaulting to "".
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None


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


class GeniePickResponse(BaseModel):
    component_type: str
    asset_name: str
    upstream_asset_names: list[str]
    config: dict[str, Any]
    reason: str
    action: str = "add"


class GeniePlanResponse(BaseModel):
    picks: list[GeniePickResponse]
    task: str
    model_used: str
    tokens_prompt: int
    tokens_completion: int
    notes: list[str]


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
    )


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
