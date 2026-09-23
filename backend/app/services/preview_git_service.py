"""Git service for the preview flow.

Manages a per-(project, deployment) working clone of the customer's
repo — used to boot a laptop `dagster dev` (M6.2) against real
customer code with sandbox env vars, so authoring surfaces produce a
real runtime instead of pretend previews.

Storage layout:
  ~/.dagster-designer/data/preview-clones/<owner>__<repo>/  ← shared bare-ish clone per repo
  ~/.dagster-designer/data/preview-worktrees/<project_id>/<deployment>/  ← per-preview worktrees

Worktrees let us keep the base clone up-to-date while running one or
more independent previews without stomping on each other. They share
git objects with the base clone, so worktree creation is nearly free
after the first fetch.

For promotion the existing `promotion_service._ensure_clone` still owns
its own cache — different concurrency profile (short-lived, mutating a
branch we push, then done). Preview is longer-lived and only ever
writes locally.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

from git import Repo, GitCommandError

from ..core.config import settings
from . import promotion_config
from .drafts_service import Draft


# --- storage roots -----------------------------------------------------------

def _clones_root() -> Path:
    root = settings.data_dir / "preview-clones"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _worktrees_root() -> Path:
    root = settings.data_dir / "preview-worktrees"
    root.mkdir(parents=True, exist_ok=True)
    return root


# --- helpers -----------------------------------------------------------------

def _sanitize_folder(component_id: str) -> str:
    """Same slug logic promotion uses — keep the on-disk layout
    identical between preview and promote so a promoted PR touches
    the exact files the user previewed."""
    out = []
    for ch in component_id.lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in ("_", "-"):
            out.append(ch)
        elif ch in ("[", "]", " "):
            out.append("_")
    return "".join(out).strip("_") or "component"


def _authenticated_url(owner_repo: str, token: str) -> str:
    return f"https://{token}@github.com/{owner_repo}.git"


# --- clone management --------------------------------------------------------

def get_or_refresh_clone(owner_repo: str, base_branch: str) -> Repo:
    """Return a Repo pointed at a fresh checkout of `base_branch`.

    Reuses a cached clone across sessions; fetches on every call so
    we don't preview stale code. Nuke + re-clone if the cache is
    corrupt (stale ref, upstream force-push, etc.)."""
    token = promotion_config.get_github_token()
    if not token:
        raise RuntimeError(
            "No GitHub token configured. Open the Drafts drawer settings "
            "to add a PAT with repo scope."
        )

    clone_name = owner_repo.replace("/", "__")
    clone_path = _clones_root() / clone_name

    if clone_path.exists() and (clone_path / ".git").exists():
        try:
            repo = Repo(clone_path)
            # Fetch fresh + reset base branch to origin's tip. Any
            # existing worktrees keep pointing at their commits (git
            # worktree references are stable).
            repo.git.fetch("origin", base_branch, "--prune")
            # Move to base branch if we're not there; hard-reset to origin's tip.
            repo.git.checkout(base_branch)
            repo.git.reset("--hard", f"origin/{base_branch}")
            return repo
        except GitCommandError:
            # Corrupt / stale — start over.
            shutil.rmtree(clone_path, ignore_errors=True)

    url = _authenticated_url(owner_repo, token)
    return Repo.clone_from(url, clone_path, branch=base_branch)


# --- worktree management -----------------------------------------------------

def worktree_path_for(project_id: str, deployment_name: str) -> Path:
    return _worktrees_root() / project_id / _sanitize_folder(deployment_name)


def ensure_worktree(project_id: str, owner_repo: str, base_branch: str, deployment_name: str) -> Path:
    """Create-or-refresh a worktree for a specific (project, deployment).

    The worktree checks out a *preview branch* forked from `base_branch`.
    Each preview session gets a stable local branch name — so restarting
    a preview reuses the same worktree without redoing anything expensive.
    The preview branch is never pushed anywhere; drafts land as
    working-tree writes on top of it."""
    repo = get_or_refresh_clone(owner_repo, base_branch)
    target = worktree_path_for(project_id, deployment_name)
    preview_branch = f"designer/preview/{project_id[:8]}-{_sanitize_folder(deployment_name)}"

    # Existing worktree? Recycle if it points at the right dir.
    existing = _find_worktree(repo, target)
    if existing:
        wt_repo = Repo(target)
        try:
            wt_repo.git.checkout(preview_branch)
        except GitCommandError:
            # Preview branch was deleted / renamed under us — recreate it.
            wt_repo.git.checkout("-B", preview_branch, f"origin/{base_branch}")
        # Reset any prior draft-file writes back to the base branch tip.
        wt_repo.git.reset("--hard", f"origin/{base_branch}")
        return target

    # Fresh worktree. Delete first if a stray dir exists but git doesn't know about it.
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)

    # `git worktree add` refuses to check out a branch that's already
    # checked out elsewhere — using `-B` forces a fresh local branch.
    try:
        repo.git.worktree("add", "-B", preview_branch, str(target), f"origin/{base_branch}")
    except GitCommandError as e:
        raise RuntimeError(f"Failed to create worktree at {target}: {e}")
    return target


def _find_worktree(repo: Repo, path: Path) -> Optional[str]:
    """Return the worktree's HEAD sha if git already tracks this path,
    else None. `git worktree list --porcelain` is the reliable
    detection surface."""
    try:
        out = repo.git.worktree("list", "--porcelain")
    except GitCommandError:
        return None
    current: dict[str, str] = {}
    for line in out.splitlines() + [""]:
        if not line.strip():
            if current.get("worktree") == str(path):
                return current.get("HEAD") or ""
            current = {}
            continue
        if " " in line:
            key, val = line.split(" ", 1)
            current[key] = val
    return None


def remove_worktree(project_id: str, owner_repo: str, base_branch: str, deployment_name: str) -> None:
    """Explicit teardown — used when the user closes a preview session
    or wants to reset from scratch."""
    target = worktree_path_for(project_id, deployment_name)
    if not target.exists():
        return
    try:
        repo = get_or_refresh_clone(owner_repo, base_branch)
        repo.git.worktree("remove", "--force", str(target))
    except Exception:
        # Worst case: nuke the dir. git will recover on next
        # `worktree list` prune.
        shutil.rmtree(target, ignore_errors=True)


# --- draft application -------------------------------------------------------

def apply_drafts(worktree: Path, defs_subdir: str, drafts: list[Draft]) -> list[str]:
    """Write each draft as `<defs_subdir>/<slug>/defs.yaml` in the
    worktree. Returns paths (relative to the worktree) so callers can
    surface a diff / confirm."""
    written: list[str] = []
    for d in drafts:
        slug = _sanitize_folder(d.component_id)
        target_dir = worktree / defs_subdir / slug
        target_dir.mkdir(parents=True, exist_ok=True)
        defs_yaml = target_dir / "defs.yaml"
        defs_yaml.write_text(d.attributes)
        written.append(str(defs_yaml.relative_to(worktree)))
    return written


# --- convenience for the API layer ------------------------------------------

def prepare_preview(
    project_id: str,
    owner_repo: str,
    base_branch: str,
    deployment_name: str,
    defs_subdir: str,
    drafts: list[Draft],
) -> dict:
    """One-shot: ensure clone + worktree + apply drafts.

    Returns the worktree path + a summary of what got written. Callers
    (M6.2 sandbox lifecycle) take this path and boot `dagster dev` on
    top of it."""
    worktree = ensure_worktree(project_id, owner_repo, base_branch, deployment_name)
    files = apply_drafts(worktree, defs_subdir, drafts)
    return {
        "worktree_path": str(worktree),
        "base_branch": base_branch,
        "files_written": files,
        "draft_count": len(drafts),
    }
