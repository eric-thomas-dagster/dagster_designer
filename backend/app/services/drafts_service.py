"""Draft store — persistence for AppManagedComponent-shaped records
authored in Designer against a target code location (customer's cloud
loc or the sandbox), pending promotion via PR.

Storage: `~/.dagster-designer/drafts/<project_id>.json`, one JSON file
per Designer project holding an array of drafts.

This is the piece that gives Designer its "safe scratch" story:
Dagster+'s live `setAppManagedComponent` is replaced with a draft that
lives outside the code location's mutable state, git is the source of
truth, and promotion happens explicitly via PR (M4).
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


DRAFTS_ROOT = Path.home() / ".dagster-designer" / "drafts"
DRAFTS_ROOT.mkdir(parents=True, exist_ok=True)


DraftStatus = Literal["draft", "promoted"]


class Draft(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    project_id: str
    # Target code location the draft is authored against. For Dagster+
    # customer locs this is the loc's real name (e.g. `data-eng-pipeline`);
    # for the Designer sandbox this is the sentinel `__sandbox__`.
    location_name: str
    # Which Dagster+ deployment the location lives in — long-lived
    # (`prod`, `data-eng-staging`, …) or branch (commit-hash-named).
    # None for legacy drafts + sandbox drafts.
    deployment_name: str | None = None
    component_type: str          # fully qualified Python class path
    component_id: str            # slot key, e.g. `ScheduledJobComponent[2]`
    attributes: str              # YAML string (matches Dagster+'s shape)
    status: DraftStatus = "draft"
    # PR link once promoted (M4).
    promoted_pr_url: str | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


def _path(project_id: str) -> Path:
    return DRAFTS_ROOT / f"{project_id}.json"


def _read(project_id: str) -> list[Draft]:
    p = _path(project_id)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text())
    except Exception:
        return []
    return [Draft(**d) for d in raw]


def _write(project_id: str, drafts: list[Draft]) -> None:
    _path(project_id).write_text(json.dumps([d.model_dump() for d in drafts], indent=2))


def list_drafts(project_id: str) -> list[Draft]:
    return _read(project_id)


def get_draft(project_id: str, draft_id: str) -> Draft | None:
    return next((d for d in _read(project_id) if d.id == draft_id), None)


def create_draft(
    project_id: str,
    location_name: str,
    component_type: str,
    attributes: str,
    deployment_name: str | None = None,
    component_id: str | None = None,
) -> Draft:
    drafts = _read(project_id)
    # Auto-generate `<TypeShortName>[<n>]` slot when not provided,
    # matching Dagster+'s `SetAppManagedComponentMutation` variable
    # shape. `n` = next unused index for this (deployment, location, type).
    if not component_id:
        short = component_type.rsplit(".", 1)[-1]
        used = {
            int(d.component_id[len(short) + 1:-1])
            for d in drafts
            if d.location_name == location_name
            and d.deployment_name == deployment_name
            and d.component_type == component_type
            and d.component_id.startswith(f"{short}[")
            and d.component_id.endswith("]")
            and d.component_id[len(short) + 1:-1].isdigit()
        }
        n = 0
        while n in used:
            n += 1
        component_id = f"{short}[{n}]"

    draft = Draft(
        project_id=project_id,
        location_name=location_name,
        deployment_name=deployment_name,
        component_type=component_type,
        component_id=component_id,
        attributes=attributes,
    )
    drafts.append(draft)
    _write(project_id, drafts)
    return draft


def update_draft(
    project_id: str,
    draft_id: str,
    attributes: str | None = None,
    status: DraftStatus | None = None,
    promoted_pr_url: str | None = None,
) -> Draft | None:
    drafts = _read(project_id)
    for i, d in enumerate(drafts):
        if d.id == draft_id:
            if attributes is not None:
                d.attributes = attributes
            if status is not None:
                d.status = status
            if promoted_pr_url is not None:
                d.promoted_pr_url = promoted_pr_url
            d.updated_at = time.time()
            drafts[i] = d
            _write(project_id, drafts)
            return d
    return None


def delete_draft(project_id: str, draft_id: str) -> bool:
    drafts = _read(project_id)
    remaining = [d for d in drafts if d.id != draft_id]
    if len(remaining) == len(drafts):
        return False
    _write(project_id, remaining)
    return True
