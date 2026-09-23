"""REST API for the Designer-managed code location subprocess.

This is the peer-data-source companion to a Dagster+ project: a
laptop-hosted Dagster runtime that Designer scaffolds, boots, and
proxies GraphQL to. The customer's own cloud code locations are
untouched.

Endpoints:
  * GET  /projects/{id}/designer-loc/status  — current lifecycle state
  * POST /projects/{id}/designer-loc/ensure  — idempotent scaffold+boot
  * POST /projects/{id}/designer-loc/stop    — terminate subprocess
  * POST /projects/{id}/designer-loc/graphql — proxy a GraphQL request
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import designer_loc_service as svc
from ..services.project_service import project_service


router = APIRouter(prefix="/projects/{project_id}/designer-loc", tags=["designer-loc"])


class GraphQLBody(BaseModel):
    query: str
    variables: dict | None = None


class ScaffoldComponentBody(BaseModel):
    component_type: str
    attributes_yaml: str
    component_id: str | None = None


def _require_dagster_plus(project_id: str):
    project = project_service.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.is_dagster_plus:
        raise HTTPException(
            status_code=400,
            detail="Designer-managed loc is only available for Dagster+ projects",
        )
    return project


@router.get("/status")
async def status(project_id: str):
    _require_dagster_plus(project_id)
    return svc.get_state(project_id).to_dict()


@router.post("/ensure")
async def ensure(project_id: str):
    _require_dagster_plus(project_id)
    state = await svc.ensure_running(project_id)
    return state.to_dict()


@router.post("/stop")
async def stop_endpoint(project_id: str):
    _require_dagster_plus(project_id)
    svc.stop(project_id)
    return {"ok": True}


@router.post("/graphql")
async def graphql(project_id: str, body: GraphQLBody):
    _require_dagster_plus(project_id)
    try:
        return await svc.proxy_graphql(project_id, body.query, body.variables)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/scaffold-component")
async def scaffold_component(project_id: str, body: ScaffoldComponentBody):
    """Author a new component instance in the sandbox — writes
    `defs.yaml` under `src/<module>/defs/<slug>/` and, if the component
    lives in a package not yet installed, runs `uv add` + restarts."""
    _require_dagster_plus(project_id)
    try:
        return await svc.scaffold_component(
            project_id=project_id,
            component_type=body.component_type,
            attributes_yaml=body.attributes_yaml,
            component_id=body.component_id,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/install-community/{component_id}")
async def install_community(project_id: str, component_id: str):
    """Install a community-templates component (from the manifest,
    fetched from GitHub) into the sandbox via the dagster-component
    CLI. Restarts the sandbox to pick up new Python deps."""
    _require_dagster_plus(project_id)
    try:
        return await svc.install_community_component(project_id, component_id)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/components")
async def list_components(project_id: str):
    """Every authored component instance in the sandbox. Powers the
    "Promote to PR" picker — a component authored here has no path to
    a real deployment until the user explicitly picks a target and
    promotes it (see POST /projects/{id}/drafts + /drafts/{id}/promote)."""
    _require_dagster_plus(project_id)
    return {"components": svc.list_components(project_id)}


class PublishServerlessBody(BaseModel):
    location_name: str | None = None


@router.post("/publish-serverless")
async def publish_serverless(project_id: str, body: PublishServerlessBody):
    """Push the sandbox's current code straight to a Dagster+ Serverless
    deployment — no git, no PR, no review. Explicitly the discouraged
    fast path, for a demo you're going to throw away; anything meant to
    last should go through Promote to PR instead."""
    _require_dagster_plus(project_id)
    try:
        return await svc.publish_serverless(project_id, body.location_name)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
