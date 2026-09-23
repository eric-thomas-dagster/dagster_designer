"""User-editable promotion configuration.

Stored at `~/.dagster-designer/config/promotion.json` so the demo user
never has to touch env vars. Env vars still work as a fallback for
scripted setups (e.g. someone else's dev box) but the UI-saved config
always wins.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field


CONFIG_PATH = Path.home() / ".dagster-designer" / "config" / "promotion.json"
CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)


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
    if not CONFIG_PATH.exists():
        return PromotionConfig()
    try:
        return PromotionConfig(**json.loads(CONFIG_PATH.read_text()))
    except Exception:
        return PromotionConfig()


def save(config: PromotionConfig) -> None:
    CONFIG_PATH.write_text(json.dumps(config.model_dump(), indent=2))


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
