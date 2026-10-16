"""Small app-level (not per-project) settings, persisted as JSON in the data
dir so they survive app rebuilds/updates the same way the saved API keys do.
"""
import json
from typing import Any

from .config import settings

_PATH = settings.data_dir / "app_settings.json"

DEFAULTS: dict[str, Any] = {
    # Skip building the "library JSON" (a schema for every component type in
    # dagster-community-components) in Designer's own local `dg` subprocesses.
    # ~2x faster definitions loads; never applied to deployed code locations.
    "fast_local_loading": True,
}


def load() -> dict[str, Any]:
    try:
        stored = json.loads(_PATH.read_text())
    except (OSError, ValueError):
        stored = {}
    # Only known keys, so a stale/hand-edited file can't inject arbitrary ones.
    return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}


def get(key: str) -> Any:
    return load()[key]


def update(changes: dict[str, Any]) -> dict[str, Any]:
    current = load()
    current.update({k: v for k, v in changes.items() if k in DEFAULTS})
    _PATH.parent.mkdir(parents=True, exist_ok=True)
    _PATH.write_text(json.dumps(current, indent=2))
    return current
