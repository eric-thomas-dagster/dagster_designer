"""Job component for Dagster Designer."""

from typing import Any, Optional, Sequence
from dagster import (
    Component,
    Definitions,
    define_asset_job,
    AssetSelection,
    AssetKey,
    ComponentLoadContext,
)
from dagster.components.resolved.model import Model
from dagster.components.resolved.base import Resolvable


class JobComponent(Component, Resolvable, Model):
    """Component that creates a Dagster job for executing a selection of assets."""

    job_name: str
    asset_selection: Sequence[str]
    description: Optional[str] = None
    tags: dict[str, Any] = {}
    config: Optional[dict[str, Any]] = None

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the job."""
        # Create asset selection from list of asset keys
        if self.asset_selection:
            # Parse strings with slashes as multi-part keys
            # "nba/asset1" should become AssetKey(["nba", "asset1"])
            asset_keys = []
            for key_str in self.asset_selection:
                if "/" in key_str:
                    # Split on slashes to create multi-part key
                    parts = key_str.split("/")
                    asset_keys.append(AssetKey(parts))
                else:
                    # Single-part key
                    asset_keys.append(AssetKey([key_str]))
            selection = AssetSelection.keys(*asset_keys)
        else:
            selection = AssetSelection.all()

        # Create the job
        job = define_asset_job(
            name=self.job_name,
            selection=selection,
            description=self.description,
            tags=self.tags,
            config=self.config,
        )

        return Definitions(jobs=[job])
