"""What else points at an asset -- and what to do with those pointers when the asset is deleted.

Deleting an asset used to warn only about assets built on it. But jobs, schedules, sensors and checks also *name* assets
(`asset_keys: [raw_customers]`, a check's `asset_key`), and one left pointing at a deleted asset stops the WHOLE project
loading ("Selected keys must be a subset of existing executable asset keys"). `find_references` lists them for the
confirmation dialog; `apply_cascade` fixes them: a key is removed from lists that name several assets, and a component whose
only purpose was that asset (a schedule over just it, a check on it) is removed with it. Components that merely consume the
asset as an input (downstream assets) are never touched here -- they are reported so the user decides.
"""
from __future__ import annotations

import io
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .asset_rename import _REF_KEY

# Components that exist only to run / watch / check assets: safe to remove together with their only target.
_AUTOMATION = re.compile(r"(Check|Schedule|Sensor|Job|Monitor|Trigger)", re.I)


@dataclass
class Ref:
    component: str                      # defs/<component>/
    type: str                           # full type string
    file: Path
    list_fields: list[str] = field(default_factory=list)
    scalar_fields: list[str] = field(default_factory=list)
    emptying: bool = False              # a referencing list holds nothing BUT this key (removing it leaves it empty)

    @property
    def removed_with_asset(self) -> bool:
        """What apply_cascade will do: an automation/check whose only target was the asset goes with it."""
        return self.is_automation and (bool(self.scalar_fields) or self.emptying)

    @property
    def class_name(self) -> str:
        return self.type.rsplit(".", 1)[-1]

    @property
    def is_automation(self) -> bool:
        return bool(_AUTOMATION.search(self.class_name))


def _yaml():
    from ruamel.yaml import YAML
    y = YAML()
    y.preserve_quotes = True
    y.width = 4096
    return y


def _scan(node: Any, key: str, in_ref: bool, path: str, out: Ref) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            ref = in_ref or bool(_REF_KEY.search(str(k)))
            p = f"{path}.{k}" if path else str(k)
            if isinstance(v, str):
                if ref and v == key:
                    out.scalar_fields.append(p)
            elif isinstance(v, list):
                if ref and any(isinstance(x, str) and x == key for x in v):
                    out.list_fields.append(p)
                    if all(isinstance(x, str) and x == key for x in v):
                        out.emptying = True
                _scan(v, key, ref, p, out)
            else:
                _scan(v, key, ref, p, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            if not isinstance(v, str):
                _scan(v, key, in_ref, f"{path}[{i}]", out)


def find_references(defs_dir: Path, key: str, skip_dir: Path | None = None) -> list[Ref]:
    y = _yaml()
    refs: list[Ref] = []
    for f in sorted(defs_dir.glob("*/defs.yaml")):
        if skip_dir is not None and f.parent == skip_dir:
            continue
        text = f.read_text()
        if key not in text:
            continue
        try:
            data = y.load(text) or {}
        except Exception:
            continue
        ref = Ref(component=f.parent.name, type=str(data.get("type", "")), file=f)
        _scan(data.get("attributes") or {}, key, False, "", ref)
        if ref.list_fields or ref.scalar_fields:
            refs.append(ref)
    return refs


def _remove_from_lists(node: Any, key: str, in_ref: bool) -> tuple[int, bool]:
    """Remove `key` from reference lists in place. Returns (#removed, any_list_left_empty)."""
    removed, emptied = 0, False
    if isinstance(node, dict):
        for k, v in node.items():
            ref = in_ref or bool(_REF_KEY.search(str(k)))
            if isinstance(v, list):
                if ref and any(isinstance(x, str) and x == key for x in v):
                    before = len(v)
                    v[:] = [x for x in v if not (isinstance(x, str) and x == key)]
                    removed += before - len(v)
                    emptied = emptied or not v
                r, e = _remove_from_lists(v, key, ref)
                removed, emptied = removed + r, emptied or e
            elif isinstance(v, dict):
                r, e = _remove_from_lists(v, key, ref)
                removed, emptied = removed + r, emptied or e
    elif isinstance(node, list):
        for v in node:
            if not isinstance(v, str):
                r, e = _remove_from_lists(v, key, in_ref)
                removed, emptied = removed + r, emptied or e
    return removed, emptied


def apply_cascade(defs_dir: Path, key: str, skip_dir: Path | None = None) -> dict[str, list[str]]:
    """Make the project consistent after `key` is deleted. Returns {"edited": [...], "removed": [...], "left": [...]}
    (component folder names): edited = key dropped from a list; removed = automation/check whose only target it was;
    left = still references it as an input (a downstream asset) -- not touched."""
    y = _yaml()
    out: dict[str, list[str]] = {"edited": [], "removed": [], "left": []}
    for ref in find_references(defs_dir, key, skip_dir):
        if ref.scalar_fields:
            if ref.is_automation:
                shutil.rmtree(ref.file.parent, ignore_errors=True)
                out["removed"].append(ref.component)
            else:
                out["left"].append(ref.component)
            continue
        data = y.load(ref.file.read_text())
        _, emptied = _remove_from_lists(data.get("attributes") or {}, key, False)
        if emptied:
            # nothing left for it to act on
            if ref.is_automation:
                shutil.rmtree(ref.file.parent, ignore_errors=True)
                out["removed"].append(ref.component)
            else:
                out["left"].append(ref.component)
            continue
        buf = io.StringIO()
        y.dump(data, buf)
        ref.file.write_text(buf.getvalue())
        out["edited"].append(ref.component)
    return out
