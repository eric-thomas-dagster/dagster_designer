"""Custom dbt project component with automatic key conflict resolution.

This component extends the standard DbtProjectComponent to automatically
apply the ResourceTypePrefixTranslator, which resolves duplicate asset key
conflicts that occur when dbt models and sources share the same name.
"""

from pathlib import Path
from typing import Any

import dagster as dg
from dagster import AssetExecutionContext, Definitions

from .dbt_translator import ResourceTypePrefixTranslator


class DbtProjectWithTranslatorComponent(dg.Component, dg.Model, dg.Resolvable):
    """A dbt project component that automatically resolves asset key conflicts.

    This component wraps the standard dbt functionality but applies a custom
    translator that prefixes asset keys with their resource type (models/sources/
    snapshots/seeds). This prevents duplicate key errors when models and sources
    share the same name, which is a common pattern in production dbt projects.

    Example:
        In defs.yaml:
        ```yaml
        type: project_name.dagster_designer_components.DbtProjectWithTranslatorComponent
        attributes:
          project: path/to/dbt/project
        ```
    """

    project: str

    def build_defs(self, context: dg.ComponentLoadContext) -> Definitions:
        """Build Dagster definitions with the custom translator.

        Args:
            context: Context for loading the component

        Returns:
            Definitions object with dbt assets using the conflict-resolving translator
        """
        from dagster_dbt import DbtProject, DbtCliResource, dbt_assets

        # Resolve the project path relative to the Dagster project root
        project_dir = Path(context.project_root) / self.project

        # Create the dbt project
        dbt_project = DbtProject(project_dir=project_dir)

        # Generate manifest if in development mode
        dbt_project.prepare_if_dev()

        # Create a unique resource key based on the project path
        # Replace forward slashes and hyphens with underscores to create a valid key
        resource_key = f"dbt_{self.project.replace('/', '_').replace('-', '_')}"

        # Create a unique name for the dbt assets based on the project path
        assets_name = f"dbt_project_assets_{self.project.replace('/', '_').replace('-', '_')}"

        # Create dbt assets with our custom translator
        @dbt_assets(
            manifest=dbt_project.manifest_path,
            project=dbt_project,
            dagster_dbt_translator=ResourceTypePrefixTranslator(),
            required_resource_keys={resource_key},
            name=assets_name,
        )
        def dbt_project_assets(context: AssetExecutionContext):
            dbt_resource = getattr(context.resources, resource_key)
            yield from dbt_resource.cli(["build"], context=context).stream()

        return Definitions(
            assets=[dbt_project_assets],
            resources={
                resource_key: DbtCliResource(project_dir=dbt_project)
            }
        )
