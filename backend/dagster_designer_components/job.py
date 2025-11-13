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
        # Create asset selection - parse strings with slashes as multi-part keys
        # "nba/asset1" should become AssetKey(["nba", "asset1"])
        asset_keys = []
        for key_str in self.asset_selection:
            if "/" in key_str:
                # Split on slashes to create multi-part key
                parts = key_str.split("/")
                asset_keys.append(dg.AssetKey(parts))
            else:
                # Single-part key
                asset_keys.append(dg.AssetKey([key_str]))
        asset_sel = AssetSelection.keys(*asset_keys)

        # Create job
        job = dg.define_asset_job(
            name=self.job_name,
            selection=asset_sel,
            description=self.description,
            tags=self.tags or {},
            config=self.config,
        )

        return dg.Definitions(jobs=[job])
