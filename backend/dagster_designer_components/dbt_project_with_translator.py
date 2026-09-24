"""Custom dbt project component with automatic key conflict resolution.

This component extends the standard DbtProjectComponent to automatically
apply the ResourceTypePrefixTranslator, which resolves duplicate asset key
conflicts that occur when dbt models and sources share the same name.
"""

import sys
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

            # DbtCliResource defaults dbt_executable to the bare string "dbt",
            # resolved via $PATH -- that fails here because $PATH in whatever
            # process loads this component (Designer's backend, `dg dev`, a
            # bare `dg list defs`) doesn't necessarily include this project's
            # own venv bin dir. dbt IS installed there (it's a project
            # dependency), just not found by name alone. Resolve it the same
            # way sys.executable already tells us where THIS project's venv
            # lives: dbt sits right next to the python running this code --
            # in Scripts/ with a .exe suffix on Windows, bin/ with no suffix
            # elsewhere (this file is copied into every project's own venv,
            # so it can't import Designer's shared venv_bin_path() helper --
            # small enough to duplicate the one check it needs here).
            dbt_name = "dbt.exe" if sys.platform == "win32" else "dbt"
            dbt_bin = Path(sys.executable).parent / dbt_name
            dbt_executable = str(dbt_bin) if dbt_bin.exists() else "dbt"

            return Definitions(
                assets=[dbt_project_assets],
                resources={
                    resource_key: DbtCliResource(project_dir=dbt_project, dbt_executable=dbt_executable)
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
