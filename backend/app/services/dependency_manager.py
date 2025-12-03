"""Service for managing dynamic project dependencies based on component configuration."""

import asyncio
import toml
from pathlib import Path
from typing import Any

# Mapping of dlt destinations to required Python packages
DLT_DESTINATION_PACKAGES = {
    "snowflake": "dlt[snowflake]",
    "bigquery": "dlt[bigquery]",
    "postgres": "dlt[postgres]",
    "redshift": "dlt[redshift]",
    "duckdb": "dlt[duckdb]",
    "motherduck": "dlt[motherduck]",
    "databricks": "dlt[databricks]",
    "clickhouse": "dlt[clickhouse]",
    "mssql": "dlt[mssql]",
    "athena": "dlt[athena]",
    "mysql": "dlt[mysql]",
    "filesystem": "dlt[filesystem]",
    "synapse": "dlt[synapse]",
}


class DependencyManager:
    """Manages automatic dependency installation based on component configuration."""

    def analyze_component_dependencies(self, component_config: dict[str, Any]) -> list[str]:
        """
        Analyze a component configuration and return required packages.

        Args:
            component_config: Component instance configuration (e.g., from YAML)

        Returns:
            List of package specifiers (e.g., ["dlt[snowflake]", "dlt[bigquery]"])
        """
        packages = []

        # Check for direct destination field
        destination = component_config.get("destination")
        if destination and destination in DLT_DESTINATION_PACKAGES:
            packages.append(DLT_DESTINATION_PACKAGES[destination])
            print(f"🔍 Found destination: {destination}")

        # Check for environment routing destinations
        if component_config.get("use_environment_routing"):
            print("🔍 Environment routing enabled, checking all destination fields...")
            for key in ["destination_local", "destination_branch", "destination_prod"]:
                dest = component_config.get(key)
                if dest and dest in DLT_DESTINATION_PACKAGES:
                    packages.append(DLT_DESTINATION_PACKAGES[dest])
                    print(f"🔍 Found {key}: {dest}")

        # Deduplicate while preserving order
        seen = set()
        unique_packages = []
        for pkg in packages:
            if pkg not in seen:
                seen.add(pkg)
                unique_packages.append(pkg)

        return unique_packages

    def analyze_all_components(self, project_id: str) -> list[str]:
        """
        Analyze all component instances in a project and return required packages.

        Args:
            project_id: Project ID

        Returns:
            List of package specifiers needed by all components
        """
        from .project_service import project_service
        project = project_service.get_project(project_id)
        if not project:
            return []

        project_dir = project_service._get_project_dir(project)

        # Look for component YAML files in both flat and src layouts
        directory_name = project.directory_name

        # Try src layout first
        src_components_dir = project_dir / "src" / directory_name / "components"
        flat_components_dir = project_dir / directory_name / "components"

        components_dir = None
        if src_components_dir.exists():
            components_dir = src_components_dir
        elif flat_components_dir.exists():
            components_dir = flat_components_dir
        else:
            print(f"⚠️  No components directory found for project {project_id}")
            return []

        all_packages = []

        # Find all component.yaml files
        for component_yaml in components_dir.rglob("component.yaml"):
            try:
                import yaml
                with open(component_yaml) as f:
                    component_config = yaml.safe_load(f)

                if component_config:
                    packages = self.analyze_component_dependencies(component_config)
                    all_packages.extend(packages)

            except Exception as e:
                print(f"⚠️  Error analyzing {component_yaml}: {e}")
                continue

        # Deduplicate
        return list(set(all_packages))

    def add_dependencies_to_project(
        self,
        project_id: str,
        packages: list[str],
        auto_install: bool = True
    ) -> tuple[bool, list[str]]:
        """
        Add packages to project's pyproject.toml and optionally trigger installation.

        Args:
            project_id: Project ID
            packages: List of package specifiers to add
            auto_install: Whether to trigger background installation

        Returns:
            Tuple of (dependencies_added: bool, added_packages: list[str])
        """
        from .project_service import project_service
        if not packages:
            return False, []

        project = project_service.get_project(project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")

        project_dir = project_service._get_project_dir(project)
        pyproject_path = project_dir / "pyproject.toml"

        if not pyproject_path.exists():
            raise FileNotFoundError(f"pyproject.toml not found at {pyproject_path}")

        # Read current pyproject.toml
        with open(pyproject_path) as f:
            pyproject = toml.load(f)

        # Get current dependencies
        if "project" not in pyproject:
            pyproject["project"] = {}
        if "dependencies" not in pyproject["project"]:
            pyproject["project"]["dependencies"] = []

        current_deps = pyproject["project"]["dependencies"]
        added_packages = []

        # Add new dependencies if not already present
        for package in packages:
            # Extract base package name (e.g., "dlt" from "dlt[snowflake]")
            base_package = package.split("[")[0]

            # Check if this package (or any variant with extras) is already present
            already_present = any(
                base_package == dep.split("[")[0].split("==")[0].split(">=")[0].split("<")[0]
                for dep in current_deps
            )

            if not already_present:
                current_deps.append(package)
                added_packages.append(package)
                print(f"📦 Adding dependency: {package}")
            else:
                print(f"✓ Dependency already present: {package}")

        # Write back if changes were made
        if added_packages:
            pyproject["project"]["dependencies"] = current_deps

            with open(pyproject_path, "w") as f:
                toml.dump(pyproject, f)

            print(f"✅ Updated pyproject.toml with {len(added_packages)} new package(s)")

            # Trigger background installation if requested
            if auto_install:
                print(f"🔄 Triggering background installation for project {project_id}...")
                # Create task to install dependencies
                try:
                    loop = asyncio.get_event_loop()
                    loop.create_task(project_service.install_dependencies_async(project))
                except RuntimeError:
                    # If no event loop is running, we're in sync context
                    # This will be handled by the caller
                    print("⚠️  No event loop available, caller should trigger installation")

            return True, added_packages
        else:
            print("ℹ️  No new dependencies to add")
            return False, []

    def process_component_instance(
        self,
        project_id: str,
        component_config: dict[str, Any],
        auto_install: bool = True
    ) -> tuple[bool, list[str]]:
        """
        Analyze a single component instance and add any required dependencies.

        This is the main entry point to be called when a component is saved.

        Args:
            project_id: Project ID
            component_config: Component instance configuration
            auto_install: Whether to trigger background installation

        Returns:
            Tuple of (dependencies_added: bool, added_packages: list[str])
        """
        print(f"\n{'='*60}")
        print(f"🔍 Analyzing component dependencies for project {project_id}")
        print(f"{'='*60}")

        # Analyze this component
        required_packages = self.analyze_component_dependencies(component_config)

        if required_packages:
            print(f"📋 Required packages: {', '.join(required_packages)}")
            return self.add_dependencies_to_project(
                project_id,
                required_packages,
                auto_install=auto_install
            )
        else:
            print("ℹ️  No additional dependencies required for this component")
            return False, []

    def sync_project_dependencies(self, project_id: str, auto_install: bool = True) -> tuple[bool, list[str]]:
        """
        Scan all components in a project and ensure dependencies are installed.

        Useful for syncing dependencies after importing a project or bulk changes.

        Args:
            project_id: Project ID
            auto_install: Whether to trigger background installation

        Returns:
            Tuple of (dependencies_added: bool, added_packages: list[str])
        """
        print(f"\n{'='*60}")
        print(f"🔄 Syncing dependencies for entire project {project_id}")
        print(f"{'='*60}")

        required_packages = self.analyze_all_components(project_id)

        if required_packages:
            print(f"📋 Total required packages: {', '.join(required_packages)}")
            return self.add_dependencies_to_project(
                project_id,
                required_packages,
                auto_install=auto_install
            )
        else:
            print("ℹ️  No dlt destination dependencies required")
            return False, []


# Singleton instance
dependency_manager = DependencyManager()
