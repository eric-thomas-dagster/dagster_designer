"""Service for discovering and managing Dagster primitives in projects."""

import ast
import re
import yaml
import json
from pathlib import Path
from typing import Any, Literal


PrimitiveCategory = Literal["schedule", "job", "sensor", "asset_check"]


class PrimitivesService:
    """Service for discovering Dagster primitives in projects."""

    def __init__(self, projects_dir: str = "./projects"):
        self.projects_dir = Path(projects_dir)

    def _get_project_metadata(self, project_id: str) -> dict[str, Any]:
        """Load project metadata from JSON file."""
        metadata_file = self.projects_dir / f"{project_id}.json"
        if not metadata_file.exists():
            raise FileNotFoundError(f"Project metadata for {project_id} not found")

        with open(metadata_file, 'r') as f:
            return json.load(f)

    def _get_project_path(self, project_id: str) -> Path:
        """Get the path to a project directory."""
        metadata = self._get_project_metadata(project_id)
        directory_name = metadata.get("directory_name", project_id)
        project_path = self.projects_dir / directory_name
        if not project_path.exists():
            raise FileNotFoundError(f"Project {project_id} not found")
        return project_path

    def _parse_decorator(self, decorator_node: ast.expr) -> dict[str, Any]:
        """Parse a decorator node to extract parameters."""
        params = {}

        if isinstance(decorator_node, ast.Name):
            # Simple decorator like @asset
            return params

        if isinstance(decorator_node, ast.Call):
            # Decorator with arguments like @asset(...)
            for keyword in decorator_node.keywords:
                if isinstance(keyword.value, ast.Constant):
                    params[keyword.arg] = keyword.value.value
                elif isinstance(keyword.value, ast.List):
                    params[keyword.arg] = [
                        elem.value for elem in keyword.value.elts
                        if isinstance(elem, ast.Constant)
                    ]
                elif isinstance(keyword.value, ast.Dict):
                    params[keyword.arg] = {
                        k.value: v.value
                        for k, v in zip(keyword.value.keys, keyword.value.values)
                        if isinstance(k, ast.Constant) and isinstance(v, ast.Constant)
                    }

        return params

    def _discover_schedules(self, project_path: Path) -> list[dict[str, Any]]:
        """Discover schedules from YAML component files."""
        schedules = []
        # Try new structure first: src/{project_name}/defs/components
        components_dir = project_path / "src" / project_path.name / "defs" / "components"

        if not components_dir.exists():
            # Fallback to old structure for backwards compatibility
            components_dir = project_path / f"{project_path.name}_defs" / "components"
            if not components_dir.exists():
                return schedules

        for yaml_file in components_dir.glob("*.yaml"):
            try:
                content = yaml_file.read_text()
                config = yaml.safe_load(content)

                # Check if this is a schedule component
                if config.get("type") == "dagster_designer_components.ScheduleComponent":
                    attrs = config.get("attributes", {})
                    schedules.append({
                        "name": attrs.get("schedule_name", yaml_file.stem),
                        "file": str(yaml_file.relative_to(project_path)),
                        "cron_schedule": attrs.get("cron_expression", ""),
                        "job_name": attrs.get("job_name", ""),
                        "timezone": attrs.get("timezone", "UTC"),
                        "description": attrs.get("description", ""),
                    })
            except Exception as e:
                print(f"Error parsing {yaml_file}: {e}")

        return schedules

    def _discover_jobs(self, project_path: Path) -> list[dict[str, Any]]:
        """Discover jobs from YAML component files."""
        jobs = []
        # Try new structure first: src/{project_name}/defs/components
        components_dir = project_path / "src" / project_path.name / "defs" / "components"

        if not components_dir.exists():
            # Fallback to old structure for backwards compatibility
            components_dir = project_path / f"{project_path.name}_defs" / "components"
            if not components_dir.exists():
                return jobs

        for yaml_file in components_dir.glob("*.yaml"):
            try:
                content = yaml_file.read_text()
                config = yaml.safe_load(content)

                # Check if this is a job component
                if config.get("type") == "dagster_designer_components.JobComponent":
                    attrs = config.get("attributes", {})
                    jobs.append({
                        "name": attrs.get("job_name", yaml_file.stem),
                        "file": str(yaml_file.relative_to(project_path)),
                        "description": attrs.get("description", ""),
                        "selection": attrs.get("asset_selection", []),
                        "tags": attrs.get("tags", {}),
                    })
            except Exception as e:
                print(f"Error parsing {yaml_file}: {e}")

        return jobs

    def _discover_sensors(self, project_path: Path) -> list[dict[str, Any]]:
        """Discover sensors from YAML component files."""
        sensors = []
        # Try new structure first: src/{project_name}/defs/components
        components_dir = project_path / "src" / project_path.name / "defs" / "components"

        if not components_dir.exists():
            # Fallback to old structure for backwards compatibility
            components_dir = project_path / f"{project_path.name}_defs" / "components"
            if not components_dir.exists():
                return sensors

        for yaml_file in components_dir.glob("*.yaml"):
            try:
                content = yaml_file.read_text()
                config = yaml.safe_load(content)

                # Check if this is a sensor component
                if config.get("type") == "dagster_designer_components.SensorComponent":
                    attrs = config.get("attributes", {})
                    sensors.append({
                        "name": attrs.get("sensor_name", yaml_file.stem),
                        "file": str(yaml_file.relative_to(project_path)),
                        "job_name": attrs.get("job_name", ""),
                        "minimum_interval_seconds": attrs.get("minimum_interval_seconds", 30),
                        "description": attrs.get("description", ""),
                        "sensor_type": attrs.get("sensor_type", "custom"),
                    })
            except Exception as e:
                print(f"Error parsing {yaml_file}: {e}")

        return sensors

    def _discover_asset_checks(self, project_path: Path) -> list[dict[str, Any]]:
        """Discover asset checks from YAML component files."""
        checks = []
        # Try new structure first: src/{project_name}/defs/components
        components_dir = project_path / "src" / project_path.name / "defs" / "components"

        if not components_dir.exists():
            # Fallback to old structure for backwards compatibility
            components_dir = project_path / f"{project_path.name}_defs" / "components"
            if not components_dir.exists():
                return checks

        for yaml_file in components_dir.glob("*.yaml"):
            try:
                content = yaml_file.read_text()
                config = yaml.safe_load(content)

                # Check if this is an asset check component
                if config.get("type") == "dagster_designer_components.AssetCheckComponent":
                    attrs = config.get("attributes", {})
                    checks.append({
                        "name": attrs.get("check_name", yaml_file.stem),
                        "file": str(yaml_file.relative_to(project_path)),
                        "asset": attrs.get("asset_name", ""),
                        "description": attrs.get("description", ""),
                        "check_type": attrs.get("check_type", "custom"),
                    })
            except Exception as e:
                print(f"Error parsing {yaml_file}: {e}")

        return checks

    def list_primitives(
        self,
        project_id: str,
        category: PrimitiveCategory
    ) -> list[dict[str, Any]]:
        """
        List primitives of a specific category in a project.

        Args:
            project_id: Project ID
            category: Type of primitive to list

        Returns:
            List of primitives with their metadata
        """
        project_path = self._get_project_path(project_id)

        if category == "schedule":
            return self._discover_schedules(project_path)
        elif category == "job":
            return self._discover_jobs(project_path)
        elif category == "sensor":
            return self._discover_sensors(project_path)
        elif category == "asset_check":
            return self._discover_asset_checks(project_path)
        else:
            return []

    def list_all_primitives(self, project_id: str) -> dict[str, list[dict[str, Any]]]:
        """
        List all primitives in a project.

        Args:
            project_id: Project ID

        Returns:
            Dictionary with lists of all primitive types
        """
        return {
            "schedules": self.list_primitives(project_id, "schedule"),
            "jobs": self.list_primitives(project_id, "job"),
            "sensors": self.list_primitives(project_id, "sensor"),
            "asset_checks": self.list_primitives(project_id, "asset_check"),
        }

    def get_primitive_details(
        self,
        project_id: str,
        category: PrimitiveCategory,
        name: str,
    ) -> dict[str, Any] | None:
        """
        Get detailed information about a specific primitive.

        Args:
            project_id: Project ID
            category: Type of primitive
            name: Name of the primitive

        Returns:
            Primitive details or None if not found
        """
        primitives = self.list_primitives(project_id, category)

        for primitive in primitives:
            if primitive["name"] == name:
                # Add file content
                project_path = self._get_project_path(project_id)
                file_path = project_path / primitive["file"]

                if file_path.exists():
                    primitive["code"] = file_path.read_text()

                return primitive

        return None

    def delete_primitive(
        self,
        project_id: str,
        category: PrimitiveCategory,
        name: str,
    ) -> bool:
        """
        Delete a primitive from the project.

        Args:
            project_id: Project ID
            category: Type of primitive
            name: Name of the primitive

        Returns:
            True if deleted, False if not found
        """
        primitive = self.get_primitive_details(project_id, category, name)

        if not primitive:
            return False

        project_path = self._get_project_path(project_id)
        file_path = project_path / primitive["file"]

        if file_path.exists():
            file_path.unlink()
            return True

        return False

    def get_statistics(self, project_id: str) -> dict[str, int]:
        """
        Get statistics about primitives in the project.

        Args:
            project_id: Project ID

        Returns:
            Dictionary with counts of each primitive type
        """
        all_primitives = self.list_all_primitives(project_id)

        return {
            "schedules": len(all_primitives["schedules"]),
            "jobs": len(all_primitives["jobs"]),
            "sensors": len(all_primitives["sensors"]),
            "asset_checks": len(all_primitives["asset_checks"]),
            "total": sum([
                len(all_primitives["schedules"]),
                len(all_primitives["jobs"]),
                len(all_primitives["sensors"]),
                len(all_primitives["asset_checks"]),
            ]),
        }
