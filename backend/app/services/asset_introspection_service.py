"""Service for introspecting Dagster assets using dg CLI."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..models.graph import GraphNode, GraphEdge
from ..models.project import Project
from ..core.config import settings
from .codegen_service import CodegenService


class AssetIntrospectionService:
    """Service for discovering assets from Dagster components."""

    def __init__(self):
        self.codegen_service = CodegenService()

    def _get_project_dir(self, project: Project) -> Path:
        """Get the directory path for a project.

        Uses the sanitized directory_name if available, otherwise falls back to project.id
        for backwards compatibility with old projects.
        """
        if project.directory_name:
            return settings.projects_dir / project.directory_name
        return settings.projects_dir / project.id

    def get_assets_for_project(self, project: Project) -> tuple[list[GraphNode], list[GraphEdge]]:
        """Get assets and dependencies for a project by running dg list defs.

        Args:
            project: Project to introspect

        Returns:
            Tuple of (asset_nodes, asset_edges)
        """
        # First, generate the Dagster code
        project_dir = self._get_project_dir(project)

        try:
            # Components are already scaffolded during project creation
            # Just run dg list defs to get assets
            assets_data = self._run_dg_list_defs(project, project_dir)

            # Build a map of existing node positions
            existing_positions = {}
            if project.graph and project.graph.nodes:
                for node in project.graph.nodes:
                    existing_positions[node.id] = node.position

            # Parse assets and create nodes/edges
            nodes, edges = self._parse_assets_data(assets_data, project, existing_positions)

            # Mark which edges are custom (from custom_lineage)
            custom_edge_keys = set()
            for custom_edge in project.custom_lineage:
                # Convert asset keys to node IDs
                source_id = custom_edge.source.replace("/", "_")
                target_id = custom_edge.target.replace("/", "_")
                custom_edge_keys.add((source_id, target_id))

            # Mark edges as custom
            custom_count = 0
            for edge in edges:
                if (edge.source, edge.target) in custom_edge_keys:
                    edge.is_custom = True
                    custom_count += 1

            if custom_count > 0:
                print(f"[Custom Lineage] Marked {custom_count} edge(s) as custom", flush=True)

            return nodes, edges

        except Exception as e:
            print(f"❌ Error introspecting assets: {e}", flush=True)
            import traceback
            traceback.print_exc()
            # Re-raise the exception so the API can report it properly
            raise

    def _run_dg_list_defs(self, project: Project, project_dir: Path) -> dict[str, Any]:
        """Run dg list defs command and return parsed JSON output.

        Args:
            project: The project to introspect
            project_dir: Directory containing the Dagster project

        Returns:
            Parsed JSON data from dg list defs
        """
        # Get the path to dg in the project's virtualenv
        venv_dir = project_dir / ".venv"
        if sys.platform == "win32":
            dg_path = venv_dir / "Scripts" / "dg.exe"
        else:
            dg_path = venv_dir / "bin" / "dg"

        # Fall back to system dg if venv doesn't exist
        if not dg_path.exists():
            print(f"Project virtualenv dg not found at {dg_path}, falling back to system dg")
            dg_cmd = "dg"
        else:
            dg_cmd = str(dg_path)

        try:
            # If using project venv, we need to activate it first
            if dg_path.exists():
                # Run with venv activated using bash -c (use absolute paths for both)
                dg_abs_path = str(dg_path.resolve())
                cmd = f"source {str(venv_dir.resolve())}/bin/activate && {dg_abs_path} list defs --json"
                result = subprocess.run(
                    ["bash", "-c", cmd],
                    cwd=str(project_dir.resolve()),
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=30,
                )
                print(f"✅ Successfully ran dg list defs for project")
            else:
                # Fallback to system dg (already in PATH)
                result = subprocess.run(
                    [dg_cmd, "list", "defs", "--json"],
                    cwd=project_dir,
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=30,
                )

            return json.loads(result.stdout)

        except subprocess.CalledProcessError as e:
            error_msg = f"dg list defs failed with return code {e.returncode}"
            if e.stderr:
                error_msg += f"\nStderr: {e.stderr}"
            if e.stdout:
                error_msg += f"\nStdout: {e.stdout}"
            print(f"❌ {error_msg}", flush=True)
            raise RuntimeError(error_msg) from e
        except subprocess.TimeoutExpired:
            error_msg = "dg list defs timed out after 30 seconds"
            print(f"❌ {error_msg}", flush=True)
            raise RuntimeError(error_msg)
        except json.JSONDecodeError as e:
            error_msg = f"Failed to parse dg list defs output: {e}"
            print(f"❌ {error_msg}", flush=True)
            raise RuntimeError(error_msg) from e

    def _parse_assets_data(
        self,
        assets_data: dict[str, Any],
        project: Project,
        existing_positions: dict[str, dict[str, float]] = None
    ) -> tuple[list[GraphNode], list[GraphEdge]]:
        """Parse dg list defs output into GraphNodes and GraphEdges.

        Args:
            assets_data: Output from dg list defs --json
            project: Project these assets belong to
            existing_positions: Map of node_id -> position dict to preserve positions

        Returns:
            Tuple of (nodes, edges)
        """
        if existing_positions is None:
            existing_positions = {}
        nodes = []
        edges = []

        # Get project directory for finding Python asset files
        project_dir = self._get_project_dir(project)

        # Extract assets and asset checks from the data structure
        assets = assets_data.get("assets", [])
        asset_checks = assets_data.get("asset_checks", [])

        # Create a mapping of asset key to checks
        checks_by_asset = {}
        for check in asset_checks:
            asset_key = check.get("asset_key")
            if asset_key:
                if asset_key not in checks_by_asset:
                    checks_by_asset[asset_key] = []
                checks_by_asset[asset_key].append({
                    "name": check.get("name"),
                    "key": check.get("key"),
                    "description": check.get("description"),
                    "source": check.get("source"),
                })

        # Create a mapping of component ID to component for source attribution
        component_map = {comp.id: comp for comp in project.components}

        # Build dependency graph for layout calculation
        asset_map = {asset.get("key"): asset for asset in assets}

        # Calculate layers for left-to-right layout
        layers = self._calculate_dag_layers(assets)

        # Layout parameters
        x_spacing = 450  # Horizontal spacing between layers
        y_spacing = 180  # Vertical spacing within layers
        start_x = 100
        start_y = 100

        for layer_idx, layer_assets in enumerate(layers):
            # Center assets vertically within each layer
            layer_height = len(layer_assets) * y_spacing
            layer_start_y = start_y + (500 - layer_height) / 2  # Center around 500px

            for asset_idx, asset in enumerate(layer_assets):
                # The key field contains the asset key
                asset_key = asset.get("key", "")
                asset_id = asset_key.replace("/", "_")

                # Try to determine source component
                source_component = None
                kinds = asset.get("kinds", [])
                asset_source = asset.get("source", "")

                import sys
                print(f"[Asset Introspection] Processing asset: {asset_key}, kinds: {kinds}, source: {asset_source}", flush=True)
                sys.stdout.flush()

                # If source is null and this is a Python asset, try to find the Python file
                # (but NOT for dbt assets - they have their SQL source from dbt)
                is_python_asset = "python" in kinds and "dbt" not in kinds
                if not asset_source and is_python_asset:
                    # Search for Python files in defs/ directory
                    python_file = self._find_python_asset_file(project_dir, asset_key)
                    if python_file:
                        asset_source = str(python_file.relative_to(project_dir))
                        print(f"[Asset Introspection] Found Python asset file: {asset_source}", flush=True)

                for comp_id, comp in component_map.items():
                    # Check for dbt assets (must have "dbt" in kinds)
                    if comp.component_type.startswith("dagster_dbt"):
                        # ONLY assign if "dbt" is explicitly in kinds
                        if "dbt" in kinds:
                            # Check if this asset is excluded from this component
                            exclude_str = comp.attributes.get("exclude", "")
                            exclude_list = [s.strip() for s in exclude_str.split(",")] if exclude_str else []

                            # Get the model name from asset key (last part)
                            model_name = asset_key.split("/")[-1]

                            # Skip if this model is excluded
                            if model_name in exclude_list:
                                continue

                            # Check if there's a select filter
                            select_str = comp.attributes.get("select", "")
                            if select_str:
                                # Handle dbt selector patterns
                                # "fqn:*" means select all models (treat as no filter)
                                if select_str == "fqn:*" or select_str == "*":
                                    source_component = comp_id
                                    # Don't break - another component with specific select might override
                                # Check if model name matches the selector
                                elif model_name == select_str or select_str in model_name:
                                    source_component = comp_id
                                    break  # Specific match, use this
                            else:
                                # No select filter, this component generates all non-excluded dbt assets
                                source_component = comp_id
                                # Don't break - another component with select might be more specific

                    # Check for other component types (fivetran, sling, etc.)
                    elif "fivetran" in comp.component_type.lower() and any("fivetran" in k.lower() for k in kinds):
                        source_component = comp_id
                        break
                    elif "sling" in comp.component_type.lower() and any("sling" in k.lower() for k in kinds):
                        source_component = comp_id
                        break
                    elif "dlt" in comp.component_type.lower() and any("dlt" in k.lower() for k in kinds):
                        source_component = comp_id
                        break

                if source_component:
                    print(f"[Asset Introspection] Assigned source_component: {source_component} for asset: {asset_key}", flush=True)
                else:
                    print(f"[Asset Introspection] No source_component found for asset: {asset_key}", flush=True)

                # Use existing position if available, otherwise calculate new position
                if asset_id in existing_positions:
                    position = existing_positions[asset_id]
                else:
                    # Calculate position based on layer (left-to-right)
                    position = {
                        "x": start_x + (layer_idx * x_spacing),
                        "y": layer_start_y + (asset_idx * y_spacing)
                    }

                # Get checks for this asset
                asset_checks_list = checks_by_asset.get(asset_key, [])

                # Create asset node with comprehensive data
                node = GraphNode(
                    id=asset_id,
                    type="asset",
                    node_kind="asset",
                    source_component=source_component,
                    position=position,
                    data={
                        "label": asset_key,
                        "asset_key": asset_key,
                        "name": asset_key,  # Add name field for side panel
                        "description": asset.get("description", ""),
                        "group_name": asset.get("group", "default"),
                        "owners": asset.get("owners", []),
                        "kinds": asset.get("kinds", []),
                        "source": asset_source,  # Use the updated source with Python file path
                        "tags": asset.get("tags", []),
                        "is_executable": asset.get("is_executable", True),
                        "automation_condition": asset.get("automation_condition"),
                        "deps": asset.get("deps", []),  # Include dependencies
                        "checks": asset_checks_list,  # Include asset checks
                    }
                )
                nodes.append(node)

                # Create edges for dependencies
                dependencies = asset.get("deps", [])
                for dep_key in dependencies:
                    dep_id = dep_key.replace("/", "_")
                    edge = GraphEdge(
                        id=f"{dep_id}_to_{asset_id}",
                        source=dep_id,
                        target=asset_id,
                        source_handle=None,
                        target_handle=None,
                    )
                    edges.append(edge)

        return nodes, edges

    def _find_python_asset_file(self, project_dir: Path, asset_name: str) -> Path | None:
        """Search for a Python file that defines the given asset.

        Args:
            project_dir: Project directory
            asset_name: Name of the asset to find

        Returns:
            Path to the Python file relative to project root, or None if not found
        """
        # Search in defs/ directory for Python files
        # Try src/<module>/defs (created by tool) first
        defs_dir = project_dir / "src" / project_dir.name / "defs"

        # If not found, try <module>/defs (imported projects)
        if not defs_dir.exists():
            for item in project_dir.iterdir():
                if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', 'dbt_project']:
                    potential_defs_dir = item / "defs"
                    if potential_defs_dir.exists():
                        defs_dir = potential_defs_dir
                        break

        if not defs_dir or not defs_dir.exists():
            return None

        # Search for @asset decorator with this name
        for py_file in defs_dir.rglob("*.py"):
            if py_file.name.startswith("__"):
                continue

            try:
                content = py_file.read_text()
                # Look for @asset decorator followed by function definition
                # This matches patterns like:
                # @asset or @asset(...) or @dg.asset or @dagster.asset
                # followed by def asset_name
                import re
                pattern = rf"@(?:dg\.)?(?:dagster\.)?asset.*?\ndef\s+{re.escape(asset_name)}\s*\("
                if re.search(pattern, content, re.DOTALL | re.MULTILINE):
                    return py_file
            except Exception as e:
                print(f"[Asset Introspection] Error reading {py_file}: {e}")
                continue

        return None

    def _calculate_dag_layers(self, assets: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
        """Calculate layers for DAG layout (left-to-right).

        Layer 0: Assets with no dependencies
        Layer N: Assets whose dependencies are all in layers 0..N-1
        """
        asset_map = {asset.get("key"): asset for asset in assets}
        layers = []
        assigned = set()

        # Keep assigning assets to layers until all are assigned
        while len(assigned) < len(assets):
            current_layer = []

            for asset in assets:
                asset_key = asset.get("key")
                if asset_key in assigned:
                    continue

                # Check if all dependencies are already assigned
                deps = asset.get("deps", [])
                if all(dep in assigned or dep not in asset_map for dep in deps):
                    current_layer.append(asset)
                    assigned.add(asset_key)

            if not current_layer:
                # Prevent infinite loop if there are cycles
                # Assign remaining assets to current layer
                for asset in assets:
                    if asset.get("key") not in assigned:
                        current_layer.append(asset)
                        assigned.add(asset.get("key"))

            if current_layer:
                layers.append(current_layer)

        return layers


# Global service instance
asset_introspection_service = AssetIntrospectionService()
