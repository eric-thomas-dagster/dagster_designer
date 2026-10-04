"""User-editable promotion configuration.

Stored at `~/.dagster-designer/config/promotion.json` so the demo user
never has to touch env vars. Env vars still work as a fallback for
scripted setups (e.g. someone else's dev box) but the UI-saved config
always wins.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field


CONFIG_PATH = Path.home() / ".dagster-designer" / "config" / "promotion.json"
CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

# This one file holds the GitHub token AND every (org, location) -> repo
# mapping for the whole app -- a lost-or-corrupted write here is worse
# than the per-project drafts case (drafts_service.py has the same
# fix), since it's shared and holds a credential. A single lock is
# enough since there's exactly one file, not one per project.
_lock = threading.Lock()


class RepoMapping(BaseModel):
    """One (org, location) -> repo binding."""
    org: str
    location: str
    owner_repo: str
    default_branch: str = "main"
    defs_subdir: str
    # Env vars injected into the `dagster dev` subprocess when this
    # location is previewed on the laptop. Customer supplies non-prod
    # values (dev warehouse creds, staging DB URL, sandbox S3 bucket,
    # etc.). If empty, preview boots with just Designer's own env —
    # `dg.EnvVar` lookups will fail loudly, which is the safe outcome.
    preview_env: dict[str, str] = Field(default_factory=dict)


class PromotionConfig(BaseModel):
    github_token: str = ""
    mappings: list[RepoMapping] = Field(default_factory=list)


# Hardcoded fallback so a fresh Designer install still works against
# hooli out of the box (only need a token). Users can edit or add to
# this via the UI; edits are stored to the file and take precedence.
_HARDCODED_DEFAULTS: list[RepoMapping] = [
    RepoMapping(
        org="hooli",
        location="data-eng-pipeline",
        owner_repo="dagster-io/hooli-data-eng-pipelines",
        default_branch="master",
        defs_subdir="hooli_data_eng/hooli_data_eng/defs",
    ),
]


def load() -> PromotionConfig:
    """Read the on-disk config, falling back to an empty shell."""
    with _lock:
        if not CONFIG_PATH.exists():
            return PromotionConfig()
        try:
            return PromotionConfig(**json.loads(CONFIG_PATH.read_text()))
        except Exception as e:
            # Silently falling back to an empty config here used to mean
            # a corrupt file (a truncated write from a crash mid-save) read
            # back as "nothing configured" -- and the NEXT save() would
            # overwrite it with whatever the UI had at that moment,
            # permanently losing the GitHub token and every repo mapping
            # with no error ever surfaced. Archive the unreadable file
            # instead of silently discarding it.
            try:
                bad_path = CONFIG_PATH.with_suffix(f".corrupt-{int(time.time())}.json")
                CONFIG_PATH.rename(bad_path)
                print(f"[promotion_config] {CONFIG_PATH} failed to parse ({e}); archived as {bad_path}")
            except Exception as archive_err:
                print(f"[promotion_config] {CONFIG_PATH} failed to parse ({e}); could not archive it either: {archive_err}")
            return PromotionConfig()


def save(config: PromotionConfig) -> None:
    # Atomic: write to a sibling temp file and rename over the real path,
    # so a crash or kill signal mid-write can never leave a half-written,
    # unparseable config behind (see load()'s corruption handling above).
    with _lock:
        tmp_path = CONFIG_PATH.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(config.model_dump(), indent=2))
        os.replace(tmp_path, CONFIG_PATH)


def get_github_token() -> str:
    """Resolve the token: UI config > env var. Empty string if neither set."""
    cfg = load()
    if cfg.github_token:
        return cfg.github_token
    return os.getenv("DAGSTER_DESIGNER_GITHUB_TOKEN", "").strip()


def find_mapping(org: str, location: str) -> Optional[RepoMapping]:
    """Resolve the target repo for (org, location).

    Order:
      1. User-saved config
      2. Env-var overrides (kept for scripted setups)
      3. Hardcoded defaults (hooli)

    Org comparison is case-insensitive: Dagster+'s GraphQL returns the
    org's display name (e.g. "Hooli"), but mappings are naturally typed
    in lowercase (matching the org slug used everywhere else, e.g. in
    URLs) -- an exact-match compare here silently failed to resolve
    even the hardcoded hooli default. Location names are real Dagster
    code-location names, which ARE case-sensitive, so those still
    compare exactly.
    """
    org_lower = org.lower()
    cfg = load()
    for m in cfg.mappings:
        if m.org.lower() == org_lower and m.location == location:
            return m

    # Env-var single-mapping override.
    env_repo = os.getenv("DAGSTER_DESIGNER_PROMOTE_REPO")
    if env_repo:
        return RepoMapping(
            org=org,
            location=location,
            owner_repo=env_repo,
            default_branch=os.getenv("DAGSTER_DESIGNER_PROMOTE_BASE", "main"),
            defs_subdir=os.getenv("DAGSTER_DESIGNER_PROMOTE_DEFS_SUBDIR", ""),
        )

    for m in _HARDCODED_DEFAULTS:
        if m.org.lower() == org_lower and m.location == location:
            return m
    return None


def masked_config() -> dict:
    """Config for the UI — token replaced with a masked preview."""
    cfg = load()
    tok = cfg.github_token
    masked = ""
    if tok:
        masked = tok[:4] + "…" + tok[-4:] if len(tok) > 10 else "•" * len(tok)
    return {
        "github_token_preview": masked,
        "github_token_present": bool(tok or os.getenv("DAGSTER_DESIGNER_GITHUB_TOKEN")),
        "mappings": [m.model_dump() for m in cfg.mappings],
        "defaults": [m.model_dump() for m in _HARDCODED_DEFAULTS],
    }
