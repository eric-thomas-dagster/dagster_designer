"""Service for generating Dagster code from pipeline graphs."""

import yaml
from pathlib import Path
from typing import Any

from ..models.project import Project
from ..models.graph import GraphNode


class CodegenService:
    """Service for code generation."""

    def generate_dagster_yaml(self, project: Project, output_dir: Path) -> list[Path]:
        """Generate Dagster YAML files from project graph.

        Args:
            project: Project to generate code for
            output_dir: Directory to write files to

        Returns:
            List of generated file paths
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        generated_files = []

        # Create project structure
        project_name = self._sanitize_name(project.name)
        defs_dir = output_dir / project_name / f"{project_name}_defs"
        defs_dir.mkdir(parents=True, exist_ok=True)

        # Generate pyproject.toml
        pyproject_file = output_dir / project_name / "pyproject.toml"
        self._generate_pyproject(project_name, pyproject_file)
        generated_files.append(pyproject_file)

        # Generate __init__.py
        init_file = output_dir / project_name / f"{project_name}_defs" / "__init__.py"
        init_file.write_text("")
        generated_files.append(init_file)

        # Generate component YAML files for each node
        for node in project.graph.nodes:
            yaml_file = self._generate_component_yaml(node, defs_dir)
            if yaml_file:
                generated_files.append(yaml_file)

        # Generate definitions.py
        defs_file = self._generate_definitions_file(project_name, defs_dir)
        generated_files.append(defs_file)

        return generated_files

    def _sanitize_name(self, name: str) -> str:
        """Sanitize project name for Python module."""
        return name.lower().replace(" ", "_").replace("-", "_")

    def _generate_pyproject(self, project_name: str, output_file: Path):
        """Generate pyproject.toml file."""
        content = f"""[build-system]
requires = ["setuptools"]
build-backend = "setuptools.build_meta"

[project]
name = "{project_name}"
version = "0.1.0"

[tool.dagster]
module_name = "{project_name}_defs"
"""
        output_file.write_text(content)

    def _generate_component_yaml(self, node: GraphNode, output_dir: Path) -> Path | None:
        """Generate YAML file for a component node."""
        # Extract component data
        component_type = node.data.get("component_type")
        if not component_type:
            return None

        label = node.data.get("label", node.id)
        attributes = node.data.get("attributes", {})
        translation = node.data.get("translation")
        post_processing = node.data.get("post_processing")

        # Build YAML structure
        yaml_data: dict[str, Any] = {
            "type": component_type,
        }

        if attributes:
            yaml_data["attributes"] = attributes

        if translation:
            yaml_data["translation"] = translation

        if post_processing:
            yaml_data["post_processing"] = post_processing

        # Write YAML file
        filename = f"{self._sanitize_name(label)}.yaml"
        output_file = output_dir / filename

        with open(output_file, "w") as f:
            yaml.dump(yaml_data, f, default_flow_style=False, sort_keys=False)

        return output_file

    def _generate_definitions_file(self, project_name: str, output_dir: Path) -> Path:
        """Generate definitions.py file that loads components."""
        content = f'''"""Dagster definitions for {project_name}."""

import dagster as dg
from pathlib import Path

# Load all components from the defs folder
defs = dg.load_from_defs_folder(
    project_root=Path(__file__).parent.parent,
)
'''
        output_file = output_dir / "definitions.py"
        output_file.write_text(content)
        return output_file

    def generate_deployment_files(self, project: Project, output_dir: Path) -> list[Path]:
        """Generate deployment configuration files.

        Args:
            project: Project to generate deployment files for
            output_dir: Directory to write files to

        Returns:
            List of generated file paths
        """
        output_dir = Path(output_dir)
        generated_files = []

        # Generate dagster.yaml for local deployment
        dagster_yaml = output_dir / "dagster.yaml"
        self._generate_dagster_yaml_config(project, dagster_yaml)
        generated_files.append(dagster_yaml)

        # Generate workspace.yaml
        workspace_yaml = output_dir / "workspace.yaml"
        self._generate_workspace_yaml(project, workspace_yaml)
        generated_files.append(workspace_yaml)

        return generated_files

    def _generate_dagster_yaml_config(self, project: Project, output_file: Path):
        """Generate dagster.yaml configuration file."""
        project_name = self._sanitize_name(project.name)
        content = f"""# Dagster instance configuration
storage:
  sqlite:
    base_dir: ./dagster_home/storage

run_launcher:
  module: dagster.core.launcher
  class: DefaultRunLauncher

run_coordinator:
  module: dagster.core.run_coordinator
  class: DefaultRunCoordinator
"""
        output_file.write_text(content)

    def _generate_workspace_yaml(self, project: Project, output_file: Path):
        """Generate workspace.yaml file."""
        project_name = self._sanitize_name(project.name)
        content = f"""# Dagster workspace
load_from:
  - python_module:
      module_name: {project_name}_defs.definitions
"""
        output_file.write_text(content)


# Global service instance
codegen_service = CodegenService()
