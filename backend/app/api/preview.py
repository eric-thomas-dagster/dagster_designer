"""Preview API — foundation for M6 (git-backed preview runtime).

For now this exposes a single `prepare` endpoint that exercises the
git service end-to-end so we can validate clone + worktree + draft
application before wiring it to the sandbox lifecycle (M6.2) and the
frontend button (M6.3).
"""
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel

from ..services import dagster_plus_preview_service
from ..services import drafts_service
from ..services import preview_git_service
from ..services import preview_runtime_service
from ..services import promotion_config
from ..services.project_service import project_service


router = APIRouter(prefix="/projects/{project_id}/preview", tags=["preview"])


class PreparePreviewBody(BaseModel):
    deployment_name: str
    location_name: str
    base_branch: str | None = None


class BootPreviewBody(BaseModel):
    deployment_name: str
    location_name: str


class PreviewGraphQLBody(BaseModel):
    deployment_name: str
    query: str
    variables: dict | None = None


class BootRemotePreviewBody(BaseModel):
    """Boot a Dagster+ Branch Deployment as the preview surface.

    Unlike `boot` (laptop `dagster dev`), this doesn't clone the
    customer repo — it asks Dagster+ to reuse the base deployment's
    container image and applies drafts via setAppManagedComponent."""
    # The base deployment to fork from — typically the deployment that
    # has the app-managed types registered (christian's branch today,
    # `data-eng-prod` once merged).
    base_deployment: str
    location_name: str


def _require_dagster_plus(project_id: str):
    project = project_service.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.is_dagster_plus:
        raise HTTPException(status_code=400, detail="Preview is only meaningful for Dagster+ projects.")
    return project


@router.post("/prepare")
async def prepare(project_id: str, body: PreparePreviewBody):
    """Clone + worktree + apply drafts. Returns the worktree path so
    M6.2's sandbox launcher can boot `dagster dev` on it next."""
    project = _require_dagster_plus(project_id)

    mapping = promotion_config.find_mapping(project.dagster_plus_org or "", body.location_name)
    if mapping is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"No repo mapping for ({project.dagster_plus_org}, {body.location_name}). "
                "Configure it in the Drafts drawer settings."
            ),
        )

    # Filter to drafts targeting THIS deployment+location. Other drafts
    # exist but aren't relevant to this preview.
    all_drafts = drafts_service.list_drafts(project_id)
    scoped = [
        d for d in all_drafts
        if d.location_name == body.location_name and d.deployment_name == body.deployment_name
    ]

    base_branch = body.base_branch or mapping.default_branch
    try:
        result = preview_git_service.prepare_preview(
            project_id=project_id,
            owner_repo=mapping.owner_repo,
            base_branch=base_branch,
            deployment_name=body.deployment_name,
            defs_subdir=mapping.defs_subdir,
            drafts=scoped,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        **result,
        "mapping": {
            "owner_repo": mapping.owner_repo,
            "defs_subdir": mapping.defs_subdir,
        },
        "drafts_in_scope": len(scoped),
    }


@router.delete("/session/{deployment_name}")
async def teardown(project_id: str, deployment_name: str, location: str):
    """Remove the worktree for a preview session. Frees disk and
    forces a clean slate on the next `prepare`."""
    project = _require_dagster_plus(project_id)
    mapping = promotion_config.find_mapping(project.dagster_plus_org or "", location)
    if mapping is None:
        raise HTTPException(status_code=400, detail="No repo mapping configured.")
    # Also stop any running preview subprocess for this session.
    preview_runtime_service.stop_preview(project_id, deployment_name)
    preview_git_service.remove_worktree(
        project_id=project_id,
        owner_repo=mapping.owner_repo,
        base_branch=mapping.default_branch,
        deployment_name=deployment_name,
    )
    return {"ok": True}


@router.post("/boot")
async def boot(project_id: str, body: BootPreviewBody):
    """Prepare + install + start `dagster dev` on the worktree.

    Idempotent — if the preview is already running, re-applies the
    current draft set to the worktree (so hot-reload picks it up)
    and returns the existing state."""
    _require_dagster_plus(project_id)
    try:
        state = await preview_runtime_service.boot_preview(
            project_id, body.deployment_name, body.location_name,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return state.to_dict()


@router.post("/stop")
async def stop(project_id: str, body: BootPreviewBody):
    """Terminate a preview subprocess. Worktree stays on disk."""
    _require_dagster_plus(project_id)
    preview_runtime_service.stop_preview(project_id, body.deployment_name)
    return {"ok": True}


@router.get("/status")
async def status(project_id: str):
    """List all live/tracked previews for this project.

    Empty list if nothing is running. Useful for a global "previews I
    have going" surface in the UI."""
    _require_dagster_plus(project_id)
    return {"previews": preview_runtime_service.list_previews(project_id)}


@router.post("/graphql")
async def graphql(project_id: str, body: PreviewGraphQLBody):
    """Proxy a GraphQL request to a specific preview subprocess.

    Same shape as `/designer-loc/graphql` but scoped by deployment."""
    _require_dagster_plus(project_id)
    try:
        return await preview_runtime_service.proxy_graphql(
            project_id, body.deployment_name, body.query, body.variables,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/prewarm-remote")
async def prewarm_remote(project_id: str, body: BootRemotePreviewBody, background_tasks: BackgroundTasks):
    """Fire-and-forget: create the BD in the background so a later
    Cloud click completes in ~1s (BD already up + just applies drafts).

    Returns immediately with `{status: "scheduled"}` — actual BD
    creation runs after the response. No-op if the target is a branch
    deployment (fast path handles those in ~1s anyway)."""
    project = _require_dagster_plus(project_id)

    async def _run():
        try:
            await dagster_plus_preview_service.prewarm_remote_preview(
                project, body.base_deployment, body.location_name,
            )
        except Exception as e:
            # Background task — surface via server log; frontend never sees it.
            print(f"[preview] prewarm failed for ({body.base_deployment}, {body.location_name}): {e}")

    background_tasks.add_task(_run)
    return {"status": "scheduled"}


@router.post("/boot-remote")
async def boot_remote(project_id: str, body: BootRemotePreviewBody):
    """Spin up (or reuse) a Dagster+ Branch Deployment as the preview
    surface — no laptop `dagster dev`, no docker, no registry auth.
    Reuses the base deployment's image via `addLocation`, applies
    drafts via `setAppManagedComponent`, and returns a link to the BD
    in Dagster+."""
    project = _require_dagster_plus(project_id)
    all_drafts = drafts_service.list_drafts(project_id)
    scoped = [
        d for d in all_drafts
        if d.location_name == body.location_name
        and d.deployment_name == body.base_deployment
    ]
    try:
        return await dagster_plus_preview_service.boot_remote_preview(
            project,
            base_deployment=body.base_deployment,
            location_name=body.location_name,
            drafts=scoped,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/remote-session")
async def teardown_remote(project_id: str, base_deployment: str, location: str):
    """Delete a remote preview BD (Dagster+ side) + drop from the
    in-memory registry."""
    project = _require_dagster_plus(project_id)
    await dagster_plus_preview_service.teardown_remote_preview(
        project, base_deployment, location,
    )
    return {"ok": True}


@router.get("/remote-status")
async def remote_status(project_id: str):
    """List active remote (BD-backed) previews for this project."""
    project = _require_dagster_plus(project_id)
    return {"remote_previews": dagster_plus_preview_service.list_remote_previews(project)}
