"""Knowledge-base health for the designer: what the context receipt store says about the knowledge bases in a project."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from ..services import receipt_health_service as health
from ..services.project_service import project_service

router = APIRouter(prefix="/projects/{project_id}/knowledge-base", tags=["knowledge-base"])


def _store_components(project: Any) -> list[Any]:
    return [c for c in project.components if "contextreceiptstore" in (c.component_type or "").lower().replace("_", "")]


def _resolve_db_path(project: Any, attrs: dict[str, Any]) -> Path:
    raw = str(attrs.get("database_path") or "./var/context-receipts.sqlite3")
    path = Path(raw).expanduser()
    return path if path.is_absolute() else project_service._get_project_dir(project) / path


@router.get("/health")
async def knowledge_base_health(project_id: str, asset: str | None = None, days: int = 30) -> dict[str, Any]:
    """Per-knowledge-base usage and quality from the project's receipt store.

    Without ``asset``, reports every knowledge base the store has retrievals for. ``stores`` explains what was (not) found
    so the UI can say "install the receipt store" or "nothing recorded yet" instead of showing an empty panel.
    """
    project = project_service.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    stores = _store_components(project)
    if not stores:
        return {"status": "no_store", "knowledge_bases": [], "detail": "No context receipt store is installed in this project."}
    attrs = stores[0].attributes or {}
    if str(attrs.get("backend") or "sqlite").lower() != "sqlite":
        return {"status": "unsupported_backend", "knowledge_bases": [], "detail": f"Health is read from SQLite stores; this one uses {attrs.get('backend')}."}
    path = _resolve_db_path(project, attrs)
    try:
        assets = [asset] if asset else health.list_assets(path)
        reports = [health.asset_health(path, a, days=max(1, days)) for a in assets]
    except health.ReceiptStoreUnavailable as e:
        return {"status": "empty", "knowledge_bases": [], "detail": str(e)}
    return {"status": "ok" if reports else "empty", "database_path": str(path), "knowledge_bases": reports,
            "detail": "" if reports else "The store has no retrievals recorded yet."}
