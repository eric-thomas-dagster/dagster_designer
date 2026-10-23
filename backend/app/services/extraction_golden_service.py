"""The golden set: values a person confirmed (or corrected) for specific fields of specific sample documents.

Stored per project and per extraction asset at `<project>/.designer/golden/<asset>.json`, keyed by the document's CONTENT hash (a renamed
or moved file is still the same document), so it can later be frozen into the pipeline as a regression check. A field is
"marked" when its key is present in `expected`; an explicit null means "this should come back empty".
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

MAX_DOCUMENTS = 500
VERSION = 1


def golden_path(project_dir: Path, asset_name: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", asset_name).strip("._") or "extraction"
    return project_dir / ".designer" / "golden" / f"{safe}.json"


def _empty(asset_name: str) -> dict[str, Any]:
    return {"version": VERSION, "asset_name": asset_name, "documents": {}}


def load(project_dir: Path, asset_name: str) -> dict[str, Any]:
    path = golden_path(project_dir, asset_name)
    if not path.is_file():
        return _empty(asset_name)
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict) and isinstance(data.get("documents"), dict):
            return {"version": VERSION, "asset_name": asset_name, "documents": data["documents"]}
    except (OSError, ValueError):
        pass
    return _empty(asset_name)


def _write(project_dir: Path, asset_name: str, data: dict[str, Any]) -> None:
    path = golden_path(project_dir, asset_name)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, path)  # atomic: a crash mid-write never leaves half a golden set
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def set_expected(project_dir: Path, asset_name: str, digest: str, path: str, field: str, value: Any) -> dict[str, Any]:
    data = load(project_dir, asset_name)
    docs = data["documents"]
    if digest not in docs and len(docs) >= MAX_DOCUMENTS:
        raise ValueError(f"A golden set holds up to {MAX_DOCUMENTS} documents.")
    doc = docs.setdefault(digest, {"path": path, "expected": {}})
    doc["path"] = path  # latest known location, for display only
    doc["expected"][field] = value
    _write(project_dir, asset_name, data)
    return data


def clear_expected(project_dir: Path, asset_name: str, digest: str, field: str) -> dict[str, Any]:
    data = load(project_dir, asset_name)
    doc = data["documents"].get(digest)
    if doc and field in doc.get("expected", {}):
        del doc["expected"][field]
        if not doc["expected"]:
            del data["documents"][digest]
        _write(project_dir, asset_name, data)
    return data


def expected_for(data: dict[str, Any], digest: str) -> dict[str, Any]:
    return dict((data["documents"].get(digest) or {}).get("expected") or {})
