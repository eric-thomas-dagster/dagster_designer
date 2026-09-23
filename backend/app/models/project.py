from pydantic import BaseModel, Field
from datetime import datetime
from .graph import PipelineGraph
from .component import ComponentInstance


class CustomLineageEdge(BaseModel):
    """A custom lineage relationship between assets."""

    source: str = Field(..., description="Source asset key")
    target: str = Field(..., description="Target asset key")


class Project(BaseModel):
    """A pipeline project."""

    id: str = Field(..., description="Unique project ID")
    name: str = Field(..., description="Project name")
    description: str | None = Field(None, description="Project description")
    directory_name: str | None = Field(None, description="Directory name for the project (sanitized for Python identifiers)")
    graph: PipelineGraph = Field(default_factory=PipelineGraph, description="Pipeline graph (assets and 1:1 components)")
    components: list[ComponentInstance] = Field(default_factory=list, description="Component instances (particularly asset factories)")
    custom_lineage: list[CustomLineageEdge] = Field(default_factory=list, description="Custom lineage edges drawn by user")
    # Asset keys the user explicitly marked as ingestion sources. The
    # Ingestions tab's automatic detection is a heuristic (component_type
    # substrings locally, computeKind/description/no-upstream sniffing for
    # cloud) and misses assets it has no signal for -- e.g. a plain Python
    # asset that calls a REST API and writes to Snowflake looks identical
    # to any other transformation. This override always surfaces the
    # asset regardless of what the heuristic decides, for both local and
    # cloud projects.
    manual_ingestion_asset_keys: list[str] = Field(default_factory=list, description="Asset keys manually tagged as ingestion sources, overriding the automatic heuristic")
    discovered_primitives: dict = Field(default_factory=dict, description="Discovered schedules/sensors/jobs from dg list defs")
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    git_repo: str | None = Field(None, description="Git repository URL")
    git_branch: str = Field("main", description="Git branch")
    is_imported: bool = Field(False, description="Whether this project was imported from an existing codebase")
    dagster_package_subdir: str | None = Field(None, description="Subdirectory containing the Dagster package (pyproject.toml) for imported projects")
    # Dagster+ (cloud) connection — set when the project is a live
    # connection to a Dagster+ deployment rather than a local Dagster
    # codebase. When is_dagster_plus is True, the tabs pull data via
    # the GraphQL API instead of scanning local files.
    is_dagster_plus: bool = Field(False, description="Whether this project is a Dagster+ cloud connection")
    dagster_plus_org: str | None = Field(None, description="Dagster+ organization name (subdomain)")
    # Dagster+ hosts orgs (and the MCP server, and agents) under two
    # region domains: `dagster.cloud` (US) and `eu.dagster.cloud` (EU) --
    # the same distinction `dg plus login --region us|eu` makes. Every
    # GraphQL call and "Open in Dagster+" deep link needs this to hit the
    # right host, so it's set once at connect time (default 'us') rather
    # than guessed from the org name, which carries no region signal.
    dagster_plus_region: str = Field("us", description="Dagster+ region: 'us' or 'eu'")
    dagster_plus_deployment: str | None = Field("prod", description="Dagster+ deployment name — usually 'prod'")
    dagster_plus_token: str | None = Field(None, description="Dagster+ user token; NEVER returned to the frontend, only used server-side")
    dagster_plus_location: str | None = Field(None, description="Optional Dagster+ code location filter")
    # Ephemeral — set in-memory when a cloud hydrate fails, never persisted
    # to disk (callers that set it never call _save_project afterward, so
    # it's naturally cleared on the next fresh load from disk). Lets the
    # frontend show why project.graph might be stale/empty instead of
    # silently showing nothing.
    dagster_plus_last_error: str | None = Field(None, description="Last Dagster+ hydrate error, if any (not persisted)")

    # Persisted (set + saved by _hydrate_cloud_graph). Lets callers that
    # don't need up-to-the-second data — e.g. navigating to the dbt tab
    # moments after the project itself was just loaded/hydrated — skip
    # re-running the expensive live GraphQL hydrate and reuse the graph
    # that's already on disk.
    dagster_plus_graph_hydrated_at: float | None = Field(None, description="Unix timestamp of the last successful Dagster+ graph hydrate")


class ProjectCreate(BaseModel):
    """Request to create a new project."""

    name: str = Field(..., description="Project name", min_length=1)
    description: str | None = None
    git_repo: str | None = None
    git_branch: str = "main"


class ProjectUpdate(BaseModel):
    """Request to update a project."""

    name: str | None = None
    description: str | None = None
    graph: PipelineGraph | None = None
    components: list[ComponentInstance] | None = None
    custom_lineage: list[CustomLineageEdge] | None = None
    git_repo: str | None = None
    git_branch: str | None = None
    is_imported: bool | None = None


class ProjectSummary(BaseModel):
    """Lightweight project metadata for list views."""

    id: str
    name: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime
    git_repo: str | None = None
    is_imported: bool = False
    is_dagster_plus: bool = False
    dagster_plus_org: str | None = None
    dagster_plus_deployment: str | None = None


class ProjectListResponse(BaseModel):
    """Response containing list of projects."""

    projects: list[Project]
    total: int


class ProjectSummaryListResponse(BaseModel):
    """Response containing lightweight list of project summaries."""

    projects: list[ProjectSummary]
    total: int
