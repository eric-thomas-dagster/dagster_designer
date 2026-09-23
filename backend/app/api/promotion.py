"""REST endpoints for the promotion config UI.

The GitHub token + per-(org,location) repo mappings are user-editable
via the Designer UI so no env-var setup is required for the demo.
Storage: `~/.dagster-designer/config/promotion.json`.
"""

import base64

import re

import httpx
import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services import drafts_service, promotion_config


router = APIRouter(prefix="/promotion", tags=["promotion"])


class SaveConfigBody(BaseModel):
    """Full-replace save. The UI always sends the complete config back
    so we don't need per-field patch semantics for the demo."""
    # Pass an empty string to keep the previously-saved token
    # (the UI never round-trips the raw token, only a masked preview).
    # Pass "__CLEAR__" to explicitly wipe the token.
    github_token: str = ""
    mappings: list[promotion_config.RepoMapping] = []


class TestTokenBody(BaseModel):
    """If `github_token` is empty, the saved token is used. Otherwise the
    provided one is tested without saving — so the UI can validate before
    persisting."""
    github_token: str = ""
    # Optional: if provided, additionally probe `GET /repos/<owner_repo>`
    # to confirm the token can actually reach the mapped repo. Required
    # for fine-grained PATs (which don't populate X-OAuth-Scopes).
    owner_repos: list[str] = []


class PRStatusBody(BaseModel):
    """Refresh live GitHub state for each promoted draft in a project.
    Designer stores `status: 'promoted' + pr_url` locally but has no way
    to know when the PR closes or merges — so the button lies unless we
    check GitHub explicitly."""
    project_id: str


class ResolveDefsSubdirBody(BaseModel):
    """Scan a repo's file tree and suggest likely `defs_subdir` candidates.

    Called from the settings modal so users don't have to guess the
    exact repo layout (the source of the "PR went to a path GitHub
    Actions doesn't watch" failure mode)."""
    owner_repo: str                     # e.g. "dagster-io/hooli-data-eng-pipelines"
    ref: str = "main"                   # branch, tag, or SHA
    location_name: str = ""             # boost candidates whose ancestor matches this


class ValidateDefsSubdirBody(BaseModel):
    """Check that a proposed `defs_subdir` actually exists on the target
    branch. Used at save-time so the user gets an inline warning instead
    of a silent no-op after promoting."""
    owner_repo: str
    ref: str = "main"
    defs_subdir: str


@router.get("/config")
async def get_config():
    return promotion_config.masked_config()


@router.put("/config")
async def save_config(body: SaveConfigBody):
    current = promotion_config.load()
    if body.github_token == "__CLEAR__":
        new_token = ""
    elif body.github_token:
        new_token = body.github_token
    else:
        # Empty string → preserve existing token (masked UI path).
        new_token = current.github_token
    updated = promotion_config.PromotionConfig(
        github_token=new_token,
        mappings=body.mappings,
    )
    try:
        promotion_config.save(updated)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save config: {e}")
    return promotion_config.masked_config()


@router.post("/test-token")
async def test_token(body: TestTokenBody):
    """Validate a GitHub PAT without saving.

    Returns:
      - `valid`: token authenticates as some user
      - `login`, `name`: identity from `GET /user`
      - `scopes`: granted OAuth scopes (empty for fine-grained PATs)
      - `has_repo_scope`: classic PAT with `repo` (true = both flows work)
      - `repos`: per-mapping probe results — needed for fine-grained PATs
        or to catch mapping typos (repo doesn't exist / no access)
      - `ok_for_promote`: single-line verdict — has both auth + write
        access to at least one configured repo

    Uses the unsaved candidate token if provided, otherwise falls back to
    the saved one. Never persists anything."""
    token = body.github_token or promotion_config.load().github_token
    if not token:
        raise HTTPException(status_code=400, detail="No token to test (nothing provided and nothing saved).")

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        # Identity + scopes
        try:
            r = await client.get("https://api.github.com/user", headers=headers)
        except httpx.HTTPError as e:
            return {"valid": False, "message": f"Network error contacting GitHub: {e}"}

        if r.status_code == 401:
            return {"valid": False, "message": "GitHub rejected the token (401). Expired or wrong value?"}
        if r.status_code >= 400:
            return {"valid": False, "message": f"GitHub returned {r.status_code}: {r.text[:200]}"}

        user = r.json()
        scopes_header = r.headers.get("X-OAuth-Scopes", "") or ""
        scopes = [s.strip() for s in scopes_header.split(",") if s.strip()]
        has_repo_scope = "repo" in scopes

        # Per-repo probe. For fine-grained PATs (empty scopes) this is
        # the only way to know the token can reach the target repo.
        # Also useful for classic PATs to catch mapping typos.
        repo_results = []
        for owner_repo in body.owner_repos:
            if not owner_repo or "/" not in owner_repo:
                repo_results.append({"owner_repo": owner_repo, "ok": False, "reason": "invalid mapping"})
                continue
            try:
                rr = await client.get(f"https://api.github.com/repos/{owner_repo}", headers=headers)
            except httpx.HTTPError as e:
                repo_results.append({"owner_repo": owner_repo, "ok": False, "reason": f"network: {e}"})
                continue
            if rr.status_code == 200:
                perms = (rr.json().get("permissions") or {})
                # `push` is what we need to open a PR + push a branch.
                can_push = bool(perms.get("push")) or bool(perms.get("admin"))
                repo_results.append({
                    "owner_repo": owner_repo,
                    "ok": True,
                    "can_push": can_push,
                    "reason": None if can_push else "token can read but not push — need write access",
                })
            elif rr.status_code == 404:
                repo_results.append({"owner_repo": owner_repo, "ok": False, "reason": "not found / no access"})
            else:
                repo_results.append({"owner_repo": owner_repo, "ok": False, "reason": f"HTTP {rr.status_code}"})

    any_repo_writable = any(r.get("ok") and r.get("can_push") for r in repo_results)
    ok_for_promote = has_repo_scope or any_repo_writable

    return {
        "valid": True,
        "login": user.get("login"),
        "name": user.get("name"),
        "scopes": scopes,
        "has_repo_scope": has_repo_scope,
        "repos": repo_results,
        "ok_for_promote": ok_for_promote,
        "message": (
            "Token authenticates and has classic `repo` scope — clone + promote will work."
            if has_repo_scope else
            ("Fine-grained PAT with per-repo write access verified." if any_repo_writable else
             "Token authenticates but doesn't have write access to any configured repo. Grant `repo` scope (classic PAT) or add the repos to the fine-grained PAT's contents permission.")
        ),
    }


# --- defs_subdir resolution -------------------------------------------------

_TREE_NOISE_PREFIXES = ("node_modules/", ".venv/", "venv/", "__pycache__/", ".git/", "dist/", "build/", ".tox/", ".pytest_cache/", ".mypy_cache/")


def _score_defs_candidate(path: str, location_name: str) -> tuple[int, str]:
    """Rank a candidate `<...>/defs` path against a location name.

    Higher = better. Reason string is user-visible: it explains why
    Designer picked this path so the user can sanity-check the pick
    before saving.

    Heuristics (in order of contribution):
      - Matches location name as a segment (dashed OR underscored form)
      - Sits under a `src/` layer (canonical modern Dagster layout)
      - Has `pyproject.toml` nearby (indicates a Python package root)
      - Fewer path segments = more likely to be the intended defs root
    """
    if not path.endswith("/defs"):
        return 0, ""
    score = 0
    reasons: list[str] = []
    segments = path.split("/")
    loc_dashed = location_name
    loc_under = location_name.replace("-", "_")

    if location_name and (loc_dashed in segments or loc_under in segments):
        score += 100
        reasons.append(f"path contains `{location_name}` (dashed) or `{loc_under}` (underscored)")
    if "src" in segments:
        score += 30
        reasons.append("uses `src/` layout")
    # Prefer shorter paths — top-level defs folders are more likely to be
    # the location's canonical defs root than deeply-nested ones.
    score += max(0, 20 - len(segments))
    return score, "; ".join(reasons) if reasons else "generic /defs directory"


async def _read_dagster_cloud_yaml(client: httpx.AsyncClient, owner_repo: str, ref: str, headers: dict) -> dict | None:
    """Fetch and parse the repo's `dagster_cloud.yaml` (if present).

    That file is authoritative for `location_name → build.directory`,
    so we can go straight to the correct location root instead of
    guessing. Returns None if the file doesn't exist or can't be parsed
    — resolver falls back to tree scoring."""
    try:
        r = await client.get(
            f"https://api.github.com/repos/{owner_repo}/contents/dagster_cloud.yaml",
            headers=headers,
            params={"ref": ref},
        )
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    body = r.json()
    if not isinstance(body, dict) or body.get("encoding") != "base64":
        return None
    try:
        raw = base64.b64decode(body["content"]).decode("utf-8", errors="replace")
        return yaml.safe_load(raw)
    except Exception:
        return None


def _build_directory_for_location(cloud_cfg: dict, location_name: str) -> str | None:
    """Given the parsed dagster_cloud.yaml, find the build.directory for
    a location. Returns e.g. `./hooli-data-eng` — the location's package
    root at the top level of the repo."""
    for loc in (cloud_cfg or {}).get("locations", []) or []:
        if loc.get("location_name") == location_name:
            build_dir = ((loc.get("build") or {}).get("directory") or "").strip()
            if not build_dir:
                return None
            # Normalize leading "./" and trailing "/"
            build_dir = build_dir.lstrip("./").rstrip("/")
            return build_dir
    return None


@router.post("/resolve-defs-subdir")
async def resolve_defs_subdir(body: ResolveDefsSubdirBody):
    """Scan the target repo's file tree and return likely `defs_subdir`
    candidates ranked by heuristic.

    The user often can't guess this correctly — the repo may use a
    dashed/underscored/src-nested layout that doesn't match the Python
    module path Designer sees in `componentType`. Wrong path = PR opens
    to a location that GitHub Actions' path filters ignore = empty BD.

    Two-tier resolution:
      1. Read `dagster_cloud.yaml` (authoritative): if the file lists
         a `build.directory` for the location, promote candidates under
         that directory to the top of the list.
      2. Tree scoring: fall back to `**/defs/` search + heuristic
         scoring against the location name."""
    tok = promotion_config.load().github_token
    if not tok:
        raise HTTPException(status_code=400, detail="Configure a GitHub token first (needed to read the target repo's tree).")
    if "/" not in body.owner_repo:
        raise HTTPException(status_code=400, detail="owner_repo must be `owner/name`.")

    headers = {
        "Authorization": f"Bearer {tok}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    async with httpx.AsyncClient(timeout=20) as client:
        # 0. Try dagster_cloud.yaml — authoritative when present.
        cloud_cfg = await _read_dagster_cloud_yaml(client, body.owner_repo, body.ref, headers)
        authoritative_build_dir: str | None = None
        if cloud_cfg and body.location_name:
            authoritative_build_dir = _build_directory_for_location(cloud_cfg, body.location_name)

        # 1. Resolve ref → tree SHA (branches API is the cheap path).
        try:
            br = await client.get(f"https://api.github.com/repos/{body.owner_repo}/branches/{body.ref}", headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Contacting GitHub: {e}")
        if br.status_code == 404:
            return {"candidates": [], "message": f"Branch `{body.ref}` not found in {body.owner_repo}."}
        if br.status_code >= 400:
            return {"candidates": [], "message": f"GitHub returned {br.status_code}: {br.text[:200]}"}
        tree_sha = ((br.json().get("commit") or {}).get("commit") or {}).get("tree", {}).get("sha") or br.json().get("commit", {}).get("sha")
        if not tree_sha:
            return {"candidates": [], "message": "Could not resolve tree SHA from branch response."}

        # 2. Fetch the recursive tree.
        try:
            tr = await client.get(f"https://api.github.com/repos/{body.owner_repo}/git/trees/{tree_sha}?recursive=1", headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Fetching tree: {e}")
        if tr.status_code >= 400:
            return {"candidates": [], "message": f"Tree fetch returned {tr.status_code}: {tr.text[:200]}"}
        payload = tr.json()
        truncated = bool(payload.get("truncated"))

    entries = payload.get("tree") or []
    candidates: list[dict] = []
    seen: set[str] = set()
    for entry in entries:
        if entry.get("type") != "tree":
            continue
        path = entry.get("path") or ""
        if any(path.startswith(pref) or f"/{pref}" in path for pref in _TREE_NOISE_PREFIXES):
            continue
        if not path.endswith("/defs") and path != "defs":
            continue
        if path in seen:
            continue
        seen.add(path)
        score, reason = _score_defs_candidate(path, body.location_name)
        # Massive boost when the candidate sits under the location's
        # authoritative build.directory — that's the definitive signal
        # GitHub Actions' path filters will match.
        if authoritative_build_dir and path.startswith(authoritative_build_dir + "/"):
            score += 500
            reason = (
                f"under `build.directory: {authoritative_build_dir}` from `dagster_cloud.yaml` "
                f"(authoritative for `{body.location_name}`)"
            )
        candidates.append({"path": path, "score": score, "reason": reason})

    candidates.sort(key=lambda c: -c["score"])
    top = candidates[:8]

    msg_parts = [f"Found {len(candidates)} `/defs` director{'y' if len(candidates)==1 else 'ies'} in {body.owner_repo}@{body.ref}"]
    if authoritative_build_dir:
        msg_parts.append(f"`dagster_cloud.yaml` maps `{body.location_name}` → `{authoritative_build_dir}` — top candidate uses that as anchor.")
    if truncated:
        msg_parts.append("Repo tree was truncated; deeper paths may not be listed.")

    return {
        "candidates": top,
        "total_scanned": len(entries),
        "truncated": truncated,
        "authoritative_build_dir": authoritative_build_dir,
        "message": " ".join(msg_parts),
    }


@router.post("/validate-defs-subdir")
async def validate_defs_subdir(body: ValidateDefsSubdirBody):
    """Confirm that `defs_subdir` exists as a directory on the target
    branch. Called at save-time so users get an inline warning instead
    of a silent no-op after they promote."""
    tok = promotion_config.load().github_token
    if not tok:
        return {"exists": None, "message": "No GitHub token — skipping path check."}
    if "/" not in body.owner_repo or not body.defs_subdir:
        return {"exists": None, "message": "Need both owner_repo and defs_subdir."}

    headers = {
        "Authorization": f"Bearer {tok}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    path = body.defs_subdir.strip().strip("/")
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            r = await client.get(
                f"https://api.github.com/repos/{body.owner_repo}/contents/{path}",
                headers=headers,
                params={"ref": body.ref},
            )
        except httpx.HTTPError as e:
            return {"exists": None, "message": f"Network error: {e}"}
    if r.status_code == 404:
        return {"exists": False, "is_dir": False, "message": f"`{path}` does not exist on branch `{body.ref}`. Promoted PRs will land in a folder GitHub Actions can't see, so no code location will deploy."}
    if r.status_code >= 400:
        return {"exists": None, "message": f"GitHub returned {r.status_code}: {r.text[:200]}"}
    j = r.json()
    is_dir = isinstance(j, list)   # GitHub returns a list for dirs, object for files
    if not is_dir:
        return {"exists": True, "is_dir": False, "message": f"`{path}` exists on `{body.ref}` but is a file, not a directory. `defs_subdir` should be a folder."}
    return {"exists": True, "is_dir": True, "message": f"`{path}` exists as a directory on `{body.ref}` — promoted PRs will land here."}


# --- PR live state ----------------------------------------------------------

_PR_URL_RE = re.compile(r"^https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)$")


def _parse_pr_url(url: str) -> tuple[str, str, int] | None:
    m = _PR_URL_RE.match(url.strip())
    if not m:
        return None
    return m.group(1), m.group(2), int(m.group(3))


@router.post("/pr-status")
async def pr_status(body: PRStatusBody):
    """For every draft in the project with `status='promoted'` + a
    `promoted_pr_url`, ask GitHub whether the PR is still open, closed,
    or merged. Returns a `{draft_id → {state, merged, ...}}` map the
    Drafts panel uses to render live state — otherwise the "Open PR"
    button lies once the PR is closed on GitHub."""
    tok = promotion_config.load().github_token
    if not tok:
        return {"statuses": {}, "message": "No GitHub token — skipping live check."}

    drafts = drafts_service.list_drafts(body.project_id)
    targets = [d for d in drafts if d.status == "promoted" and d.promoted_pr_url]
    if not targets:
        return {"statuses": {}, "message": "No promoted drafts to check."}

    headers = {
        "Authorization": f"Bearer {tok}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    out: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=15) as client:
        for d in targets:
            parsed = _parse_pr_url(d.promoted_pr_url or "")
            if not parsed:
                out[d.id] = {"state": "unknown", "message": f"Could not parse PR URL: {d.promoted_pr_url}"}
                continue
            owner, repo, num = parsed
            try:
                r = await client.get(
                    f"https://api.github.com/repos/{owner}/{repo}/pulls/{num}",
                    headers=headers,
                )
            except httpx.HTTPError as e:
                out[d.id] = {"state": "unknown", "message": f"Network error: {e}"}
                continue
            if r.status_code == 404:
                out[d.id] = {"state": "deleted", "message": "PR no longer exists (deleted or moved)."}
                continue
            if r.status_code >= 400:
                out[d.id] = {"state": "unknown", "message": f"GitHub returned {r.status_code}"}
                continue
            j = r.json()
            merged = bool(j.get("merged_at"))
            gh_state = j.get("state")  # "open" | "closed"
            effective = "merged" if merged else gh_state
            out[d.id] = {
                "state": effective,
                "merged": merged,
                "merged_at": j.get("merged_at"),
                "closed_at": j.get("closed_at"),
                "head_sha": (j.get("head") or {}).get("sha"),
                "base_ref": (j.get("base") or {}).get("ref"),
                "message": {
                    "open": "PR is open — merge to land the component.",
                    "closed": "PR was closed without merging. Re-promote to open a fresh one.",
                    "merged": "PR merged — component is now in the target branch.",
                }.get(effective, ""),
            }
    return {"statuses": out}
