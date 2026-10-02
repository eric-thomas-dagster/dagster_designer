from pydantic import BaseModel, Field
from datetime import datetime
from .graph import PipelineGraph
from .component import ComponentInstance


class CustomLineageEdge(BaseModel):
    """A custom lineage relationship between assets."""

    source: str = Field(..., description="Source asset key")
    target: str = Field(..., description="Target asset key")


class AssetFieldOverrides(BaseModel):
    """description/group_name/owners/tags overrides for one asset, applied
    via the same defs.yaml post_processing mechanism as custom_lineage
    deps (see project_service._write_post_processing_defs_yaml). Covers
    fields that previously had no reliable write path at all for some
    assets:
      - non-dbt components: confirmed _generate_component_yaml_files
        strips `description` from a component's own attributes with the
        comment "this goes in translation, not params" -- then never adds
        it to translation either, since translation is dbt-only.
        group_name/owners/tags had the same gap whenever a component's
        own schema didn't happen to declare them.
      - PropertyPanel's asset-metadata editor, for any NON-dbt asset:
        confirmed its "save" path for that case did nothing but mutate
        the in-memory graph node's `data` -- never persisted anywhere
        that affects the real Dagster asset, and got silently overwritten
        on the next introspection regenerate anyway.
      - AssetDetailPage's "Definition" editor: its dbt path re-implemented
        the SAME fragile find-or-create-a-per-model-component dance as
        PropertyPanel (independently, in a second file); its non-dbt path
        wrote `translation.by_key[assetKey]`, a convention confirmed to
        be 100% dead -- grepped the whole backend, nothing reads
        "by_key" anywhere. Both migrated onto this mechanism too."""

    description: str | None = None
    group_name: str | None = None
    owners: list[str] | None = None
    tags: dict[str, str] | None = None
    kinds: list[str] | None = None


class AssetPostProcessingRule(BaseModel):
    """A project-wide post_processing rule: `target` is a real Dagster
    asset-selection expression (not just a single literal key), e.g.
    `"*"`, `"tag:critical=true"`, `"key:core/stg_*"`, or a boolean
    combination -- confirmed directly against a real Dagster load that
    this syntax works exactly as documented. This is what
    AssetFieldOverrides can't do: apply the same attributes to MANY assets
    in one rule (e.g. "tag every staging model with owner X"), the actual
    value-add of post_processing beyond single-asset editing.

    Unlike AssetFieldOverrides' keys, `target` is used verbatim when it
    already looks like real selector syntax (contains ":" or is "*") --
    the user is responsible for that syntax being correct, the same way
    they would be hand-writing it in defs.yaml. When it doesn't look like
    selector syntax (no ":", not "*"), it's treated as a literal asset key
    and given the same `key:` safety prefix as AssetFieldOverrides, so
    someone who just types a bare asset name here doesn't accidentally
    create a bare-string target -- confirmed directly that a bare string
    that doesn't resolve crashes loading of the ENTIRE project, while an
    explicit `key:` prefix degrades gracefully instead."""

    target: str
    group_name: str | None = None
    owners: list[str] | None = None
    tags: dict[str, str] | None = None


class Project(BaseModel):
    """A pipeline project."""

    id: str = Field(..., description="Unique project ID")
    name: str = Field(..., description="Project name")
    description: str | None = Field(None, description="Project description")
    directory_name: str | None = Field(None, description="Directory name for the project (sanitized for Python identifiers)")
    graph: PipelineGraph = Field(default_factory=PipelineGraph, description="Pipeline graph (assets and 1:1 components)")
    components: list[ComponentInstance] = Field(default_factory=list, description="Component instances (particularly asset factories)")
    custom_lineage: list[CustomLineageEdge] = Field(default_factory=list, description="Custom lineage edges drawn by user")
    # group_name/owners/tags overrides, keyed by asset key, applied via the
    # same post_processing mechanism as custom_lineage -- see
    # AssetFieldOverrides.
    asset_field_overrides: dict[str, AssetFieldOverrides] = Field(default_factory=dict, description="Per-asset group_name/owners/tags overrides")
    # Project-wide post_processing rules (selector-based target, not a
    # single literal asset key) -- see AssetPostProcessingRule.
    asset_post_processing_rules: list[AssetPostProcessingRule] = Field(default_factory=list, description="Project-wide post_processing rules keyed by a Dagster selection expression")
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
    asset_field_overrides: dict[str, AssetFieldOverrides] | None = None
    asset_post_processing_rules: list[AssetPostProcessingRule] | None = None
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
