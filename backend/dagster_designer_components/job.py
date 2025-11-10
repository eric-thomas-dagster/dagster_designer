"""Job component for Dagster Designer."""

from typing import Optional

import dagster as dg
from dagster._core.definitions.asset_selection import AssetSelection


class JobComponent(dg.Component, dg.Model, dg.Resolvable):
    """Component for creating jobs from YAML configuration."""

    job_name: str
    asset_selection: list[str]
    description: Optional[str] = None
    tags: Optional[dict[str, str]] = None
    config: Optional[dict] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        """Build Dagster definitions from component parameters."""
        # Create asset selection
        asset_sel = AssetSelection.keys(*self.asset_selection)

        # Create job
        job = dg.define_asset_job(
            name=self.job_name,
            selection=asset_sel,
            description=self.description,
            tags=self.tags or {},
            config=self.config,
        )

        return dg.Definitions(jobs=[job])
