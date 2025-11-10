"""Main FastAPI application."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import settings
from .api import components, projects, git, codegen, dagster, files, templates, primitives, dagster_webserver, dbt_adapters, integrations, env_vars, pipelines, templates_registry

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
