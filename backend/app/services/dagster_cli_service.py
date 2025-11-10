"""Service for interacting with Dagster CLI (dg commands)."""

import subprocess
import json
import shutil
from pathlib import Path
from typing import Any

from ..core.config import settings


class DagsterCLIService:
    """Service for running Dagster CLI commands."""

    def __init__(self):
        self.projects_dir = settings.projects_dir
        self.projects_dir.mkdir(parents=True, exist_ok=True)

    def create_dagster_project(self, project_name: str) -> tuple[Path, str]:
        """Create a new Dagster project using official CLI.

        Args:
            project_name: Name of the project

        Returns:
            Tuple of (project_path, output_message)
        """
        project_path = self.projects_dir / project_name

        # Remove if exists
        if project_path.exists():
            shutil.rmtree(project_path)

        try:
            # Use uvx to create a new Dagster project
            result = subprocess.run(
                [
                    "uvx",
                    "create-dagster@latest",
                    "project",
                    project_name,
                ],
                cwd=self.projects_dir,
                capture_output=True,
                text=True,
                timeout=120,
            )

            if result.returncode != 0:
                raise ValueError(f"Failed to create project: {result.stderr}")

            return project_path, result.stdout

        except subprocess.TimeoutExpired:
            raise ValueError("Project creation timed out")
        except FileNotFoundError:
            raise ValueError("uvx not found. Please install: pip install uv")

    def scaffold_component(
        self,
        project_path: Path,
        component_type: str,
        component_name: str,
        options: dict[str, Any],
    ) -> tuple[Path, str]:
        """Scaffold a component using dg CLI.

        Args:
            project_path: Path to Dagster project
            component_type: Full component type (e.g., dagster_dbt.DbtProjectComponent)
            component_name: Name for the component instance
            options: Component configuration options

        Returns:
            Tuple of (component_file_path, output_message)
        """
        if not project_path.exists():
            raise ValueError(f"Project not found: {project_path}")

        try:
            # Build dg scaffold command
            cmd = ["dg", "scaffold", "defs", component_type, component_name]

            # Add options as flags
            for key, value in options.items():
                # Convert Python naming to CLI flags (e.g., api_key -> --api-key)
                flag = f"--{key.replace('_', '-')}"

                if isinstance(value, bool):
                    if value:
                        cmd.append(flag)
                elif isinstance(value, (list, tuple)):
                    for item in value:
                        cmd.extend([flag, str(item)])
                else:
                    cmd.extend([flag, str(value)])

            # Run dg scaffold
            result = subprocess.run(
                cmd,
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=60,
            )

            if result.returncode != 0:
                raise ValueError(f"Scaffold failed: {result.stderr}")

            # Find the created component file
            defs_dir = project_path / f"{project_path.name}_defs"
            component_file = defs_dir / f"{component_name}.yaml"

            if not component_file.exists():
                # Try to find any new .yaml file
                yaml_files = list(defs_dir.glob("*.yaml"))
                if yaml_files:
                    component_file = yaml_files[-1]

            return component_file, result.stdout

        except subprocess.TimeoutExpired:
            raise ValueError("Scaffold command timed out")
        except FileNotFoundError:
            raise ValueError("dg command not found. Please install Dagster CLI")

    def load_definitions(self, project_path: Path) -> dict[str, Any]:
        """Load Dagster definitions and extract asset information.

        Args:
            project_path: Path to Dagster project

        Returns:
            Dictionary with assets, errors, and metadata
        """
        if not project_path.exists():
            raise ValueError(f"Project not found: {project_path}")

        try:
            # Use dg to load and inspect definitions
            # We'll create a small Python script to load definitions and extract assets
            inspect_script = self._create_inspect_script(project_path)

            result = subprocess.run(
                ["python", str(inspect_script)],
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=30,
            )

            # Parse the JSON output
            if result.returncode == 0:
                return json.loads(result.stdout)
            else:
                return {
                    "success": False,
                    "error": result.stderr,
                    "assets": [],
                }

        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "error": "Loading definitions timed out",
                "assets": [],
            }
        except json.JSONDecodeError:
            return {
                "success": False,
                "error": f"Failed to parse output: {result.stdout}",
                "assets": [],
            }

    def _create_inspect_script(self, project_path: Path) -> Path:
        """Create a Python script to inspect Dagster definitions.

        Args:
            project_path: Path to Dagster project

        Returns:
            Path to the created script
        """
        script_path = project_path / "_inspect_defs.py"

        project_name = project_path.name
        script_content = f'''
import sys
import json
from pathlib import Path

try:
    # Add project to path
    project_root = Path(__file__).parent
    sys.path.insert(0, str(project_root))

    # Import definitions
    from {project_name}_defs.definitions import defs

    # Extract assets
    assets = []

    if hasattr(defs, 'assets') and defs.assets:
        for asset in defs.assets:
            asset_info = {{
                "key": str(asset.key),
                "group_name": asset.group_name if hasattr(asset, 'group_name') else None,
                "description": asset.description if hasattr(asset, 'description') else None,
                "deps": [str(dep) for dep in (asset.deps if hasattr(asset, 'deps') else [])],
                "metadata": dict(asset.metadata) if hasattr(asset, 'metadata') else {{}},
            }}
            assets.append(asset_info)

    # Output as JSON
    result = {{
        "success": True,
        "assets": assets,
        "asset_count": len(assets),
        "error": None,
    }}

    print(json.dumps(result, indent=2))

except Exception as e:
    # Output error as JSON
    result = {{
        "success": False,
        "assets": [],
        "asset_count": 0,
        "error": str(e),
    }}
    print(json.dumps(result, indent=2))
    sys.exit(1)
'''

        script_path.write_text(script_content)
        return script_path

    def list_components_from_dg(self) -> list[dict[str, Any]]:
        """List available components using dg CLI.

        Returns:
            List of component information
        """
        try:
            result = subprocess.run(
                ["dg", "list", "components"],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode != 0:
                return []

            # Parse dg output
            # Format is typically:
            # dagster_dbt.DbtProjectComponent
            # dagster_fivetran.FivetranAccountComponent
            # ...

            components = []
            for line in result.stdout.strip().split('\n'):
                line = line.strip()
                if line and '.' in line:
                    module, class_name = line.rsplit('.', 1)
                    components.append({
                        "type": line,
                        "module": module,
                        "name": class_name,
                    })

            return components

        except (subprocess.TimeoutExpired, FileNotFoundError):
            return []

    def get_component_scaffold_options(self, component_type: str) -> dict[str, Any]:
        """Get available scaffold options for a component.

        Args:
            component_type: Full component type

        Returns:
            Dictionary of options with descriptions
        """
        try:
            # Run dg scaffold with --help to get options
            result = subprocess.run(
                ["dg", "scaffold", "defs", component_type, "--help"],
                capture_output=True,
                text=True,
                timeout=10,
            )

            # Parse help output to extract options
            # This is a simplified version - in production you'd parse the full help text
            options = {}

            for line in result.stdout.split('\n'):
                if line.strip().startswith('--'):
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        option_name = parts[0].lstrip('--')
                        # Extract description (everything after option name)
                        description = ' '.join(parts[1:])
                        options[option_name] = {
                            "description": description,
                            "required": False,  # Would need to parse from help text
                        }

            return options

        except (subprocess.TimeoutExpired, FileNotFoundError):
            return {}

    def validate_project(self, project_path: Path) -> tuple[bool, str]:
        """Validate a Dagster project.

        Args:
            project_path: Path to project

        Returns:
            Tuple of (is_valid, error_message)
        """
        if not project_path.exists():
            return False, "Project directory does not exist"

        # Check for required structure
        project_name = project_path.name
        defs_dir = project_path / f"{project_name}_defs"

        if not defs_dir.exists():
            return False, f"Definitions directory not found: {defs_dir}"

        definitions_file = defs_dir / "definitions.py"
        if not definitions_file.exists():
            return False, "definitions.py not found"

        # Try to load definitions
        result = self.load_definitions(project_path)

        if not result.get("success"):
            return False, result.get("error", "Unknown error loading definitions")

        return True, f"Valid project with {result.get('asset_count', 0)} assets"


# Global service instance
dagster_cli_service = DagsterCLIService()
