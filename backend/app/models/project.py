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
    discovered_primitives: dict = Field(default_factory=dict, description="Discovered schedules/sensors/jobs from dg list defs")
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    git_repo: str | None = Field(None, description="Git repository URL")
    git_branch: str = Field("main", description="Git branch")
    is_imported: bool = Field(False, description="Whether this project was imported from an existing codebase")
    dagster_package_subdir: str | None = Field(None, description="Subdirectory containing the Dagster package (pyproject.toml) for imported projects")


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


class ProjectListResponse(BaseModel):
    """Response containing list of projects."""

    projects: list[Project]
    total: int


class ProjectSummaryListResponse(BaseModel):
    """Response containing lightweight list of project summaries."""

    projects: list[ProjectSummary]
    total: int
