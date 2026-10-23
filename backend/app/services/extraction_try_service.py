"""Run a structured-document extraction on a few sample files without materializing anything ("Try it").

The actual extraction happens in the project's own Python environment (scripts/try_extract.py), calling the installed
component's `extract_one` so the preview is what production would produce. This module adds what the script can't:
a result cache (so tweaking one field doesn't re-bill every sample), input hashing, and component discovery.

Sample documents are often sensitive (invoices, contracts). The cache holds hashes and extracted values in memory only
-- never document bytes, never on disk -- and entries expire.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import subprocess
import time
from pathlib import Path
from typing import Any

from ..core.uv_binary import project_subprocess_env
from . import extraction_golden_service as golden
from . import extraction_scoring as scoring
from .project_service import project_service

MAX_FILES = 10
CACHE_TTL_SECONDS = 3600
CACHE_MAX_ENTRIES = 500
MAX_HASH_BYTES = 50 * 1024 * 1024
RUN_TIMEOUT_SECONDS = 240
COMPONENT_ID = "structured_document_extractor"

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


class ExtractionTryError(RuntimeError):
    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.code = code


def find_component_source(project_dir: Path) -> Path | None:
    """The project's installed copy of the extractor: <project>/src/<pkg>/components/structured_document_extractor/component.py."""
    for candidate in sorted((project_dir / "src").glob(f"*/components/{COMPONENT_ID}/component.py")):
        return candidate
    return None


def _file_digest(path: str) -> str:
    """Content hash of a (possibly remote) file via fsspec; falls back to the path alone if it can't be read, which just
    means that sample never gets a cache hit."""
    try:
        import fsspec

        h = hashlib.sha256()
        read = 0
        with fsspec.open(path, "rb") as f:
            while chunk := f.read(1024 * 1024):
                read += len(chunk)
                if read > MAX_HASH_BYTES:
                    return "path:" + path
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return "path:" + path


def cache_key(file_digest: str, spec: dict[str, Any]) -> str:
    """Everything that changes what the model is asked or who answers."""
    material = json.dumps(
        {k: spec.get(k) for k in ("output_fields", "document_type", "model", "api_base_env_var", "field_regions", "input_type", "max_content_chars")},
        sort_keys=True, default=str,
    )
    return hashlib.sha256((file_digest + "|" + material).encode()).hexdigest()


def _cache_get(key: str) -> dict[str, Any] | None:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_TTL_SECONDS:
        return hit[1]
    _cache.pop(key, None)
    return None


def _cache_put(key: str, result: dict[str, Any]) -> None:
    if len(_cache) >= CACHE_MAX_ENTRIES:
        for old in sorted(_cache, key=lambda k: _cache[k][0])[: CACHE_MAX_ENTRIES // 10]:
            _cache.pop(old, None)
    _cache[key] = (time.time(), result)


def clear_cache() -> None:
    _cache.clear()


async def try_extraction(project_id: str, spec: dict[str, Any], use_cache: bool = True) -> dict[str, Any]:
    """`spec`: files, output_fields, document_type, model, api_key_env_var, api_base_env_var, field_regions, input_type, ..."""
    project = project_service.get_project(project_id)
    if project is None:
        raise ExtractionTryError("Project not found", "not_found")
    project_dir = project_service._get_project_dir(project)
    component = find_component_source(project_dir)
    if component is None:
        raise ExtractionTryError(
            "structured_document_extractor isn't installed in this project yet. Add it from Document Extraction first.", "component_missing"
        )
    files = list(spec.get("files") or [])
    if not files:
        raise ExtractionTryError("No sample files to run.", "no_files")
    if len(files) > MAX_FILES:
        raise ExtractionTryError(f"Try up to {MAX_FILES} samples at a time.", "too_many_files")
    if not spec.get("output_fields"):
        raise ExtractionTryError("Add at least one field to extract.", "no_fields")

    digests = await asyncio.to_thread(lambda: [_file_digest(f) for f in files])
    keys = [cache_key(d, spec) for d in digests]
    results: dict[int, dict[str, Any]] = {}
    pending: list[int] = []
    for i, k in enumerate(keys):
        hit = _cache_get(k) if (k and use_cache) else None  # "re-run" skips the lookup but still refreshes the cache below
        if hit is not None:
            results[i] = {**hit, "file": files[i], "cached": True}
        else:
            pending.append(i)

    if pending:
        request = {
            "component_path": str(component),
            "files": [files[i] for i in pending],
            "output_fields": spec["output_fields"],
            "document_type": spec.get("document_type") or "custom",
            "model": spec["model"],
            "api_key_env_var": spec.get("api_key_env_var"),
            "api_base_env_var": spec.get("api_base_env_var"),
            "field_regions": spec.get("field_regions"),
            "input_type": spec.get("input_type", "file"),
            "max_content_chars": spec.get("max_content_chars"),
            "llm_max_retries": spec.get("llm_max_retries", 2),
            "project_dir": str(project_dir),
        }
        env = project_subprocess_env(project_dir)
        proc = await asyncio.to_thread(
            subprocess.run,
            [str(project_service._get_project_python_path(project)), "-m", "scripts.try_extract"],
            input=json.dumps(request), cwd=Path(__file__).resolve().parent.parent.parent, env=env,
            capture_output=True, text=True, timeout=RUN_TIMEOUT_SECONDS,
        )
        last = (proc.stdout.strip().splitlines() or [""])[-1]
        try:
            out = json.loads(last)
        except json.JSONDecodeError:
            raise ExtractionTryError(f"The sample runner failed: {(proc.stderr or proc.stdout)[-500:]}", "runner_failed")
        if not out.get("success"):
            raise ExtractionTryError(out.get("error", "The sample runner failed."), out.get("code", "runner_failed"))
        for i, r in zip(pending, out["results"]):
            results[i] = {**r, "cached": False}
            if r.get("ok") and keys[i]:
                _cache_put(keys[i], {k: v for k, v in r.items() if k != "file"})

    ordered = [results[i] for i in range(len(files))]
    for r, digest in zip(ordered, digests):
        r["digest"] = digest

    # Score against the golden set (values a person confirmed) when this extraction has one -- done here, after the cache, so a cached
    # result is scored against the CURRENT golden set rather than whatever was marked when it was first run.
    score = None
    asset_name = spec.get("asset_name")
    if asset_name:
        data = golden.load(project_dir, asset_name)
        per_doc = []
        for r in ordered:
            expected = golden.expected_for(data, r["digest"])
            r["expected"] = expected
            r["match"] = scoring.score_document(r.get("fields") if r.get("ok") else None, expected) if expected else {}
            if r["match"]:
                per_doc.append(r["match"])
        score = scoring.summarize(per_doc)
    return {
        "results": ordered,
        "model": spec["model"],
        "cached": sum(1 for r in ordered if r.get("cached")),
        "calls": sum(1 for r in ordered if not r.get("cached")),
        "score": score,
    }


def project_dir_for(project_id: str) -> Path:
    project = project_service.get_project(project_id)
    if project is None:
        raise ExtractionTryError("Project not found", "not_found")
    return project_service._get_project_dir(project)
