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

# Maps keyed BY asset key (a checks component's `assets: {raw_customers: {...}}`).
_MAP_KEY = re.compile(r"^(assets?|asset_checks?|checks_by_asset|assets_by_key)$", re.I)

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
    item_fields: list[str] = field(default_factory=list)   # post_processing targets / graph edges / map entries naming the key

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
            if isinstance(v, dict) and _MAP_KEY.search(str(k)) and key in v:
                out.item_fields.append(f"{p}.{key}")
                if len(v) == 1:
                    out.emptying = True
            if isinstance(v, str):
                if ref and v == key:
                    out.scalar_fields.append(p)
            elif isinstance(v, list):
                if any(_names_key(x, key) for x in v):
                    out.item_fields.append(p)
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


def _names_key(item: Any, key: str) -> bool:
    """A list ITEM (not a bare string) that exists only to name this asset: a post_processing entry targeting it
    (`target: key:raw_customers`) or a dependency-graph edge from/to it."""
    if not isinstance(item, dict):
        return False
    if item.get("target") == f"key:{key}":
        return True
    return "source" in item and "target" in item and key in (item.get("source"), item.get("target"))


def find_references(defs_dir: Path, key: str, skip_dir: Path | None = None) -> list[Ref]:
    y = _yaml()
    refs: list[Ref] = []
    # The folder-level defs.yaml (post_processing entries, e.g. a dependency edge onto the asset) counts too.
    for f in [defs_dir / "defs.yaml", *sorted(defs_dir.glob("*/defs.yaml"))]:
        if not f.is_file() or (skip_dir is not None and f.parent == skip_dir):
            continue
        text = f.read_text()
        if key not in text:
            continue
        try:
            data = y.load(text) or {}
        except Exception:
            continue
        is_root = f.parent == defs_dir
        ref = Ref(component="defs.yaml" if is_root else f.parent.name, type=str(data.get("type", "")), file=f)
        _scan(data.get("attributes") or {}, key, False, "", ref)
        _scan({k: v for k, v in data.items() if k not in ("type", "attributes")}, key, False, "", ref)
        if ref.list_fields or ref.scalar_fields or ref.item_fields:
            refs.append(ref)
    return refs


def _remove_from_lists(node: Any, key: str, in_ref: bool) -> tuple[int, bool]:
    """Remove `key` from reference lists in place. Returns (#removed, any_list_left_empty)."""
    removed, emptied = 0, False
    if isinstance(node, dict):
        for k, v in list(node.items()):
            ref = in_ref or bool(_REF_KEY.search(str(k)))
            if isinstance(v, dict) and _MAP_KEY.search(str(k)) and key in v:
                del v[key]
                removed += 1
                emptied = emptied or not v
            if isinstance(v, list) and any(_names_key(x, key) for x in v):
                before = len(v)
                v[:] = [x for x in v if not _names_key(x, key)]
                removed += before - len(v)
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
        if ref.scalar_fields and ref.component != "defs.yaml":
            if ref.is_automation:
                shutil.rmtree(ref.file.parent, ignore_errors=True)
                out["removed"].append(ref.component)
            else:
                out["left"].append(ref.component)
            continue
        data = y.load(ref.file.read_text())
        _, emptied = _remove_from_lists(data, key, False)
        if emptied and ref.component != "defs.yaml":
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


def component_asset_key(instance_dir: Path, fallback: str) -> str:
    """The asset key a component folder produces (its `asset_name`/`asset_key`), else the folder name."""
    try:
        data = _yaml().load((instance_dir / "defs.yaml").read_text()) or {}
        attrs = data.get("attributes") or {}
        name = attrs.get("asset_name") or attrs.get("asset_key")
        return name if isinstance(name, str) and name else fallback
    except Exception:
        return fallback


# Dagster names the offending keys in several shapes depending on where loading fails:
#   "Invalid selected keys: {AssetKey(['raw_customers'])}"
#   "AssetKey(s) ['pr_review_fetch_pr_diff', 'x'] were selected, but no AssetsDefinition objects supply these keys"
_KEY_CALL = re.compile(r"AssetKey\(\[([^\]]*)\]\)")
_KEY_LIST = re.compile(r"AssetKey\(s\)\s*\[([^\]]*)\]")


def _split_quoted(blob: str) -> list[str]:
    return re.findall(r"['\"]([^'\"]+)['\"]", blob)


def parse_missing_asset_keys(error_text: str) -> list[str]:
    """Asset keys a failed project load says are missing (multi-part keys joined with "/"), in first-seen order."""
    found: list[str] = []
    for m in _KEY_CALL.finditer(error_text):
        parts = _split_quoted(m.group(1))
        if parts:
            found.append("/".join(parts))
    for m in _KEY_LIST.finditer(error_text):
        found.extend(_split_quoted(m.group(1)))
    return list(dict.fromkeys(found))


def heal_missing_assets(defs_dir: Path, keys: list[str], dry_run: bool = False) -> dict[str, dict]:
    """Per missing key: what references it and (unless dry_run) clean those references up. Independent of HOW the asset
    went missing (UI delete, Code-editor delete, git pull, dbt model removed), since it works from the load error."""
    out: dict[str, dict] = {}
    for key in keys:
        refs = find_references(defs_dir, key)
        if dry_run:
            out[key] = {
                "removed": [r.component for r in refs if r.removed_with_asset],
                "edited": [r.component for r in refs if not r.removed_with_asset and (r.list_fields or r.item_fields or r.component == "defs.yaml")],
                "left": [r.component for r in refs if r.scalar_fields and not r.is_automation and r.component != "defs.yaml"],
            }
        else:
            out[key] = apply_cascade(defs_dir, key)
    return out
