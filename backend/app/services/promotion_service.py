"""Draft promotion — takes a stored Draft and lands it as a PR
against the customer's git repo.

Flow:
  1. Clone / refresh a local checkout of the target repo
  2. Create a branch `designer/promote-<draftid>-<timestamp>`
  3. Write the draft's YAML at the code location's defs/ subdir
  4. Commit + push
  5. Open a PR via GitHub REST

Configuration lives in env vars so the demo can point at any repo the
user has PAT access to. Defaults target hooli's public data-eng repo,
which is the one deployment (`christian/editable-components` branch)
that has app-managed component types available today.
"""
from __future__ import annotations

import shutil
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
from git import Repo, GitCommandError

from ..core.config import settings
from ..services.project_service import project_service
from .drafts_service import Draft, update_draft
from . import promotion_config
from . import dagster_plus_preview_service


GITHUB_API = "https://api.github.com"


def _sanitize_folder(component_id: str) -> str:
    out = []
    for ch in component_id.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in ("_", "-"):
            out.append(ch)
        elif ch in ("[", "]", " "):
            out.append("_")
    return "".join(out).strip("_") or "component"


_INSTALLER_RAW_BASE = (
    "https://raw.githubusercontent.com/eric-thomas-dagster/"
    "dagster-component-templates/main/assets/infrastructure/community_component_installer"
)
_INSTALLER_SOURCE_FILES = ("component.py", "__init__.py", "schema.json", "requirements.txt")


def _fetch_installer_source_files() -> dict[str, str]:
    """Fetch the installer's source files from the community-templates repo.

    Returns `{filename: content}` for every file that was retrievable.
    Best-effort — a missing file is skipped, not fatal. Cached in
    memory across calls in the same process for demo repeatability."""
    import httpx as _httpx
    out: dict[str, str] = {}
    for fname in _INSTALLER_SOURCE_FILES:
        try:
            r = _httpx.get(f"{_INSTALLER_RAW_BASE}/{fname}", timeout=15.0)
            if r.status_code == 200:
                out[fname] = r.text
        except _httpx.HTTPError as e:
            print(f"[promote] installer source fetch failed for {fname}: {e}")
    return out


def _components_root(repo_root: Path, defs_subdir: str) -> Path:
    """Given the defs-subdir where component instances live (e.g.
    `hooli-data-eng/src/hooli_data_eng/defs`), return the sibling
    `components/` dir where component SOURCE lives (`.../components/`).

    Convention across the community catalog + hooli + jaffle: components
    live in `<pkg>/components/<id>/component.py` and instances in
    `<pkg>/defs/<slug>/defs.yaml`. So swapping `/defs` for `/components`
    in the subdir gives the source directory."""
    parts = Path(defs_subdir).parts
    # Replace the LAST occurrence of "defs" with "components". If the
    # subdir doesn't contain "defs", drop back to a sibling of the tree.
    for i in range(len(parts) - 1, -1, -1):
        if parts[i] == "defs":
            new_parts = list(parts[:i]) + ["components"] + list(parts[i + 1:])
            return repo_root / Path(*new_parts)
    # Fallback: parallel to defs_subdir root.
    return repo_root / defs_subdir.split("/")[0] / "components"


def _ensure_community_installer(repo_root: Path, defs_subdir: str, catalog_id: str) -> list[str]:
    """Bootstrap community-component installation into the target repo.

    Idempotent — safe to call for every promote.

    Effects:
      1. Copy the installer's Python source (component.py, __init__.py,
         schema.json, requirements.txt) into
         `<components-root>/community_component_installer/` when missing,
         so the target deployment has the class it needs to load the
         installer's `defs.yaml` on the very first refresh — no separate
         pip install step.
      2. Create or update `<defs_subdir>/community_component_installer/defs.yaml`
         to include `catalog_id` in its `components:` list (deduplicated).

    Returns the list of newly-written / modified files (repo-relative
    paths) so the caller can `repo.index.add(...)` them.

    Rationale: instead of copying every community component's Python
    source into the target repo on every promote, we install a single
    `StateBackedComponent` — the community_component_installer — and
    let IT fetch the source at refresh-state time. Future promotes to
    the same target just append to the installer's `components:` list.
    Users can still update / pin versions declaratively via the YAML.
    """
    import yaml as _yaml

    written: list[str] = []

    # (1) Ensure the installer's Python SOURCE is in the target repo.
    # Without this, on first refresh the target has a defs.yaml pointing
    # at `dagster_component_templates.CommunityComponentInstallerComponent`
    # but no Python class of that name — location fails to load. Fetch
    # from the community-templates raw URL and drop into the standard
    # sibling `components/community_component_installer/` folder.
    components_root = _components_root(repo_root, defs_subdir)
    installer_src_dir = components_root / "community_component_installer"
    if not (installer_src_dir / "component.py").exists():
        source_files = _fetch_installer_source_files()
        if source_files.get("component.py"):
            installer_src_dir.mkdir(parents=True, exist_ok=True)
            for fname, content in source_files.items():
                p = installer_src_dir / fname
                p.write_text(content)
                written.append(str(p.relative_to(repo_root)))
        else:
            print(f"[promote] could not fetch installer source — installer will fail to load")

    installer_defs_dir = repo_root / defs_subdir / "community_component_installer"
    installer_yaml = installer_defs_dir / "defs.yaml"

    if installer_yaml.exists():
        try:
            doc = _yaml.safe_load(installer_yaml.read_text()) or {}
        except Exception as e:
            print(f"[promote] existing installer defs.yaml unparseable: {e} — overwriting")
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

    # Ensure the shape is what we expect; the installer's schema requires
    # `attributes.components` as a list of strings.
    attrs = doc.setdefault("attributes", {})
    components = attrs.setdefault("components", [])
    if not isinstance(components, list):
        # Existing file had a broken shape — reset defensively.
        components = []
        attrs["components"] = components

    if catalog_id not in components:
        components.append(catalog_id)

    installer_defs_dir.mkdir(parents=True, exist_ok=True)
    installer_yaml.write_text(_yaml.safe_dump(doc, sort_keys=False, default_flow_style=False))
    written.append(str(installer_yaml.relative_to(repo_root)))
    return written


def _repos_root() -> Path:
    root = settings.data_dir / "promote-clones"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _clone_url(owner_repo: str) -> str:
    token = promotion_config.get_github_token()
    if not token:
        raise RuntimeError(
            "No GitHub token configured. Open the Drafts drawer and click the "
            "settings gear to add a personal access token (repo scope required)."
        )
    return f"https://{token}@github.com/{owner_repo}.git"


def _ensure_clone(owner_repo: str, base_branch: str) -> Repo:
    """Reuse a cached clone across promotions; fresh-fetch the base branch."""
    repo_name = owner_repo.replace("/", "__")
    repo_path = _repos_root() / repo_name
    if repo_path.exists() and (repo_path / ".git").exists():
        repo = Repo(repo_path)
        # Reset to a clean state on the base branch, then pull latest.
        try:
            repo.git.reset("--hard")
            repo.git.checkout(base_branch)
            repo.remotes.origin.pull()
        except GitCommandError:
            # If anything goes wrong (stale ref, upstream force-push),
            # nuke + re-clone rather than fight a corrupt local state.
            shutil.rmtree(repo_path, ignore_errors=True)
            repo = Repo.clone_from(_clone_url(owner_repo), repo_path, branch=base_branch)
        return repo
    return Repo.clone_from(_clone_url(owner_repo), repo_path, branch=base_branch)


async def _open_pr(owner_repo: str, head_branch: str, base_branch: str, title: str, body: str) -> str:
    """Open a pull request via GitHub REST. Returns the PR web URL."""
    token = promotion_config.get_github_token()
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{GITHUB_API}/repos/{owner_repo}/pulls",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            json={"title": title, "body": body, "head": head_branch, "base": base_branch},
        )
        if r.status_code >= 300:
            raise RuntimeError(f"GitHub PR create failed ({r.status_code}): {r.text[:400]}")
        return r.json().get("html_url", "")


async def _resolve_target_git_branch(
    dagster_plus_org: str,
    token: str,
    deployment_name: str | None,
    default_branch: str,
) -> str:
    """Which git branch should we PR into?

    - Long-lived deployment (or no deployment specified) → mapping's default_branch
    - Branch deployment → the git branch the BD is tracking (from Dagster+'s
      branchDeployments metadata). Christian's editable-components BD, for
      example, tracks the git branch `christian/editable-components`.

    If we can't determine the BD's git branch we fall back to default_branch
    with a warning printed to logs — better than opening PRs to the wrong branch.
    """
    if not deployment_name:
        return default_branch
    from .dagster_plus_client import query as dp_query, DagsterPlusError
    q = """
    query DeploymentBranch {
      currentDeployment {
        deploymentType
        branchDeploymentGitMetadata { branchName }
      }
    }
    """
    try:
        data = await dp_query(dagster_plus_org, deployment_name, token, q)
    except DagsterPlusError:
        print(f"[promote] Could not resolve git branch for {deployment_name!r}, using {default_branch!r}")
        return default_branch
    cur = data.get("currentDeployment") or {}
    if cur.get("deploymentType") != "BRANCH":
        return default_branch
    branch = ((cur.get("branchDeploymentGitMetadata") or {}).get("branchName")) or ""
    if not branch:
        print(f"[promote] BD {deployment_name!r} has no git branch metadata, using {default_branch!r}")
        return default_branch
    return branch


async def promote_draft(project_id: str, draft: Draft, dagster_plus_org: str, token: str) -> dict:
    """Land a Draft as a PR against the customer's repo.

    The PR base branch depends on the draft's target deployment:
    long-lived → mapping.default_branch, branch deployment → the BD's
    tracked git branch. This keeps promote consistent with preview:
    if you previewed against christian's BD, your PR opens into
    christian's git branch, not into `master`.

    Returns `{ pr_url, branch, files_written, base_branch }`.
    """
    mapping = promotion_config.find_mapping(dagster_plus_org, draft.location_name)
    if mapping is None:
        raise RuntimeError(
            f"No promotion target configured for ({dagster_plus_org}, {draft.location_name}). "
            "Open the Drafts drawer settings to add a repo mapping."
        )

    owner_repo: str = mapping.owner_repo
    base_branch: str = await _resolve_target_git_branch(
        dagster_plus_org, token, draft.deployment_name, mapping.default_branch,
    )
    defs_subdir: str = mapping.defs_subdir

    repo = _ensure_clone(owner_repo, base_branch)
    repo_root = Path(repo.working_dir)

    # Branch name: short + unique. Matches Dagster+ Branch Deployment
    # naming conventions (dashes, no slashes forbidden but discouraged).
    ts = time.strftime("%Y%m%d-%H%M%S")
    short = uuid.uuid4().hex[:6]
    branch_name = f"designer/promote-{_sanitize_folder(draft.component_id)}-{ts}-{short}"
    repo.git.checkout("-b", branch_name)

    # Write the draft's YAML to <defs_subdir>/<slug>/defs.yaml. Two
    # transforms before writing:
    #   1. `type:` — rewrite the state-registry form (e.g.
    #      `hooli_data_eng.hooli_data_eng.components.ScheduledJobComponent`)
    #      to the actual Python import path
    #      (`hooli_data_eng.components.ScheduledJobComponent`) so
    #      `importlib.import_module` can load it. Dagster+ exposes the
    #      correct string via each ComponentType's `example` field.
    #   2. `asset_selection:` — rewrite comma-joined lists to the DSL
    #      `or`-joined form. `AssetSelection.from_string` treats `,` as
    #      a hard parse error, so old drafts stored under `, ` need
    #      fixing on the way out.
    import yaml as _yaml
    project = project_service.get_project(project_id)
    yaml_body = draft.attributes
    rewrote_type: str | None = None
    if project and draft.deployment_name:
        try:
            correct_type = await dagster_plus_preview_service.resolve_defs_yaml_type(
                project=project,
                base_deployment=draft.deployment_name,
                location_name=draft.location_name,
                state_component_type=draft.component_type,
            )
        except Exception as e:
            print(f"[promote] type resolution errored (non-fatal): {e}")
            correct_type = None
        if correct_type and correct_type != draft.component_type:
            new_lines: list[str] = []
            for line in yaml_body.splitlines():
                stripped = line.strip()
                if stripped.startswith("type:"):
                    indent = line[: len(line) - len(line.lstrip())]
                    new_lines.append(f"{indent}type: {correct_type}")
                    rewrote_type = correct_type
                else:
                    new_lines.append(line)
            yaml_body = "\n".join(new_lines)
            if not yaml_body.endswith("\n"):
                yaml_body += "\n"

    # Normalize `asset_selection`: comma-joined → ` or `-joined.
    # Parse+re-dump so we don't have to reason about the raw text.
    try:
        doc = _yaml.safe_load(yaml_body) or {}
        if isinstance(doc, dict) and isinstance(doc.get("attributes"), dict):
            doc["attributes"] = dagster_plus_preview_service._normalize_asset_selection(doc["attributes"])
            yaml_body = _yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)
    except Exception as e:
        print(f"[promote] asset_selection normalization errored (non-fatal): {e}")

    slug = _sanitize_folder(draft.component_id)
    target_dir = repo_root / defs_subdir / slug
    target_dir.mkdir(parents=True, exist_ok=True)
    defs_yaml_path = target_dir / "defs.yaml"
    defs_yaml_path.write_text(yaml_body)

    files_written = [str(defs_yaml_path.relative_to(repo_root))]

    # Community-component bootstrap: if the promoted draft references a
    # community-catalog component, ensure the target repo has the
    # `community_component_installer` set up + register the promoted
    # component in its `components:` list. Once the PR merges the
    # deployment's refresh-state will download the community component
    # source automatically — no manual pip install or code copy needed.
    #
    # Skipped when the draft's component isn't in the community catalog
    # (e.g. the customer's own local component); in that case the PR
    # ships only the user's defs.yaml as before.
    installer_extra_files: list[str] = []
    try:
        from . import genie_service as _genie
        _manifest = await _genie.fetch_manifest()
        _catalog_ids = {c.get("id"): c for c in (_manifest.get("components") or [])}
        # A draft's component_type is a Python import path
        # (`<pkg>.components.<id>.<Class>`); the catalog ID appears as
        # one dotted segment. Search from most-specific to least so
        # `parametric_data_generator` beats `data_generator`.
        _matched_catalog_id: str | None = None
        for seg in draft.component_type.split("."):
            if seg in _catalog_ids:
                _matched_catalog_id = seg
                break
        # Don't reference the installer itself in its own components list.
        if _matched_catalog_id and _matched_catalog_id != "community_component_installer":
            installer_extra_files = _ensure_community_installer(
                repo_root=repo_root,
                defs_subdir=defs_subdir,
                catalog_id=_matched_catalog_id,
            )
    except Exception as e:
        print(f"[promote] community installer bootstrap errored (non-fatal): {e}")

    files_written.extend(installer_extra_files)

    # Commit + push. Configure a local user identity per commit so we
    # don't rely on the runner's global git config being set.
    with repo.config_writer() as cfg:
        cfg.set_value("user", "name", "Dagster Designer")
        cfg.set_value("user", "email", "designer@dagsterlabs.com")
    repo.index.add(files_written)
    repo.index.commit(
        f"Add {draft.component_id} ({draft.component_type})\n\n"
        f"Authored via Dagster Designer as a draft against "
        f"{draft.deployment_name or 'default'}/{draft.location_name}."
    )
    repo.remotes.origin.push(branch_name)

    # Pre-PR environment check (design doc §7): look up the promoted
    # component in the manifest, extract its `consumes: ["resource:X"]`
    # entries, and check whether the target deployment actually has
    # those resources configured. Non-blocking — a mismatch surfaces
    # as a warning in the response so the frontend can nudge the user
    # BEFORE the PR merges and blows up on first load.
    project_obj = project_service.get_project(project_id)
    resource_check: Optional[dict] = None
    if project_obj and draft.deployment_name:
        try:
            from . import genie_service as _genie
            manifest = await _genie.fetch_manifest()
            entry = next(
                (c for c in (manifest.get("components") or [])
                 if c.get("component_type") == draft.component_type
                 or c.get("id") == draft.component_type.rsplit(".", 1)[-1]),
                None,
            )
            required = []
            if entry:
                for c in (entry.get("consumes") or []):
                    # consumes entries look like "resource:snowflake" —
                    # split off the "resource:" prefix.
                    if isinstance(c, str) and c.startswith("resource:"):
                        required.append(c.split(":", 1)[1])
            if required:
                resource_check = await dagster_plus_preview_service.check_resources_for_promote(
                    project=project_obj,
                    base_deployment=draft.deployment_name,
                    location_name=draft.location_name,
                    required_services=required,
                )
        except Exception as e:
            print(f"[promote] resource pre-check errored (non-fatal): {e}")

    # Open the PR.
    title = f"[Designer] Add {draft.component_id}"
    body = _pr_body(draft, files_written)
    pr_url = await _open_pr(owner_repo, branch_name, base_branch, title, body)

    # Once the PR is open, the preview state is redundant AND dangerous:
    #   - Redundant: the PR-triggered branch deployment (Dagster+ auto-
    #     creates one on push) will materialize the component from git.
    #   - Dangerous: if we leave the state entry, the location has two
    #     copies of the same component_id at load time — a state-vs-code
    #     conflict that surfaces as a duplicate-definition load error.
    # Best-effort delete + refresh; the promote itself doesn't fail if
    # this call errors.
    project = project_service.get_project(project_id)
    cleared_state: Optional[dict] = None
    if project and draft.deployment_name:
        try:
            cleared_state = await dagster_plus_preview_service.clear_preview_state_for_draft(
                project=project,
                base_deployment=draft.deployment_name,
                location_name=draft.location_name,
                component_id=draft.component_id,
            )
        except Exception as e:
            print(f"[promote] state cleanup errored (non-fatal): {e}")

    # Dagster+ CI names the new branch deployment after the git branch
    # (typical convention — customers can override, but the default is
    # a 1:1 mapping). Surface it so the UI can show "your merged change
    # will appear in BD <name>".
    expected_bd_name = branch_name

    # Mark the draft as promoted so the UI can show a checkmark + PR link.
    update_draft(project_id, draft.id, status="promoted", promoted_pr_url=pr_url)

    return {
        "pr_url": pr_url,
        "branch": branch_name,
        "files_written": files_written,
        "owner_repo": owner_repo,
        "base_branch": base_branch,
        "expected_bd_name": expected_bd_name,
        "cleared_state": cleared_state,
        # When the state-registry component-type differs from the
        # Python import path (Dagster+ prepends the entry-point package
        # name for state), we rewrite the `type:` field before writing
        # to git. Surface it so the UI can note "rewrote type X → Y".
        "rewrote_type": {"from": draft.component_type, "to": rewrote_type} if rewrote_type else None,
        # Pre-promote environment check (design doc §7). `None` when the
        # component declared no `consumes` in the manifest OR when the
        # introspection call failed. Otherwise shaped like
        # {"checked": bool, "matches": [...], "missing": [...]}.
        "resource_check": resource_check,
        # Community-component installer bootstrap. Non-empty when the
        # promoted draft's component was recognized as a community-
        # catalog entry AND we wrote / updated the installer's defs.yaml
        # to include it. Empty when the component isn't in the catalog
        # (nothing to bootstrap) or when bootstrap errored (surfaced as
        # a log warning).
        "installer_files": installer_extra_files,
    }


def _pr_body(draft: Draft, files: list[str]) -> str:
    return (
        f"## Component added via Dagster Designer\n\n"
        f"- **Type:** `{draft.component_type}`\n"
        f"- **Instance id:** `{draft.component_id}`\n"
        f"- **Target location:** `{draft.location_name}`"
        + (f" (deployment `{draft.deployment_name}`)" if draft.deployment_name else "")
        + "\n"
        f"- **Files:** {', '.join(f'`{f}`' for f in files)}\n\n"
        f"### defs.yaml\n\n"
        f"```yaml\n{draft.attributes}\n```\n\n"
        f"---\n"
        f"_Draft authored in [Dagster Designer](https://github.com/dagster-io/dagster) — "
        f"reviewed and shipped through your normal PR workflow._\n"
    )


def promote_available(dagster_plus_org: str, location_name: str) -> Optional[dict]:
    """Introspect the mapping so the frontend can label the Promote
    button (e.g. gray it out when no mapping exists)."""
    m = promotion_config.find_mapping(dagster_plus_org, location_name)
    if not m:
        return None
    return {
        "owner_repo": m.owner_repo,
        "default_branch": m.default_branch,
        "defs_subdir": m.defs_subdir,
        "has_token": bool(promotion_config.get_github_token()),
    }
