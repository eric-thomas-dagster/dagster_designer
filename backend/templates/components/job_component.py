"""Job component for Dagster Designer."""

from typing import Any, Optional, Sequence
from dagster import (
    Component,
    Definitions,
    define_asset_job,
    AssetSelection,
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
            # Convert list of strings to AssetSelection
            selection = AssetSelection.keys(*self.asset_selection)
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
