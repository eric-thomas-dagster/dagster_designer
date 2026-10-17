"""Make sure the Python packages a project's community components need are actually installed.

A component installed "as a package" copies nothing into the project, so its own requirements.txt (litellm + mcp for
agentic_pipeline, openai for openai_agent, ...) was never installed: the install said "success" and the first run died
with `No module named 'mcp'`. Every install path -- the AI bar, the Agent Builder, Add data, the config form -- must leave a
runnable project, so they all go through `ensure_dependencies`; `used_component_ids` + the project-level endpoint repair
projects that were installed before this existed.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ..core.uv_binary import find_uv_binary, project_subprocess_env, venv_bin_path
from .component_type_resolver import PREFIX, load_registry

_CHECK_SCRIPT = r"""
import json, sys
from importlib import metadata
from packaging.requirements import Requirement
missing = []
for line in json.loads(sys.argv[1]):
    try:
        r = Requirement(line)
    except Exception:
        continue
    if r.marker is not None and not r.marker.evaluate():
        continue
    try:
        v = metadata.version(r.name)
    except metadata.PackageNotFoundError:
        missing.append(line); continue
    if r.specifier and not r.specifier.contains(v, prereleases=True):
        missing.append(line)
print(json.dumps(missing))
"""


def requirements_for_component(project_dir: Path, component_id: str) -> list[str]:
    """The component's own requirements.txt lines: from the installed package (package mode) or a vendored copy."""
    candidates: list[Path] = []
    for pattern in (".venv/lib/python*/site-packages", ".venv/Lib/site-packages"):
        for sp in project_dir.glob(pattern):
            candidates += sorted((sp / "dagster_community_components" / "assets").glob(f"*/{component_id}/requirements.txt"))
    candidates += list(project_dir.glob(f"src/*/components/{component_id}/requirements.txt"))
    candidates += list(project_dir.glob(f"*/components/{component_id}/requirements.txt"))
    for c in candidates:
        lines = [l.strip() for l in c.read_text().splitlines()]
        return [l for l in lines if l and not l.startswith("#")]
    return []


def used_component_ids(project_dir: Path) -> set[str]:
    """Community component ids used by this project's defs.yaml files (resolved through the package's registry)."""
    import yaml

    reg = load_registry(project_dir)
    if not reg:
        return set()
    ids: set[str] = set()
    for f in project_dir.glob("src/*/defs/**/defs.yaml"):
        if ".local_defs_state" in f.parts:
            continue
        try:
            t = (yaml.safe_load(f.read_text()) or {}).get("type")
        except Exception:
            continue
        if isinstance(t, str) and t.startswith(PREFIX):
            path = reg.get(t[len(PREFIX):])
            if path and len(path.split("/")) >= 2:
                ids.add(path.split("/")[-2])
    return ids


def missing_requirements(project_dir: Path, requirements: list[str]) -> list[str]:
    """Which of `requirements` the project's own venv doesn't satisfy ([] if it can't tell: never block on a check)."""
    if not requirements:
        return []
    py = venv_bin_path(project_dir / ".venv", "python")
    if not py.exists():
        return []
    try:
        r = subprocess.run([str(py), "-c", _CHECK_SCRIPT, json.dumps(requirements)], capture_output=True, text=True, timeout=60,
                           env=project_subprocess_env(project_dir))
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else []
    except Exception:
        return []


def install_requirements(project_dir: Path, requirements: list[str], timeout: int = 900) -> tuple[bool, str]:
    """`uv add` them (recorded in pyproject, so they survive a re-sync). Returns (ok, short message)."""
    try:
        r = subprocess.run([find_uv_binary("uv"), "add", *requirements], cwd=str(project_dir),
                           env=project_subprocess_env(project_dir), capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        return False, str(e)[:300]
    if r.returncode != 0:
        return False, " | ".join((r.stderr or r.stdout or "").strip().splitlines()[-4:])[:500]
    return True, ""


def ensure_dependencies(project_dir: Path, component_ids: set[str] | list[str]) -> dict:
    """Install whatever the given components need that the project's venv lacks. Never raises.
    Returns {"checked": [...ids], "installed": [...requirements], "failed": "reason" | None}."""
    wanted: list[str] = []
    for cid in sorted(component_ids):
        for line in requirements_for_component(project_dir, cid):
            if line not in wanted:
                wanted.append(line)
    missing = missing_requirements(project_dir, wanted)
    if not missing:
        return {"checked": sorted(component_ids), "installed": [], "failed": None}
    ok, msg = install_requirements(project_dir, missing)
    return {"checked": sorted(component_ids), "installed": missing if ok else [], "failed": None if ok else msg}
