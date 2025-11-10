"""Job component for Dagster Designer."""

from typing import Optional

from dagster import define_asset_job
from dagster._core.definitions.asset_selection import AssetSelection
from pydantic import BaseModel


class JobComponentParams(BaseModel):
    """Parameters for job component."""

    job_name: str
    asset_selection: list[str]
    description: Optional[str] = None
    tags: Optional[dict[str, str]] = None
    config: Optional[dict] = None


class JobComponent:
    """Component for creating jobs from YAML configuration."""

    params_schema = JobComponentParams

    def __init__(self, **params):
        """Initialize the job component."""
        self.params = JobComponentParams(**params)

    def build_defs(self, context):
        """Build Dagster definitions from component parameters."""
        from dagster import Definitions

        # Create asset selection
        asset_sel = AssetSelection.keys(*self.params.asset_selection)

        # Create job
        job = define_asset_job(
            name=self.params.job_name,
            selection=asset_sel,
            description=self.params.description,
            tags=self.params.tags or {},
            config=self.params.config,
        )

        return Definitions(jobs=[job])
