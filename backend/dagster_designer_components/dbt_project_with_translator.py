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
        from dagster import asset, AssetSpec

        # Resolve the project path relative to the Dagster project root
        project_dir = Path(context.project_root) / self.project

        try:
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

        except Exception as e:
            # If dbt setup fails (e.g., missing adapter), return an error asset
            error_message = str(e)

            # Create a sanitized asset key from the project path
            asset_key_name = f"dbt_error_{self.project.replace('/', '_').replace('-', '_')}"

            # Check if it's a missing adapter error
            if "Could not find adapter type" in error_message or "ModuleNotFoundError" in error_message:
                if "duckdb" in error_message.lower():
                    error_message = (
                        f"❌ dbt DuckDB adapter not installed\n\n"
                        f"The dbt project at '{self.project}' requires the DuckDB adapter for local development.\n\n"
                        f"To fix this:\n"
                        f"1. Run: uv add dbt-duckdb\n"
                        f"2. Or change the target in profiles.yml to use a different adapter\n\n"
                        f"Original error: {error_message}"
                    )
                else:
                    error_message = (
                        f"❌ Missing dbt adapter\n\n"
                        f"The dbt project at '{self.project}' requires an adapter that is not installed.\n\n"
                        f"Original error: {error_message}"
                    )
            else:
                error_message = (
                    f"❌ Error loading dbt project at '{self.project}'\n\n"
                    f"Error: {error_message}"
                )

            # Create an error asset that displays the problem
            @asset(
                key=asset_key_name,
                description=error_message,
            )
            def dbt_error_placeholder():
                raise Exception(error_message)

            return Definitions(assets=[dbt_error_placeholder])
