"""REST API for Designer drafts.

A draft is an authored `AppManagedComponent`-shaped record targeting a
specific code location, held safely outside the target location's
runtime state until the user promotes it via PR.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import drafts_service
from ..services import promotion_service
from ..services.project_service import project_service


router = APIRouter(prefix="/projects/{project_id}/drafts", tags=["drafts"])


class CreateDraftBody(BaseModel):
    location_name: str
    component_type: str
    attributes: str
    deployment_name: str | None = None
    component_id: str | None = None


class UpdateDraftBody(BaseModel):
    attributes: str | None = None


def _require_project(project_id: str):
    project = project_service.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("")
async def list_endpoint(project_id: str):
    _require_project(project_id)
    return {"drafts": [d.model_dump() for d in drafts_service.list_drafts(project_id)]}


@router.post("")
async def create_endpoint(project_id: str, body: CreateDraftBody):
    _require_project(project_id)
    draft = drafts_service.create_draft(
        project_id=project_id,
        location_name=body.location_name,
        component_type=body.component_type,
        attributes=body.attributes,
        deployment_name=body.deployment_name,
        component_id=body.component_id,
    )
    return draft.model_dump()


@router.patch("/{draft_id}")
async def update_endpoint(project_id: str, draft_id: str, body: UpdateDraftBody):
    _require_project(project_id)
    draft = drafts_service.update_draft(
        project_id=project_id,
        draft_id=draft_id,
        attributes=body.attributes,
    )
    if draft is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    return draft.model_dump()


@router.delete("/{draft_id}")
async def delete_endpoint(project_id: str, draft_id: str):
    _require_project(project_id)
    ok = drafts_service.delete_draft(project_id, draft_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Draft not found")
    return {"ok": True}


@router.get("/{draft_id}/promote-info")
async def promote_info(project_id: str, draft_id: str):
    """Preflight — surface where a promotion would land (repo, base
    branch, target file path). Enables the UI to preview + gate the
    Promote button without executing anything."""
    project = _require_project(project_id)
    draft = drafts_service.get_draft(project_id, draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    org = project.dagster_plus_org or ""
    info = promotion_service.promote_available(org, draft.location_name)
    return {
        "available": info is not None and info.get("has_token"),
        "mapping": info,
        "status": draft.status,
        "promoted_pr_url": draft.promoted_pr_url,
    }


@router.post("/{draft_id}/promote")
async def promote_endpoint(project_id: str, draft_id: str):
    """Land the draft as a PR against the customer's repo. Idempotent
    only in the sense that re-running produces a new branch + new PR —
    we don't reuse in-flight ones. Returns the PR URL."""
    project = _require_project(project_id)
    draft = drafts_service.get_draft(project_id, draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    if not project.is_dagster_plus:
        raise HTTPException(status_code=400, detail="Promotion is only meaningful for Dagster+ drafts.")
    org = project.dagster_plus_org or ""
    token = project.dagster_plus_token or ""
    try:
        result = await promotion_service.promote_draft(project_id, draft, org, token)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result
