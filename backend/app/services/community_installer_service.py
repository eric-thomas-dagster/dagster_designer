"""Shared logic for getting a community-catalog component's code into a
target repo (or worktree) that doesn't have it yet.

Extracted out of `promotion_service.py` so `preview_git_service.py` can
use the exact same bootstrap logic when booting a live preview against a
component that's never been promoted anywhere before -- previously only
the PR-promotion path knew how to do this, so previewing a brand-new
community component against a real branch deployment would fail to load
(defs.yaml referencing a type nothing in the worktree could import).

Design: instead of copying each community component's Python source
into the target on every promote/preview, we install a single
`StateBackedComponent` -- the community_component_installer -- once,
and let IT fetch source at refresh-state time. Adding another catalog
component to an already-bootstrapped target is just appending its ID to
the installer's declarative `components:` list.
"""
from __future__ import annotations

from pathlib import Path

import httpx

_INSTALLER_RAW_BASE = (
    "https://raw.githubusercontent.com/eric-thomas-dagster/"
    "dagster-component-templates/main/assets/infrastructure/community_component_installer"
)
_INSTALLER_SOURCE_FILES = ("component.py", "__init__.py", "schema.json", "requirements.txt")


def fetch_installer_source_files() -> dict[str, str]:
    """Fetch the installer's source files from the community-templates repo.

    Returns `{filename: content}` for every file that was retrievable.
    Best-effort -- a missing file is skipped, not fatal."""
    out: dict[str, str] = {}
    for fname in _INSTALLER_SOURCE_FILES:
        try:
            r = httpx.get(f"{_INSTALLER_RAW_BASE}/{fname}", timeout=15.0)
            if r.status_code == 200:
                out[fname] = r.text
        except httpx.HTTPError as e:
            print(f"[community-installer] source fetch failed for {fname}: {e}")
    return out


def components_root(repo_root: Path, defs_subdir: str) -> Path:
    """Given the defs-subdir where component instances live (e.g.
    `hooli-data-eng/src/hooli_data_eng/defs`), return the sibling
    `components/` dir where component SOURCE lives (`.../components/`).

    Convention across the community catalog + hooli + jaffle: components
    live in `<pkg>/components/<id>/component.py` and instances in
    `<pkg>/defs/<slug>/defs.yaml`. So swapping `/defs` for `/components`
    in the subdir gives the source directory."""
    parts = Path(defs_subdir).parts
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "defs":
            new_parts = list(parts[:i]) + ["components"] + list(parts[i + 1:])
            return repo_root / Path(*new_parts)
    return repo_root / defs_subdir.split("/")[0] / "components"


def ensure_community_installer(repo_root: Path, defs_subdir: str, catalog_id: str) -> list[str]:
    """Bootstrap community-component installation into a repo/worktree.

    Idempotent -- safe to call for every promote or preview.

    Effects:
      1. Copy the installer's Python source (component.py, __init__.py,
         schema.json, requirements.txt) into
         `<components-root>/community_component_installer/` when missing,
         so the target has the class it needs to load the installer's
         `defs.yaml` on the very first refresh -- no separate pip install
         step.
      2. Create or update `<defs_subdir>/community_component_installer/defs.yaml`
         to include `catalog_id` in its `components:` list (deduplicated).

    Returns the list of newly-written / modified files (repo-relative
    paths) so the caller can `repo.index.add(...)` them (promote) or
    just leave them as working-tree writes (preview).
    """
    import yaml as _yaml

    written: list[str] = []

    comp_root = components_root(repo_root, defs_subdir)
    installer_src_dir = comp_root / "community_component_installer"
    if not (installer_src_dir / "component.py").exists():
        source_files = fetch_installer_source_files()
        if source_files.get("component.py"):
            installer_src_dir.mkdir(parents=True, exist_ok=True)
            for fname, content in source_files.items():
                p = installer_src_dir / fname
                p.write_text(content)
                written.append(str(p.relative_to(repo_root)))
        else:
            print("[community-installer] could not fetch installer source — installer will fail to load")

    installer_defs_dir = repo_root / defs_subdir / "community_component_installer"
    installer_yaml = installer_defs_dir / "defs.yaml"

    if installer_yaml.exists():
        try:
            doc = _yaml.safe_load(installer_yaml.read_text()) or {}
        except Exception as e:
            print(f"[community-installer] existing installer defs.yaml unparseable: {e} — overwriting")
            doc = {}
    else:
        doc = {}

    if not doc:
        doc = {
            "type": "dagster_component_templates.CommunityComponentInstallerComponent",
            "attributes": {
                "components": [],
                "install_pip_requirements": True,
            },
        }

    attrs = doc.setdefault("attributes", {})
    components = attrs.setdefault("components", [])
    if not isinstance(components, list):
        components = []
        attrs["components"] = components

    if catalog_id not in components:
        components.append(catalog_id)

    installer_defs_dir.mkdir(parents=True, exist_ok=True)
    installer_yaml.write_text(_yaml.safe_dump(doc, sort_keys=False, default_flow_style=False))
    written.append(str(installer_yaml.relative_to(repo_root)))
    return written


def rewrite_defs_yaml_type(yaml_body: str, new_type: str) -> str:
    """Rewrite a defs.yaml's top-level `type:` field to `new_type`.

    Parses + re-dumps rather than splicing the `type:` line in place —
    YAML lets a long type string wrap onto its own line as a folded
    scalar (`type: >-\\n  the.actual.value`), which a naive
    line-starts-with("type:") replace would leave with an orphaned
    value line below it, corrupting the file. `dagster-component add`
    and `ComponentConfigModal`'s save path both produce that form for
    some sandbox-local paths (they're long), so this isn't a
    theoretical case.
    """
    import yaml as _yaml

    try:
        doc = _yaml.safe_load(yaml_body) or {}
    except Exception:
        doc = None
    if not isinstance(doc, dict):
        # Not parseable as a mapping — fall back to the old best-effort
        # line splice rather than dropping the whole file's content.
        lines = []
        for line in yaml_body.splitlines():
            if line.strip().startswith("type:"):
                indent = line[: len(line) - len(line.lstrip())]
                lines.append(f"{indent}type: {new_type}")
            else:
                lines.append(line)
        out = "\n".join(lines)
        return out if out.endswith("\n") else out + "\n"

    doc["type"] = new_type
    return _yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)


def match_catalog_id(component_type: str, catalog_ids: set[str]) -> str | None:
    """A component_type is a dotted Python import path (sandbox-local
    forms look like `ds_<id>.components.shopify_ingestion.component.
    ShopifyIngestionComponent`; already-canonical forms look like
    `dagster_component_templates.ShopifyIngestionComponent`). Search its
    dotted segments for one that names a catalog entry -- most-specific
    segment wins so e.g. `parametric_data_generator` beats a coincidental
    substring match against `data_generator`."""
    for seg in component_type.split("."):
        if seg in catalog_ids:
            return seg
    return None


async def resolve_catalog_rewrites(component_types: list[str]) -> dict[str, tuple[str, str]]:
    """For each component_type, check whether it references a
    community-catalog component and, if so, resolve the catalog's
    canonical type string.

    Returns `{component_type: (catalog_id, canonical_type)}` for every
    match. A type that doesn't match any catalog entry (a customer's own
    component) is simply absent from the result -- not an error.

    Deliberately async-and-batched-up-front rather than resolved lazily
    per-draft: callers that need to apply this inside a sync
    `run_in_executor` worker (git worktree writes) can't await here, so
    they resolve everything they'll need in the async caller first and
    pass the plain dict down.
    """
    from . import genie_service

    manifest = await genie_service.fetch_manifest()
    catalog_ids = {c.get("id") for c in (manifest.get("components") or []) if c.get("id")}
    out: dict[str, tuple[str, str]] = {}
    for ct in set(component_types):
        cid = match_catalog_id(ct, catalog_ids)
        if not cid or cid == "community_component_installer":
            continue
        canonical = await resolve_catalog_component_type(cid)
        if canonical:
            out[ct] = (cid, canonical)
    return out


async def resolve_catalog_component_type(catalog_id: str) -> str | None:
    """The catalog's own canonical `type:` string for a component id --
    e.g. `dagster_component_templates.ShopifyIngestionComponent` for
    `shopify_ingestion`. This is what the installer registers components
    under, which is NOT the same string a locally-authored sandbox
    instance uses (that's qualified under the sandbox's own throwaway
    module path). Read from the catalog's own schema.json rather than
    guessed from the class name, since the schema.json's `component_type`
    field is authoritative.

    Returns None if the catalog id doesn't exist or its schema can't be
    fetched -- caller should treat that as "couldn't resolve" and fail
    the promote/preview rather than write a guessed type.
    """
    from . import genie_service

    manifest = await genie_service.fetch_manifest()
    entry = next((c for c in (manifest.get("components") or []) if c.get("id") == catalog_id), None)
    schema_url = entry.get("schema_url") if entry else None
    if not schema_url:
        return None
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(schema_url)
            r.raise_for_status()
            return r.json().get("component_type")
    except Exception as e:
        print(f"[community-installer] schema fetch failed for catalog id {catalog_id!r}: {e}")
        return None
