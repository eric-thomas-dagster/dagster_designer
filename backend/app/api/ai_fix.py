"""Explain or fix a project's validation errors with Claude Code + the
dagster-expert skill (see services/ai_fix_service.py for the safety model)."""
from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..core.uv_binary import env_with_bundled_uv_on_path, project_subprocess_env
from ..services import ai_fix_service as svc
from ..services import dagster_ai_service
from ..services.asset_introspection_service import asset_introspection_service, invalidate_project_caches
from ..services.project_service import project_service

router = APIRouter(tags=["ai-fix"])


class AiFixStatus(BaseModel):
    claude_found: bool
    skill_installed: bool
    can_run: bool
    reason: str | None = None


class AiFixRunRequest(BaseModel):
    mode: svc.Mode
    error_text: str


class ChangedFile(BaseModel):
    path: str
    status: str  # modified | added | deleted
    diff: str


class AiFixResult(BaseModel):
    changes: list[ChangedFile]
    valid: bool
    validation_error: str | None = None


def _local_project(project_id: str):
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=400, detail="AI fix is only available for local projects.")
    project_dir = project_service._get_project_dir(project)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project directory not found")
    return project, project_dir


@router.get("/ai-fix/status", response_model=AiFixStatus)
async def ai_fix_status() -> AiFixStatus:
    st = await dagster_ai_service.status()
    found, installed = st["cli_available"], st["dagster_expert_installed"]
    reason = None
    if not found:
        reason = "Claude Code isn't installed (or isn't on the PATH Designer can see)."
    elif not installed:
        reason = "The dagster-expert skill isn't installed in Claude Code yet."
    return AiFixStatus(claude_found=found, skill_installed=installed, can_run=found and installed, reason=reason)


@router.post("/projects/{project_id}/ai-fix/run")
async def ai_fix_run(project_id: str, req: AiFixRunRequest):
    """Newline-delimited JSON: Designer events ({"type":"designer",...}) wrapped
    around the CLI's own stream-json lines. For mode=fix the first event carries
    the snapshot id needed by /result, /undo and /keep."""
    project, project_dir = _local_project(project_id)
    if not req.error_text.strip():
        raise HTTPException(status_code=400, detail="No validation error text to work from.")
    claude_bin = dagster_ai_service.find_claude_cli()
    if not claude_bin:
        raise HTTPException(status_code=400, detail="Claude Code CLI not found.")
    lock = svc.project_lock(project_id)
    if lock.locked():
        raise HTTPException(status_code=409, detail="An AI fix is already running for this project.")

    # `dg` must resolve to the project's own venv; NOT fast_load -- the agent runs
    # `dg check defs`, which needs the whole component registry.
    env = env_with_bundled_uv_on_path(project_subprocess_env(project_dir))
    env["DAGSTER_HOME"] = str(project_dir / ".designer_dagster_home")
    prompt = svc.build_prompt(
        req.mode, req.error_text, project.name,
        project_service.get_project_root_module(project),
        getattr(project, "component_install_mode", None) or "as_package",
    )

    async def _gen():
        async with lock:
            snapshot_id = None
            if req.mode == "fix":
                snapshot_id = svc.create_snapshot(project_id, project_dir)
            yield json.dumps({"type": "designer", "event": "started", "mode": req.mode, "snapshot_id": snapshot_id}) + "\n"
            try:
                async for line in svc.stream_task(claude_bin, project_dir, req.mode, prompt, env):
                    yield line + "\n"
            except Exception as e:  # surface instead of a silently truncated stream
                yield json.dumps({"type": "designer_error", "detail": str(e)}) + "\n"

    return StreamingResponse(_gen(), media_type="application/x-ndjson")


def _snapshot_or_404(project_id: str, snapshot_id: str) -> None:
    try:
        svc._snapshot_dir(project_id, snapshot_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/projects/{project_id}/ai-fix/{snapshot_id}/result", response_model=AiFixResult)
async def ai_fix_result(project_id: str, snapshot_id: str) -> AiFixResult:
    """What the fix changed, plus a fresh validation of the result."""
    project, project_dir = _local_project(project_id)
    _snapshot_or_404(project_id, snapshot_id)
    changes = svc.diff_snapshot(project_id, project_dir, snapshot_id)
    invalidate_project_caches(project_id)
    ok, error = await asset_introspection_service.validate_project_defs_async(project)
    return AiFixResult(changes=[ChangedFile(**c) for c in changes], valid=bool(ok), validation_error=error)


@router.post("/projects/{project_id}/ai-fix/{snapshot_id}/undo")
async def ai_fix_undo(project_id: str, snapshot_id: str):
    project, project_dir = _local_project(project_id)
    _snapshot_or_404(project_id, snapshot_id)
    touched = svc.restore_snapshot(project_id, project_dir, snapshot_id)
    invalidate_project_caches(project_id)
    return {"restored": touched}


@router.post("/projects/{project_id}/ai-fix/{snapshot_id}/keep")
async def ai_fix_keep(project_id: str, snapshot_id: str):
    """Accept the changes: refresh the project's graph from the fixed code, then
    drop the snapshot."""
    project, project_dir = _local_project(project_id)
    _snapshot_or_404(project_id, snapshot_id)
    svc.discard_snapshot(project_id, snapshot_id)
    invalidate_project_caches(project_id)
    return {"kept": True}
