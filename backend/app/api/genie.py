"""Genie planning API — natural-language → asset graph diff."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.genie_service import (
    DEFAULT_MODEL,
    GenieError,
    plan,
)
from .assets import get_known_schemas

router = APIRouter(prefix="/ai", tags=["ai"])


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
            )
            for p in result.picks
        ],
        task=result.task,
        model_used=result.model_used,
        tokens_prompt=result.tokens_prompt,
        tokens_completion=result.tokens_completion,
        notes=result.notes,
    )
