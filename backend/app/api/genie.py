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
    try:
        result = await plan(
            task=req.task,
            existing_assets=req.existing_assets or [],
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
