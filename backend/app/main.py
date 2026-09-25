"""Main FastAPI application."""

# Force UTF-8 stdout/stderr before anything else can print. Windows'
# console defaults to the system code page (cp1252 observed) rather than
# UTF-8, and this codebase prints plenty of emoji (see: nearly every
# print() in project_service.py) -- the first one crashes the whole
# request with UnicodeEncodeError the moment it's hit. Harmless
# everywhere else (already UTF-8 on macOS/Linux).
import sys as _sys
_sys.stdout.reconfigure(encoding="utf-8")
_sys.stderr.reconfigure(encoding="utf-8")

# Load .env early so API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) picked
# up via os.getenv further down get populated. Looks first at DATA_DIR/.env
# (the same persistent location genie.py's /ai/keys endpoint now saves
# to -- see its _ENV_PATH comment for why: a path relative to this file
# resolves inside the packaged app's Resources/backend/, which `tauri
# build` wipes on every rebuild, silently losing a saved API key.
# DATA_DIR is read directly via os.getenv here rather than importing
# app.core.config.settings, since this block intentionally runs before
# that import so the rest of this file's os.getenv() calls see the
# loaded values), then falls back to the old backend-relative and
# repo-root locations for a plain dev checkout with no DATA_DIR set.
# Missing files are OK — environment already-set values take precedence.
import os as _os
from pathlib import Path as _Path
try:
    from dotenv import load_dotenv as _load_dotenv
    _here = _Path(__file__).resolve()
    _candidates = []
    _data_dir_env = _os.getenv("DATA_DIR")
    if _data_dir_env:
        _candidates.append(_Path(_data_dir_env) / ".env")
    _candidates += [_here.parent.parent / ".env", _here.parent.parent.parent / ".env"]
    for _p in _candidates:
        if _p.exists():
            _load_dotenv(_p, override=False)
            print(f"[main] Loaded env from {_p}")
except Exception as _e:  # pragma: no cover
    print(f"[main] dotenv not available: {_e}")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import settings
from .services.telemetry_service import log_designer_action, telemetry_uploader
from .api import components, projects, git, codegen, dagster, files, templates, primitives, dagster_webserver, dbt_adapters, integrations, env_vars, pipelines, templates_registry, dbt_cloud, assets, dependencies, pipeline_templates, genie, alerts, runs, designer_loc, drafts, authored, promotion, preview

# Create FastAPI app
app = FastAPI(
    title=settings.api_title,
    version=settings.api_version,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(components.router, prefix=settings.api_prefix)
app.include_router(projects.router, prefix=settings.api_prefix)
app.include_router(git.router, prefix=settings.api_prefix)
app.include_router(codegen.router, prefix=settings.api_prefix)
app.include_router(dagster.router, prefix=settings.api_prefix)  # New: Dagster CLI integration
app.include_router(files.router, prefix=settings.api_prefix)  # New: File operations
app.include_router(templates.router, prefix=settings.api_prefix)  # New: Template generation
app.include_router(primitives.router, prefix=settings.api_prefix)  # New: Primitives management
app.include_router(dagster_webserver.router, prefix=settings.api_prefix)  # New: Dagster UI management
app.include_router(dbt_adapters.router, prefix=settings.api_prefix)  # New: DBT adapter management
app.include_router(integrations.router, prefix=settings.api_prefix)  # New: Integration management
app.include_router(env_vars.router, prefix=settings.api_prefix)  # New: Environment variable management
app.include_router(pipelines.router, prefix=settings.api_prefix)  # New: Pipeline builder
app.include_router(templates_registry.router, prefix=settings.api_prefix)  # New: Community component templates
app.include_router(dbt_cloud.router, prefix=settings.api_prefix)  # New: dbt Cloud integration
app.include_router(assets.router, prefix=settings.api_prefix)  # New: Asset operations
app.include_router(dependencies.router, prefix=settings.api_prefix)  # New: Dependency management
app.include_router(pipeline_templates.router, prefix=settings.api_prefix)  # New: Pipeline templates
app.include_router(genie.router, prefix=settings.api_prefix)  # New: Genie NL planner
app.include_router(alerts.router, prefix=settings.api_prefix)  # New: Alert policies (Dagster+)
app.include_router(runs.router, prefix=settings.api_prefix)  # New: Runs history (local dagster dev + Dagster+)
app.include_router(designer_loc.router, prefix=settings.api_prefix)  # New: Designer-managed code location subprocess
app.include_router(drafts.router, prefix=settings.api_prefix)  # New: Draft components (pending PR promotion)
app.include_router(authored.router, prefix=settings.api_prefix)  # New: Locations + component types for authoring
app.include_router(promotion.router, prefix=settings.api_prefix)  # New: Promotion config (GitHub token + repo mappings)
app.include_router(preview.router, prefix=settings.api_prefix)  # New: Preview (git-backed sandbox worktree for M6)


@app.on_event("startup")
async def _startup_telemetry():
    # Starts the same upload thread dagster-daemon uses, so queued
    # telemetry (ours + any dg dev subprocess's, sharing ~/.dagster/logs/)
    # actually ships instead of just accumulating on disk.
    telemetry_uploader.start()
    log_designer_action("designer_app_launched", {"api_version": settings.api_version})


@app.on_event("shutdown")
async def _shutdown_telemetry():
    telemetry_uploader.stop()


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": settings.api_title,
        "version": settings.api_version,
        "status": "running",
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy"}
