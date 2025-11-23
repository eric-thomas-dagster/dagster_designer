"""API endpoints for asset operations."""

import sys
import json
import subprocess
import importlib.util
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

from ..services.project_service import project_service

router = APIRouter(prefix="/assets", tags=["assets"])


class AssetDataResponse(BaseModel):
    """Response containing asset data preview."""

    success: bool
    data: list[dict[str, Any]] | None = None
    columns: list[str] | None = None
    dtypes: dict[str, str] | None = None
    shape: tuple[int, int] | None = None
    row_count: int | None = None
    column_count: int | None = None
    error: str | None = None
    sample_limit: int | None = None


@router.get("/{project_id}/{asset_key:path}/preview")
async def preview_asset_data(project_id: str, asset_key: str):
    """
    Execute an asset function and return its dataframe data for preview.

    Runs the asset execution in the project's Python environment to support custom components.

    Args:
        project_id: Project ID
        asset_key: Asset key (can be multi-part like "models/customers")

    Returns:
        Asset data in JSON format suitable for table display
    """
    # Get project
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Get project directory
    project_dir = project_service._get_project_dir(project)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project directory not found")

    # Get project module name
    project_module = project.directory_name

    # Set up environment
    import os
    env = os.environ.copy()
    project_src_dir = project_dir / "src"
    if "PYTHONPATH" in env:
        env["PYTHONPATH"] = f"{project_src_dir}:{env['PYTHONPATH']}"
    else:
        env["PYTHONPATH"] = str(project_src_dir)

    # Get the project's Python executable
    project_python = project_service._get_project_python_path(project)

    try:
        # Run the preview script in the project's Python environment
        result = subprocess.run(
            [
                str(project_python),
                "-m",
                "scripts.preview_asset",
                project_module,
                asset_key,
            ],
            cwd=Path.cwd(),  # Run from backend directory
            env=env,
            capture_output=True,
            text=True,
            timeout=60,  # 60 second timeout for asset execution
        )

        if result.returncode != 0:
            # Try to parse error from output
            try:
                # Get the last line which should be JSON
                stdout_lines = result.stdout.strip().split('\n')
                last_line = stdout_lines[-1] if stdout_lines else ""
                error_data = json.loads(last_line or result.stderr)
                return AssetDataResponse(
                    success=False,
                    error=error_data.get("error", "Failed to execute asset")
                )
            except json.JSONDecodeError:
                return AssetDataResponse(
                    success=False,
                    error=f"Failed to execute asset: {result.stderr}"
                )

        # Parse the JSON output from the script (last line)
        stdout_lines = result.stdout.strip().split('\n')
        last_line = stdout_lines[-1] if stdout_lines else ""
        output_data = json.loads(last_line)
        return AssetDataResponse(**output_data)

    except json.JSONDecodeError as e:
        return AssetDataResponse(
            success=False,
            error=f"Failed to parse output: {str(e)}"
        )
    except subprocess.TimeoutExpired:
        return AssetDataResponse(
            success=False,
            error="Asset execution timed out (60 seconds)"
        )
    except Exception as e:
        return AssetDataResponse(
            success=False,
            error=f"Unexpected error: {str(e)}"
        )


class FilterCondition(BaseModel):
    column: str
    operator: str
    value: str


class TransformConfig(BaseModel):
    columnsToKeep: list[str] | None = None
    columnsToDrop: list[str] | None = None
    columnRenames: dict[str, str] | None = None  # e.g., {"old_name": "new_name"}
    filters: list[FilterCondition] = []
    dropDuplicates: bool = False
    dropNA: bool = False
    fillNAValue: str | None = None
    sortBy: list[str] | None = None
    sortAscending: bool = True
    groupBy: list[str] | None = None
    aggregations: dict[str, str] | None = None  # e.g., {"amount": "sum", "id": "count"}
    stringOperations: list[dict[str, str]] | None = None  # e.g., [{"column": "name", "operation": "upper"}]
    stringReplace: dict[str, dict[str, str]] | None = None
    calculatedColumns: dict[str, str] | None = None  # e.g., {"total": "price * quantity"}
    pivotConfig: dict[str, str] | None = None
    unpivotConfig: dict[str, Any] | None = None


class CreateTransformerRequest(BaseModel):
    sourceAssetKey: str
    newAssetName: str
    transformConfig: TransformConfig


@router.post("/{project_id}/create-transformer")
async def create_transformer_asset(project_id: str, request: CreateTransformerRequest):
    """Create a new transformer asset that applies transformations to a source asset.

    This endpoint creates a new DataFrameTransformerComponent instance with the
    specified transformation configuration and adds it to the project.
    """
    from ..services.project_service import project_service
    from ..models.project import ProjectUpdate
    from ..models.graph import GraphNode, GraphEdge
    import uuid
    import yaml
    from pathlib import Path

    print(f"[Create Transformer] Creating transformer asset '{request.newAssetName}' from '{request.sourceAssetKey}'", flush=True)

    # Get project
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project_service._get_project_dir(project)
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project directory not found")

    # Generate component ID
    component_id = request.newAssetName.replace('-', '_').replace(' ', '_').lower()

    # Create component directory structure in the correct location
    src_dir = project_dir / "src" / project.directory_name
    defs_dir = src_dir / "defs" / component_id
    defs_dir.mkdir(parents=True, exist_ok=True)

    # Build transformation configuration for the transformer component
    # The DataFrameTransformerComponent expects specific attributes, not a transforms array
    attributes = {
        "asset_name": component_id
    }

    # Convert columnsToKeep to filter_columns (comma-separated string)
    if request.transformConfig.columnsToKeep:
        attributes["filter_columns"] = ",".join(request.transformConfig.columnsToKeep)

    # Convert columnsToDrop to drop_columns (comma-separated string)
    if request.transformConfig.columnsToDrop:
        attributes["drop_columns"] = ",".join(request.transformConfig.columnsToDrop)

    # Convert columnRenames to rename_columns (JSON string)
    if request.transformConfig.columnRenames:
        attributes["rename_columns"] = json.dumps(request.transformConfig.columnRenames)

    # Convert filter operations to filter_expression (pandas query)
    if request.transformConfig.filters:
        filter_parts = []
        for filter_cond in request.transformConfig.filters:
            column = filter_cond.column
            operator = filter_cond.operator
            value = filter_cond.value

            # Convert operator to pandas query syntax
            if operator == "equals":
                # Properly quote string values
                if value.lower() in ['true', 'false']:
                    filter_parts.append(f"{column} == {value.capitalize()}")
                else:
                    filter_parts.append(f"{column} == '{value}'")
            elif operator == "not_equals":
                if value.lower() in ['true', 'false']:
                    filter_parts.append(f"{column} != {value.capitalize()}")
                else:
                    filter_parts.append(f"{column} != '{value}'")
            elif operator == "greater_than":
                filter_parts.append(f"{column} > {value}")
            elif operator == "less_than":
                filter_parts.append(f"{column} < {value}")
            elif operator == "contains":
                filter_parts.append(f"{column}.str.contains('{value}')")

        if filter_parts:
            attributes["filter_expression"] = " and ".join(filter_parts)

    # Add row operations
    if request.transformConfig.dropDuplicates:
        attributes["drop_duplicates"] = True

    if request.transformConfig.dropNA:
        attributes["drop_na"] = True

    if request.transformConfig.fillNAValue:
        attributes["fill_na_value"] = request.transformConfig.fillNAValue

    # Add sorting
    if request.transformConfig.sortBy:
        attributes["sort_by"] = ",".join(request.transformConfig.sortBy)
        attributes["sort_ascending"] = request.transformConfig.sortAscending

    # Add grouping/aggregation
    if request.transformConfig.groupBy:
        attributes["group_by"] = ",".join(request.transformConfig.groupBy)

    if request.transformConfig.aggregations:
        attributes["agg_functions"] = json.dumps(request.transformConfig.aggregations)

    # Add string operations
    if request.transformConfig.stringOperations:
        attributes["string_operations"] = json.dumps(request.transformConfig.stringOperations)

    if request.transformConfig.stringReplace:
        attributes["string_replace"] = json.dumps(request.transformConfig.stringReplace)

    # Add calculated columns
    if request.transformConfig.calculatedColumns:
        attributes["calculated_columns"] = json.dumps(request.transformConfig.calculatedColumns)

    # Add pivot/unpivot
    if request.transformConfig.pivotConfig:
        attributes["pivot_config"] = json.dumps(request.transformConfig.pivotConfig)

    if request.transformConfig.unpivotConfig:
        attributes["unpivot_config"] = json.dumps(request.transformConfig.unpivotConfig)

    # Create defs.yaml for the transformer component
    transformer_component_type = f"{project.directory_name}.components.dataframe_transformer.DataFrameTransformerComponent"

    defs_yaml = {
        "type": transformer_component_type,
        "attributes": attributes
    }

    # Write YAML - component now accepts dicts/lists and converts them to JSON strings
    defs_yaml = {
        "type": transformer_component_type,
        "attributes": attributes
    }

    with open(defs_dir / "defs.yaml", "w") as f:
        yaml.dump(defs_yaml, f, default_flow_style=False, sort_keys=False)

    print(f"[Create Transformer] Created defs.yaml with attributes: {list(attributes.keys())}", flush=True)

    # Add custom lineage edge to project model
    from ..models.project import CustomLineageEdge

    new_edge = CustomLineageEdge(
        source=request.sourceAssetKey,
        target=component_id
    )

    # Check if edge already exists
    edge_exists = any(
        e.source == new_edge.source and e.target == new_edge.target
        for e in project.custom_lineage
    )

    if not edge_exists:
        project.custom_lineage.append(new_edge)
        print(f"[Create Transformer] Added custom lineage: {request.sourceAssetKey} -> {component_id}", flush=True)

    # Also write to custom_lineage.json for Dagster to load
    custom_lineage_file = src_dir / "defs" / "custom_lineage.json"
    custom_lineage_data = {
        "edges": [
            {"source": e.source, "target": e.target}
            for e in project.custom_lineage
        ]
    }

    with open(custom_lineage_file, "w") as f:
        json.dump(custom_lineage_data, f, indent=2)
    print(f"[Create Transformer] Updated custom_lineage.json with {len(project.custom_lineage)} edges", flush=True)

    # Add component to project's components list if not already there
    transformer_component_type = f"{project.directory_name}.components.dataframe_transformer.DataFrameTransformerComponent"

    component_exists = any(
        c.component_type == transformer_component_type and c.id == component_id
        for c in project.components
    )

    if not component_exists:
        from ..models.project import ComponentInstance

        new_component = ComponentInstance(
            id=component_id,
            component_type=transformer_component_type,
            label=request.newAssetName,
            attributes={"asset_name": component_id},
            translation=None,
            post_processing=None,
            is_asset_factory=False
        )
        project.components.append(new_component)
        print(f"[Create Transformer] Added component to project", flush=True)

    # Don't update yet - we'll do one update at the end with all changes

    # Regenerate assets to get the new asset node
    from ..services.asset_introspection_service import asset_introspection_service

    print(f"[Create Transformer] Regenerating assets...", flush=True)
    asset_introspection_service.clear_cache(project.id)

    asset_nodes, asset_edges = await asset_introspection_service.get_assets_for_project_async(project, recalculate_layout=True)

    # Find the new transformer asset node
    transformer_node = None
    for node in asset_nodes:
        if node.id == component_id or node.data.get('asset_key') == component_id:
            transformer_node = node
            break

    if not transformer_node:
        raise HTTPException(status_code=500, detail=f"Failed to find generated transformer asset '{component_id}'")

    # Update project graph with the new assets
    non_asset_nodes = [n for n in project.graph.nodes if n.node_kind != "asset"]
    project.graph.nodes = non_asset_nodes + asset_nodes

    # Merge introspected edges with custom lineage edges (same pattern as delete_component_instance)
    edge_map = {edge.id: edge for edge in asset_edges}

    # Process custom lineage edges
    for custom_lineage in project.custom_lineage:
        edge_id = f"{custom_lineage.source}_to_{custom_lineage.target}"

        if edge_id in edge_map:
            # Edge already exists from introspection, just mark it as custom
            edge_map[edge_id].is_custom = True
        else:
            # Edge doesn't exist, create a new custom edge
            edge_map[edge_id] = GraphEdge(
                id=edge_id,
                source=custom_lineage.source,
                target=custom_lineage.target,
                is_custom=True
            )

    # Convert edge map back to list
    project.graph.edges = list(edge_map.values())

    # Save updated project with components, graph, and custom lineage in a single update
    updated_project = project_service.update_project(
        project_id,
        ProjectUpdate(
            components=project.components,
            graph=project.graph,
            custom_lineage=project.custom_lineage
        )
    )

    print(f"[Create Transformer] Successfully created transformer asset '{component_id}'", flush=True)
    print(f"[Create Transformer] Returning project with {len(updated_project.graph.nodes)} nodes and {len(updated_project.graph.edges)} edges", flush=True)
    print(f"[Create Transformer] Node IDs: {[n.id for n in updated_project.graph.nodes if n.node_kind == 'asset']}", flush=True)
    print(f"[Create Transformer] Edge IDs: {[e.id for e in updated_project.graph.edges]}", flush=True)
    print(f"[Create Transformer] Custom lineage count: {len(updated_project.custom_lineage)}", flush=True)

    return updated_project if updated_project else project
