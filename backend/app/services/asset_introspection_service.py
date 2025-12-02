"""Service for introspecting Dagster assets using dg CLI."""

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Tuple

from ..models.graph import GraphNode, GraphEdge
from ..models.project import Project
from ..core.config import settings
from .codegen_service import CodegenService


# Simple in-memory cache for asset introspection to avoid re-running slow dg list defs
# Cache structure: {project_id: (timestamp, assets_data)}
_assets_cache: Dict[str, Tuple[float, dict]] = {}
CACHE_TTL_SECONDS = 60  # Cache results for 60 seconds (increased from 10s for better performance)

# Lock to prevent multiple simultaneous dg list defs calls for the same project
# This prevents the race condition where lineage and automations both try to run dg list defs
_introspection_locks: Dict[str, asyncio.Lock] = {}


class AssetIntrospectionService:
    """Service for discovering assets from Dagster components."""

    def __init__(self):
        self.codegen_service = CodegenService()

    def clear_cache(self, project_id: str) -> None:
        """Clear the asset introspection cache for a specific project."""
        if project_id in _assets_cache:
            del _assets_cache[project_id]
            print(f"[Asset Introspection] Cleared cache for project {project_id}", flush=True)

    def _is_running(self, project_id: str) -> bool:
        """Check if asset introspection is currently running for a project."""
        if project_id not in _introspection_locks:
            return False
        lock = _introspection_locks[project_id]
        return lock.locked()

    def _get_project_dir(self, project: Project) -> Path:
        """Get the directory path for a project.

        Uses the sanitized directory_name if available, otherwise falls back to project.id
        for backwards compatibility with old projects.
        """
        if project.directory_name:
            return settings.projects_dir / project.directory_name
        return settings.projects_dir / project.id

    def get_assets_for_project(self, project: Project, recalculate_layout: bool = False) -> tuple[list[GraphNode], list[GraphEdge]]:
        """Get assets and dependencies for a project by running dg list defs.

        Args:
            project: Project to introspect
            recalculate_layout: If True, recalculates all node positions instead of preserving existing ones

        Returns:
            Tuple of (asset_nodes, asset_edges)
        """
        # First, generate the Dagster code
        project_dir = self._get_project_dir(project)

        try:
            # Components are already scaffolded during project creation
            # Just run dg list defs to get assets
            assets_data = self._run_dg_list_defs(project, project_dir)

            # Build a map of existing node positions (unless we're recalculating)
            existing_positions = {}
            if not recalculate_layout and project.graph and project.graph.nodes:
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
        # Check cache first
        current_time = time.time()
        if project.id in _assets_cache:
            cache_time, cached_data = _assets_cache[project.id]
            age = current_time - cache_time
            if age < CACHE_TTL_SECONDS:
                print(f"[Asset Introspection] Returning cached data for project {project.id} (age: {age:.1f}s)", flush=True)
                return cached_data

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
                print(f"[Asset Introspection] Running dg list defs for project {project.id}...", flush=True)
                result = subprocess.run(
                    ["bash", "-c", cmd],
                    cwd=str(project_dir.resolve()),
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=180,  # 180 seconds for massive dbt projects
                )
                print(f"[Asset Introspection] Command completed successfully", flush=True)
            else:
                # Fallback to system dg (already in PATH)
                print(f"[Asset Introspection] Running dg list defs for project {project.id}...", flush=True)
                result = subprocess.run(
                    [dg_cmd, "list", "defs", "--json"],
                    cwd=project_dir,
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=180,  # 180 seconds for massive dbt projects
                )
                print(f"[Asset Introspection] Command completed successfully", flush=True)

            # Parse and cache the results
            assets_data = json.loads(result.stdout)
            _assets_cache[project.id] = (time.time(), assets_data)
            print(f"[Asset Introspection] Cached results for project {project.id}", flush=True)

            return assets_data

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

    async def _run_dg_list_defs_async(self, project: Project, project_dir: Path) -> dict[str, Any]:
        """Run dg list defs command asynchronously (non-blocking).

        Uses a lock to prevent multiple simultaneous calls for the same project.

        Args:
            project: The project to introspect
            project_dir: Directory containing the Dagster project

        Returns:
            Parsed JSON data from dg list defs
        """
        # Check cache first (before acquiring lock for better performance)
        current_time = time.time()
        if project.id in _assets_cache:
            cache_time, cached_data = _assets_cache[project.id]
            age = current_time - cache_time
            if age < CACHE_TTL_SECONDS:
                print(f"[Asset Introspection] Returning cached data for project {project.id} (age: {age:.1f}s)", flush=True)
                return cached_data

        # Get or create a lock for this project
        if project.id not in _introspection_locks:
            _introspection_locks[project.id] = asyncio.Lock()

        lock = _introspection_locks[project.id]

        # Acquire the lock to prevent multiple simultaneous dg list defs calls
        async with lock:
            # Check cache again after acquiring lock (another call might have populated it)
            current_time = time.time()
            if project.id in _assets_cache:
                cache_time, cached_data = _assets_cache[project.id]
                age = current_time - cache_time
                if age < CACHE_TTL_SECONDS:
                    print(f"[Asset Introspection] Returning cached data for project {project.id} after lock (age: {age:.1f}s)", flush=True)
                    return cached_data

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
                print(f"[Asset Introspection] Running dg list defs ASYNC for project {project.id}...", flush=True)

                # If using project venv, we need to activate it first
                if dg_path.exists():
                    # Run with venv activated using bash -c (use absolute paths for both)
                    dg_abs_path = str(dg_path.resolve())
                    cmd = f"source {str(venv_dir.resolve())}/bin/activate && {dg_abs_path} list defs --json"

                    proc = await asyncio.create_subprocess_shell(
                        cmd,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        cwd=str(project_dir.resolve())
                    )
                else:
                    # Fallback to system dg (already in PATH)
                    proc = await asyncio.create_subprocess_exec(
                        dg_cmd, "list", "defs", "--json",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                        cwd=str(project_dir.resolve())
                    )

                # Wait for completion with timeout
                try:
                    stdout, stderr = await asyncio.wait_for(
                        proc.communicate(),
                        timeout=180.0  # 180 second timeout for massive dbt projects
                    )
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
                    error_msg = "dg list defs timed out after 180 seconds"
                    print(f"❌ {error_msg}", flush=True)
                    raise RuntimeError(error_msg)

                if proc.returncode != 0:
                    error_msg = f"dg list defs failed with return code {proc.returncode}"
                    if stderr:
                        error_msg += f"\nStderr: {stderr.decode()}"
                    if stdout:
                        error_msg += f"\nStdout: {stdout.decode()}"
                    print(f"❌ {error_msg}", flush=True)
                    raise RuntimeError(error_msg)

                print(f"[Asset Introspection] Command completed successfully", flush=True)

                # Parse and cache the results
                assets_data = json.loads(stdout.decode())
                _assets_cache[project.id] = (time.time(), assets_data)
                print(f"[Asset Introspection] Cached results for project {project.id}", flush=True)

                return assets_data

            except json.JSONDecodeError as e:
                error_msg = f"Failed to parse dg list defs output: {e}"
                print(f"❌ {error_msg}", flush=True)
                raise RuntimeError(error_msg) from e

    async def get_assets_for_project_async(self, project: Project, recalculate_layout: bool = False) -> tuple[list[GraphNode], list[GraphEdge]]:
        """Async version of get_assets_for_project. Non-blocking!

        Args:
            project: Project to introspect (will be modified to store discovered primitives)
            recalculate_layout: If True, recalculates all node positions instead of preserving existing ones

        Returns:
            Tuple of (asset_nodes, asset_edges)
        """
        # First, generate the Dagster code
        project_dir = self._get_project_dir(project)

        try:
            # Run dg list defs asynchronously (non-blocking)
            assets_data = await self._run_dg_list_defs_async(project, project_dir)

            # Build a map of existing node positions (unless we're recalculating)
            existing_positions = {}
            if not recalculate_layout and project.graph and project.graph.nodes:
                for node in project.graph.nodes:
                    existing_positions[node.id] = node.position

            # Parse assets and create nodes/edges
            nodes, edges = self._parse_assets_data(assets_data, project, existing_positions)

            # Store discovered primitives (schedules/sensors/jobs) in project
            # These will be saved to the project JSON for instant loading
            project.discovered_primitives = {
                "schedules": assets_data.get("schedules", []),
                "sensors": assets_data.get("sensors", []),
                "jobs": assets_data.get("jobs", []),
            }
            print(f"[Asset Introspection] Stored {len(project.discovered_primitives.get('schedules', []))} schedules, "
                  f"{len(project.discovered_primitives.get('sensors', []))} sensors, "
                  f"{len(project.discovered_primitives.get('jobs', []))} jobs", flush=True)

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

        # Create a mapping of component ID to icon
        component_icons = {}

        # Also scan defs/ folder for community component instances
        # Community components create defs.yaml files in defs/<component_id>/
        # Try both flat and src layouts
        directory_name = project.directory_name
        flat_defs_dir = project_dir / directory_name / "defs"
        src_defs_dir = project_dir / "src" / directory_name / "defs"

        # Determine which layout is being used
        defs_dir = None
        components_dir = None
        if flat_defs_dir.exists():
            defs_dir = flat_defs_dir
            components_dir = project_dir / directory_name / "components"
            print(f"[Asset Introspection] Using flat layout defs at: {flat_defs_dir}", flush=True)
        elif src_defs_dir.exists():
            defs_dir = src_defs_dir
            components_dir = project_dir / "src" / directory_name / "components"
            print(f"[Asset Introspection] Using src layout defs at: {src_defs_dir}", flush=True)

        # Create a mapping to track component_id (folder name) for each pseudo-component
        component_id_map = {}

        if defs_dir and defs_dir.exists():
            import yaml
            for component_folder in defs_dir.iterdir():
                if component_folder.is_dir():
                    defs_yaml = component_folder / "defs.yaml"
                    if defs_yaml.exists():
                        try:
                            with open(defs_yaml, 'r') as f:
                                defs_data = yaml.safe_load(f)

                            if defs_data and 'type' in defs_data:
                                # Create a pseudo-component object for matching
                                component_id = component_folder.name
                                from ..models.component import ComponentInstance
                                pseudo_comp = ComponentInstance(
                                    id=f"community_{component_id}",
                                    component_type=defs_data['type'],
                                    label=defs_data.get('attributes', {}).get('asset_name', component_id),
                                    attributes=defs_data.get('attributes', {}),
                                )
                                component_map[pseudo_comp.id] = pseudo_comp
                                component_id_map[pseudo_comp.id] = component_id

                                # Try to load icon from manifest
                                if components_dir:
                                    manifest_path = components_dir / component_id / "manifest.yaml"
                                    if manifest_path.exists():
                                        try:
                                            with open(manifest_path, 'r') as f:
                                                manifest_data = yaml.safe_load(f)
                                                icon = manifest_data.get('icon', 'package')
                                                component_icons[pseudo_comp.id] = icon
                                                print(f"[Asset Introspection] Loaded icon '{icon}' for {component_id}", flush=True)
                                        except Exception as e:
                                            print(f"[Asset Introspection] Failed to load manifest for {component_id}: {e}", flush=True)
                                            component_icons[pseudo_comp.id] = 'package'
                                    else:
                                        component_icons[pseudo_comp.id] = 'package'

                                print(f"[Asset Introspection] Loaded community component from defs: {component_id} -> {defs_data['type']}", flush=True)
                        except Exception as e:
                            print(f"[Asset Introspection] Failed to load defs.yaml from {component_folder}: {e}", flush=True)
        else:
            print(f"[Asset Introspection] No defs directory found at {flat_defs_dir} or {src_defs_dir}", flush=True)

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

                # If source is null and this is NOT a dbt asset, try to find the Python file
                # Search for Python assets when source is missing (could be manually defined @asset)
                is_dbt_asset = "dbt" in kinds
                if not asset_source and not is_dbt_asset:
                    # Search for Python files in defs/ directory
                    python_file = self._find_python_asset_file(project_dir, asset_key)
                    if python_file:
                        asset_source = str(python_file.relative_to(project_dir))
                        print(f"[Asset Introspection] Found Python asset file: {asset_source}", flush=True)

                for comp_id, comp in component_map.items():
                    # Check for dbt assets (must have "dbt" in kinds)
                    # Matches both dagster_dbt.DbtProjectComponent and DbtProjectWithTranslatorComponent
                    is_dbt_component = (
                        comp.component_type.startswith("dagster_dbt") or
                        "DbtProject" in comp.component_type
                    )
                    if is_dbt_component:
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

                # Check for community components by matching source path
                # Community components create assets in defs/<asset_name>/defs.yaml
                # Example: src/project_name/defs/my_asset/defs.yaml
                if not source_component and asset_source:
                    print(f"[Asset Introspection] Checking community components for asset {asset_key}, source: {asset_source}", flush=True)

                    # First try matching against registered components
                    print(f"[Asset Introspection] Available components: {list(component_map.keys())}", flush=True)
                    for comp_id, comp in component_map.items():
                        print(f"[Asset Introspection] Checking component {comp_id}: {comp.component_type}", flush=True)
                        # Check if this is a community component (has .components. in the type)
                        if ".components." in comp.component_type:
                            # Extract component_id from type
                            # e.g., "project_name.components.synthetic_data_generator.SyntheticDataGenerator" -> "synthetic_data_generator"
                            parts = comp.component_type.split('.')
                            if 'components' in parts:
                                idx = parts.index('components')
                                if idx + 1 < len(parts):
                                    component_id = parts[idx + 1]
                                    # Check if asset source contains this component_id in the path
                                    # e.g., "src/project_name/defs/synthetic_data_generator/defs.yaml"
                                    if f"/defs/{component_id}/" in asset_source or f"\\defs\\{component_id}\\" in asset_source:
                                        source_component = comp_id
                                        print(f"[Asset Introspection] Matched community component: {component_id} for asset: {asset_key}", flush=True)
                                        break

                    # If not matched yet, check if the asset source matches the pattern /defs/{folder}/defs.yaml
                    # and read the YAML to determine component type
                    if not source_component and "/defs/" in asset_source and "/defs.yaml" in asset_source:
                        import re
                        import yaml
                        from pathlib import Path

                        # Extract folder name from path like "src/project_name/defs/my_asset/defs.yaml"
                        match = re.search(r'/defs/([^/]+)/defs\.yaml', asset_source)
                        if match:
                            asset_folder = match.group(1)
                            print(f"[Asset Introspection] Found unregistered component instance in folder: {asset_folder}", flush=True)

                            # Construct path to the YAML file
                            yaml_path = Path(project_dir) / asset_source.split(':')[0]
                            if yaml_path.exists():
                                try:
                                    with open(yaml_path, 'r') as f:
                                        yaml_data = yaml.safe_load(f)

                                    component_type = yaml_data.get('type')
                                    if component_type:
                                        print(f"[Asset Introspection] Found component type in YAML: {component_type}", flush=True)
                                        # Check if we already created a pseudo-component for this folder
                                        pseudo_comp_id = f"community_{asset_folder}"
                                        if pseudo_comp_id in component_map:
                                            source_component = pseudo_comp_id
                                            print(f"[Asset Introspection] Matched to pseudo-component: {pseudo_comp_id}", flush=True)
                                        else:
                                            # Use the component type as the source_component
                                            source_component = component_type
                                except Exception as e:
                                    print(f"[Asset Introspection] Error reading YAML for {asset_key}: {e}", flush=True)

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

                # Get component icon if available
                component_icon = component_icons.get(source_component) if source_component else None

                # Get component attributes and type if this asset has a source component
                component_attributes = None
                component_type = None
                actual_component_id = None
                if source_component and source_component in component_map:
                    source_comp = component_map[source_component]
                    component_attributes = source_comp.attributes
                    component_type = source_comp.component_type
                    # Get the actual folder name (component_id) for community components
                    actual_component_id = component_id_map.get(source_component)
                    print(f"[Asset Introspection] Including component attributes for {asset_key}: {component_attributes}", flush=True)
                    if actual_component_id:
                        print(f"[Asset Introspection] Component folder name: {actual_component_id}", flush=True)
                elif source_component and "/defs/" in asset_source and "/defs.yaml" in asset_source:
                    # For unregistered components discovered from YAML, read the attributes
                    import re
                    import yaml
                    from pathlib import Path

                    match = re.search(r'/defs/([^/]+)/defs\.yaml', asset_source)
                    if match:
                        asset_folder = match.group(1)
                        yaml_path = Path(project_dir) / asset_source.split(':')[0]
                        if yaml_path.exists():
                            try:
                                with open(yaml_path, 'r') as f:
                                    yaml_data = yaml.safe_load(f)

                                component_type = yaml_data.get('type')
                                component_attributes = yaml_data.get('attributes', {})
                                actual_component_id = asset_folder
                                print(f"[Asset Introspection] Read attributes from YAML for {asset_key}: {component_attributes}", flush=True)
                            except Exception as e:
                                print(f"[Asset Introspection] Error reading attributes for {asset_key}: {e}", flush=True)

                # Extract IO type information from component schema (x-dagster-io metadata)
                io_input_type = None
                io_output_type = None
                io_input_required = False

                if component_type and components_dir:
                    # Extract component folder name from component_type
                    # e.g., "project_name.components.synthetic_data_generator.SyntheticDataGeneratorComponent" -> "synthetic_data_generator"
                    component_folder = None
                    if '.components.' in component_type:
                        parts = component_type.split('.')
                        if 'components' in parts:
                            idx = parts.index('components')
                            if idx + 1 < len(parts):
                                component_folder = parts[idx + 1]

                    if component_folder:
                        schema_file = components_dir / component_folder / "schema.json"
                    elif actual_component_id:
                        # Fallback to using actual_component_id (for components in defs/)
                        schema_file = components_dir / actual_component_id / "schema.json"
                    else:
                        schema_file = None

                    if schema_file and schema_file.exists():
                        try:
                            import json
                            with open(schema_file, 'r') as f:
                                schema_data = json.load(f)

                            io_metadata = schema_data.get('x-dagster-io', {})
                            io_expected_columns = None
                            io_output_columns = None
                            io_compatible_upstream = None

                            if io_metadata:
                                # Extract input type and expected columns
                                if 'inputs' in io_metadata:
                                    io_input_type = io_metadata['inputs'].get('type')
                                    io_input_required = io_metadata['inputs'].get('required', False)
                                    io_expected_columns = io_metadata['inputs'].get('expected_columns')
                                    io_compatible_upstream = io_metadata['inputs'].get('compatible_upstream')

                                # Extract output type and columns
                                if 'outputs' in io_metadata:
                                    io_output_type = io_metadata['outputs'].get('type')
                                    io_output_columns = io_metadata['outputs'].get('columns')

                                if io_input_type or io_output_type:
                                    col_info = ""
                                    if io_expected_columns:
                                        col_info += f", expects {len(io_expected_columns)} columns"
                                    if io_output_columns:
                                        col_info += f", outputs {len(io_output_columns)} columns"
                                    print(f"[Asset Introspection] Found IO metadata for {asset_key}: input={io_input_type} (required={io_input_required}), output={io_output_type}{col_info}", flush=True)
                        except Exception as e:
                            print(f"[Asset Introspection] Failed to read schema for {asset_key}: {e}", flush=True)

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
                        "component_icon": component_icon,  # Add component icon for visual identification
                        "component_attributes": component_attributes,  # Include component configuration
                        "component_type": component_type,  # Include component type for frontend
                        "component_id": actual_component_id,  # Actual folder name for fetching configuration
                        "io_input_type": io_input_type,  # Input type from schema x-dagster-io
                        "io_output_type": io_output_type,  # Output type from schema x-dagster-io
                        "io_input_required": io_input_required,  # Whether input is required
                        "io_expected_columns": io_expected_columns,  # Expected input columns with schema
                        "io_output_columns": io_output_columns,  # Output columns with schema
                        "io_compatible_upstream": io_compatible_upstream,  # List of compatible upstream component IDs
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
