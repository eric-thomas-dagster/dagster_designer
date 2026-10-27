"""Remembers a project's `dg list defs` result on disk, so reopening a project doesn't pay for loading every definition again.

Loading definitions is the slowest thing the app does (seconds for a small project, a minute or more with dbt), and the in-memory cache
only lasts 60 seconds and dies with the app. The result only changes when the project's files do, so it is stored with a fingerprint of
those files (path, size and modified time of everything that can affect definitions) and reused while the fingerprint is unchanged.

Anything that must see the truth -- validation after an edit, "regenerate", a saved file -- clears the entry through
``invalidate_project_caches`` / ``clear_cache``, and any edit changes the fingerprint anyway. Only successful loads are stored.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from ..core.config import settings

# Directories whose contents can't change what loads (kept in step with asset_introspection_service._NON_DEFINITION_PREFIXES).
_SKIP_DIRS = {"data", ".venv", "venv", ".designer_dagster_home", "logs", "node_modules", ".git", "__pycache__"}
SCHEMA_VERSION = 1
# Even an unchanged project is re-read after this long: definitions can depend on things outside the folder (a database, an API).
MAX_AGE_SECONDS = 24 * 3600


def project_fingerprint(project_dir: Path) -> str:
    """Hash of path + size + mtime for every file that can affect definitions. Stat only, no file reads."""
    h = hashlib.sha256()
    root = str(project_dir)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_DIRS)
        for name in sorted(filenames):
            if name.endswith(".pyc"):
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            h.update(f"{os.path.relpath(full, root)}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())
    return h.hexdigest()


def _path(project_id: str, cache_dir: Path | None) -> Path:
    safe = "".join(c for c in project_id if c.isalnum() or c in "-_")
    return (cache_dir or settings.data_dir / "definitions_cache") / f"{safe}.json"


def load(project_id: str, project_dir: Path, cache_dir: Path | None = None) -> dict[str, Any] | None:
    """The stored result if it is current for this project's files, else None. Never raises."""
    try:
        entry = json.loads(_path(project_id, cache_dir).read_text())
        if entry.get("version") != SCHEMA_VERSION or time.time() - entry["saved_at"] > MAX_AGE_SECONDS:
            return None
        if entry["fingerprint"] != project_fingerprint(project_dir):
            return None
        return entry["data"]
    except Exception:
        return None


def store(project_id: str, project_dir: Path, data: dict[str, Any], load_seconds: float | None = None, cache_dir: Path | None = None) -> None:
    """Best effort: a cache that can't be written is just a cache that doesn't help."""
    try:
        target = _path(project_id, cache_dir)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "version": SCHEMA_VERSION,
            "saved_at": time.time(),
            "fingerprint": project_fingerprint(project_dir),
            "load_seconds": load_seconds,
            "data": data,
        }))
        os.replace(tmp, target)
    except Exception:
        pass


def clear(project_id: str, cache_dir: Path | None = None) -> None:
    try:
        _path(project_id, cache_dir).unlink(missing_ok=True)
    except Exception:
        pass
