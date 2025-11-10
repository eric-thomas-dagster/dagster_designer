"""Service for dynamically installing Dagster component libraries."""

import subprocess
from pathlib import Path
from typing import Any


class ComponentInstaller:
    """Service for installing Dagster component libraries."""

    # Map component types to package names
    COMPONENT_PACKAGES = {
        "dagster_dbt": "dagster-dbt",
        "dagster_fivetran": "dagster-fivetran",
        "dagster_sling": "dagster-sling",
        "dagster_dlt": "dagster-dlt",
        "dagster_airbyte": "dagster-airbyte",
        "dagster_snowflake": "dagster-snowflake",
        "dagster_bigquery": "dagster-bigquery",
        "dagster_databricks": "dagster-databricks",
        "dagster_aws": "dagster-aws",
        "dagster_gcp": "dagster-gcp",
        "dagster_azure": "dagster-azure",
        "dagster_k8s": "dagster-k8s",
        "dagster_docker": "dagster-docker",
        "dagster_slack": "dagster-slack",
        "dagster_pagerduty": "dagster-pagerduty",
        "dagster_datadog": "dagster-datadog",
    }

    def __init__(self):
        pass

    def install_component_package(
        self,
        project_path: Path,
        component_type: str
    ) -> tuple[bool, str]:
        """Install a component package using uv add.

        Args:
            project_path: Path to Dagster project
            component_type: Component type (e.g., dagster_dbt.DbtProjectComponent)

        Returns:
            Tuple of (success, message)
        """
        # Extract module name from component type
        module_name = component_type.split('.')[0]

        # Get package name
        package_name = self.COMPONENT_PACKAGES.get(module_name)

        if not package_name:
            return False, f"Unknown component module: {module_name}"

        try:
            # Run uv add to install the package
            result = subprocess.run(
                ["uv", "add", package_name],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                return False, f"Installation failed: {result.stderr}"

            return True, f"Successfully installed {package_name}"

        except subprocess.TimeoutExpired:
            return False, "Installation timed out"
        except FileNotFoundError:
            return False, "uv not found. Please install: pip install uv"

    def is_component_installed(
        self,
        project_path: Path,
        component_type: str
    ) -> bool:
        """Check if a component package is installed.

        Args:
            project_path: Path to Dagster project
            component_type: Component type

        Returns:
            True if installed, False otherwise
        """
        module_name = component_type.split('.')[0]
        package_name = self.COMPONENT_PACKAGES.get(module_name)

        if not package_name:
            return False

        try:
            # Check if package is in pyproject.toml
            pyproject_path = project_path / "pyproject.toml"

            if not pyproject_path.exists():
                return False

            content = pyproject_path.read_text()
            return package_name in content

        except Exception:
            return False

    def list_available_components(self) -> list[dict[str, str]]:
        """List all available component packages.

        Returns:
            List of available component packages
        """
        return [
            {
                "module": module,
                "package": package,
                "description": self._get_package_description(module),
            }
            for module, package in self.COMPONENT_PACKAGES.items()
        ]

    def _get_package_description(self, module: str) -> str:
        """Get description for a package."""
        descriptions = {
            "dagster_dbt": "Transform data with dbt",
            "dagster_fivetran": "Sync data from 150+ sources",
            "dagster_sling": "Database-to-database replication",
            "dagster_dlt": "Modern data loading framework",
            "dagster_airbyte": "Open-source data integration",
            "dagster_snowflake": "Snowflake data warehouse",
            "dagster_bigquery": "Google BigQuery integration",
            "dagster_databricks": "Databricks Lakehouse platform",
            "dagster_aws": "AWS services integration",
            "dagster_gcp": "Google Cloud Platform integration",
            "dagster_azure": "Microsoft Azure integration",
            "dagster_k8s": "Kubernetes orchestration",
            "dagster_docker": "Docker container support",
            "dagster_slack": "Slack notifications",
            "dagster_pagerduty": "PagerDuty alerting",
            "dagster_datadog": "Datadog monitoring",
        }
        return descriptions.get(module, "")

    def get_installed_components(self, project_path: Path) -> list[str]:
        """Get list of installed component packages.

        Args:
            project_path: Path to Dagster project

        Returns:
            List of installed package names
        """
        try:
            pyproject_path = project_path / "pyproject.toml"

            if not pyproject_path.exists():
                return []

            content = pyproject_path.read_text()

            installed = []
            for module, package in self.COMPONENT_PACKAGES.items():
                if package in content:
                    installed.append(package)

            return installed

        except Exception:
            return []


# Global service instance
component_installer = ComponentInstaller()
