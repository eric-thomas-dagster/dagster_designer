"""Fix the class name in a freshly installed component's `type:`.

The community CLI writes `type: dagster_community_components.<Name>Component` by title-casing the component id
(`dataframe_transformer` -> `DataframeTransformerComponent`). For about one component in five the real class is spelled
differently (`DataFrameTransformerComponent`, `SFTPToDatabaseAssetComponent`, `LinkedInAdsIngestionComponent`...), and
Dagster then says "Component type ... not found" -- the whole project stops loading. The package's own registry
(`dagster_community_components/__init__.py`, class name -> `assets/<category>/<id>/component.py`) knows the real name,
so look it up there, by the component's id.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

PREFIX = "dagster_community_components."
_cache: dict[str, tuple[float, dict[str, str]]] = {}


def _registry_file(project_dir: Path) -> Path | None:
    for pattern in (".venv/lib/python*/site-packages", ".venv/Lib/site-packages"):
        for sp in project_dir.glob(pattern):
            f = sp / "dagster_community_components" / "__init__.py"
            if f.exists():
                return f
    return None


def load_registry(project_dir: Path) -> dict[str, str]:
    """{class name: 'assets/<category>/<id>/component.py'} from the project's installed package ({} if unavailable)."""
    f = _registry_file(project_dir)
    if f is None:
        return {}
    mtime = f.stat().st_mtime
    hit = _cache.get(str(f))
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        m = re.search(r"_CLASS_PATHS[^=]*=\s*(\{.*?\n\})", f.read_text(), re.S)
        data = ast.literal_eval(m.group(1)) if m else {}
        reg = {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}
    except Exception:
        reg = {}
    _cache[str(f)] = (mtime, reg)
    return reg


def resolve_component_type(project_dir: Path, component_id: str, type_str: str) -> str:
    """`type_str` with the class name corrected to the one the installed package really has. Anything that isn't a
    community-package type, or that already names a real class, or can't be resolved, is returned unchanged."""
    if not isinstance(type_str, str) or not type_str.startswith(PREFIX):
        return type_str
    reg = load_registry(project_dir)
    if not reg:
        return type_str
    name = type_str[len(PREFIX):]
    if name in reg:
        return type_str
    by_id = [cls for cls, path in reg.items() if path.split("/")[-2:-1] == [component_id]]
    if len(by_id) == 1:
        return PREFIX + by_id[0]
    by_case = [cls for cls in reg if cls.lower() == name.lower()]
    if len(by_case) == 1:
        return PREFIX + by_case[0]
    return type_str
