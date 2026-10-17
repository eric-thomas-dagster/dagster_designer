"""Rename an asset without breaking what is built on it.

An asset's key is its component's `asset_name`, and other components refer to it by that key (an `upstream_asset_key`,
a `deps` list, a custom-lineage edge...). Renaming the key alone leaves every one of those pointing at a key that no
longer exists, which stops the whole project loading. `rewrite_references` updates them all, and returns the original
text of every file it touched so the caller can put them back if the renamed project then fails to load.
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any

# Attribute names that hold references to other assets.
_REF_KEY = re.compile(r"(upstream|dep|source_asset|input_asset|asset_key|inputs?$)", re.I)


def _rewrite(node: Any, old: str, new: str, in_ref: bool) -> int:
    """Rewrite references in place (works on ruamel round-trip containers and plain dict/list). Returns the count."""
    changed = 0
    if isinstance(node, dict):
        for k in list(node.keys()):
            v = node[k]
            ref = in_ref or bool(_REF_KEY.search(str(k)))
            if isinstance(v, str):
                if (ref and v == old) or v == f"key:{old}":
                    node[k] = new if v == old else f"key:{new}"
                    changed += 1
            else:
                changed += _rewrite(v, old, new, ref)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if isinstance(v, str):
                if (in_ref and v == old) or v == f"key:{old}":
                    node[i] = new if v == old else f"key:{new}"
                    changed += 1
            else:
                changed += _rewrite(v, old, new, in_ref)
    return changed


def rewrite_references(defs_dir: Path, old: str, new: str, skip_dir: Path | None = None) -> dict[Path, str]:
    """Rewrite references to asset `old` as `new` in every defs.yaml under `defs_dir` (except inside `skip_dir`).
    Returns {file: original text} for each file changed. Comments and layout are preserved (ruamel round-trip)."""
    from ruamel.yaml import YAML

    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 4096
    touched: dict[Path, str] = {}
    for f in sorted(defs_dir.rglob("defs.yaml")):
        if skip_dir is not None and skip_dir in f.parents:
            continue
        if ".local_defs_state" in f.parts:
            continue
        text = f.read_text()
        if old not in text:
            continue
        try:
            data = yaml.load(text)
        except Exception:
            continue
        if data is None or _rewrite(data, old, new, False) == 0:
            continue
        buf = io.StringIO()
        yaml.dump(data, buf)
        f.write_text(buf.getvalue())
        touched[f] = text
    return touched


def restore(touched: dict[Path, str]) -> None:
    for f, text in touched.items():
        f.write_text(text)
