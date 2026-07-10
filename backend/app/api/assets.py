"""API endpoints for asset operations."""

import sys
import json
import subprocess
import importlib.util
import time
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

from ..services.project_service import project_service

router = APIRouter(prefix="/assets", tags=["assets"])

# Simple in-memory TTL cache for preview results. Key includes sample_limit
# so a 100-row preview and a 1000-row Profile request cache separately.
# Preview execution costs 5–15s per call for dbt models (dbt show cold start)
# so caching lets users click around the graph without re-paying that cost.
# Materializes clear the whole project's cache (see clear_preview_cache below).
_PREVIEW_CACHE: dict[tuple[str, str, int], tuple[float, dict]] = {}
_PREVIEW_TTL_SECONDS = 120

# Longer-lived schema cache: once we've seen an asset's actual columns and
# dtypes (via a successful preview), remember them for the whole project.
# Used by Dagster AI to inject real upstream schemas into planning prompts —
# so the model doesn't have to hallucinate column names for dynamic-schema
# sources (file readers, dataframe_from_sql, etc.). Cleared on materialize
# alongside the row cache.
_SCHEMA_CACHE: dict[tuple[str, str], dict] = {}


def clear_preview_cache(project_id: str) -> None:
    """Invalidate every cached preview + schema for a project. Called after
    materializes so stale rows / stale column lists don't outlive the
    underlying data change."""
    for key in list(_PREVIEW_CACHE.keys()):
        if key[0] == project_id:
            del _PREVIEW_CACHE[key]
    for key in list(_SCHEMA_CACHE.keys()):
        if key[0] == project_id:
            del _SCHEMA_CACHE[key]


def get_known_schemas(project_id: str) -> dict[str, dict]:
    """Return `{asset_key: {columns, dtypes}}` for every asset in this
    project we've successfully previewed. Genie planner uses this to give
    the LLM real, current column info instead of relying on component
    hints alone."""
    return {
        key[1]: value
        for key, value in _SCHEMA_CACHE.items()
        if key[0] == project_id
    }


@router.get("/{project_id}/known-schemas")
async def known_schemas_endpoint(project_id: str):
    """HTTP surface over the schema cache — used by ComponentConfigModal
    to render column-picker dropdowns for fields like `partition_date_column`
    without every form having to spawn a preview. The cache is populated
    lazily as users preview assets; unknown assets return {}."""
    return get_known_schemas(project_id)


@router.get("/{project_id}/ingestion-history")
async def ingestion_history_endpoint(project_id: str, limit: int = 1000):
    """Read the ingestion event log — every materialize and successful
    preview is appended to a per-project JSONL file. The Ingestions tab
    computes KPIs (total rows, 24h count, success rate) and the trend
    chart client-side from these events, so we don't need to add a new
    aggregate endpoint every time we want a new panel."""
    from ..services.ingestion_history import read_events
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    project_dir = project_service._get_project_dir(project)
    events = read_events(project_dir, limit=limit)
    return {"events": events}


def _infer_upstream_resource_key(src_dir: Path, source_asset_key: str) -> str | None:
    """Look up the upstream asset's defs.yaml and return its declared Dagster
    resource_key, if any. Enables the SqlTransformer to inherit warehouse
    credentials from the same resource its upstream uses (Snowflake, Postgres,
    dbt-managed DuckDB, etc.) without the user having to configure it twice.

    Match rules (first hit wins):
      * an attribute literally named `resource_key`
      * any attribute ending in `_resource_key` (snowflake_resource_key,
        postgres_resource_key, warehouse_resource_key, …)
      * for dbt models (source key like `models/foo`), we skip — dbt has its
        own resource injection and the SqlTransformer's dbt-profile fallback
        already handles those cases.
    Returns None when no upstream defs.yaml is found or none of the shapes match.
    """
    if "/" in source_asset_key and source_asset_key.split("/", 1)[0] in {
        "models", "seeds", "snapshots", "analyses"
    }:
        return None

    import yaml as _yaml

    defs_root = src_dir / "defs"
    if not defs_root.exists():
        return None

    # Component-generated assets live at defs/<asset_name>/defs.yaml. The
    # source_asset_key for these is the bare asset name.
    candidates = [defs_root / source_asset_key / "defs.yaml"]
    # Fallback: scan all defs.yamls under defs/ for one whose asset_name
    # attribute matches. Cheap enough — projects have <100 components.
    for defs_yaml_path in defs_root.glob("*/defs.yaml"):
        if defs_yaml_path not in candidates:
            candidates.append(defs_yaml_path)

    for defs_yaml_path in candidates:
        if not defs_yaml_path.exists():
            continue
        try:
            parsed = _yaml.safe_load(defs_yaml_path.read_text()) or {}
        except Exception:
            continue
        attrs = parsed.get("attributes") or {}
        if not isinstance(attrs, dict):
            continue
        # Only accept a scan-hit if the asset_name actually matches. For the
        # primary candidate (defs/<key>/defs.yaml) the folder already
        # constrains the match, so skip that check to allow assets whose
        # folder name differs from asset_name.
        is_primary = defs_yaml_path == candidates[0]
        if not is_primary and attrs.get("asset_name") != source_asset_key:
            continue

        if isinstance(attrs.get("resource_key"), str) and attrs["resource_key"]:
            return attrs["resource_key"]
        for k, v in attrs.items():
            if isinstance(k, str) and k.endswith("_resource_key") and isinstance(v, str) and v:
                return v

        if is_primary:
            # Primary candidate exists but has no resource_key — no need to
            # keep scanning; secondary scan would only match by asset_name
            # anyway.
            break

    return None


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
async def preview_asset_data(
    project_id: str,
    asset_key: str,
    no_cache: bool = False,
    sample_limit: int = 100,
):
    """
    Execute an asset function and return its dataframe data for preview.

    Runs the asset execution in the project's Python environment to support custom components.

    Args:
        project_id: Project ID
        asset_key: Asset key (can be multi-part like "models/customers")
        no_cache: If true, skip the TTL cache and force a fresh preview.
        sample_limit: Max rows to return. Default 100 (fast). Profile mode
            can bump this to 1000+ for better distribution accuracy.

    Returns:
        Asset data in JSON format suitable for table display
    """
    # Clamp to a reasonable range so a user can't accidentally page-fault
    # the backend by asking for a million rows over HTTP.
    sample_limit = max(1, min(sample_limit, 50000))

    # Cache is keyed on (project, asset, sample_limit) — bigger samples
    # are separate cache entries. Otherwise a 100-row preview would mask
    # the 1000-row Profile request.
    cache_key = (project_id, asset_key, sample_limit)
    if not no_cache:
        cached = _PREVIEW_CACHE.get(cache_key)
        if cached and (time.time() - cached[0]) < _PREVIEW_TTL_SECONDS:
            return AssetDataResponse(**cached[1])

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
                str(sample_limit),
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
        # Only cache successful previews — errors are usually "not
        # materialized yet" and should re-check on next click.
        if output_data.get('success'):
            _PREVIEW_CACHE[cache_key] = (time.time(), output_data)
            # Log a preview event so the Ingestions tab has row-count data
            # to trend on. `row_count` is the TRUE total (from COUNT(*) on
            # warehouse-sourced previews, len(df) on in-memory). Bytes are
            # a very rough estimate — assume 30 bytes/cell — but at least
            # gives the "bytes ingested" tile something to move.
            try:
                from ..services.ingestion_history import record_event
                rows = output_data.get('row_count') or (
                    len(output_data.get('data') or [])
                )
                col_count = output_data.get('column_count') or len(output_data.get('columns') or [])
                bytes_est = rows * col_count * 30 if rows and col_count else None
                record_event(
                    project_dir,
                    event_type="preview",
                    asset_key=asset_key,
                    rows=int(rows) if rows is not None else None,
                    bytes_ingested=int(bytes_est) if bytes_est else None,
                    status="success",
                )
            except Exception as _e:
                print(f"[preview] Warning: could not record ingestion event: {_e}")
            # Also remember the observed schema (columns + dtypes) so the
            # Dagster AI planner can inject a real schema into future prompts
            # instead of the model having to guess columns for dynamic
            # sources (file readers, SQL queries, upstream chains, etc.).
            cols = output_data.get('columns')
            if cols:
                # Schema cache is keyed on (project, asset) — the schema
                # doesn't depend on sample size, so a 100-row and 1000-row
                # preview share the same schema entry.
                _SCHEMA_CACHE[(project_id, asset_key)] = {
                    'columns': list(cols),
                    'dtypes': dict(output_data.get('dtypes') or {}),
                }
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
    limitRows: int | None = None  # LIMIT N — applied last after all other ops.
    replaceOps: list[dict[str, str]] | None = None  # [{column, find, replace}]
    splitOps: list[dict[str, str]] | None = None  # [{column, delimiter, into}]
    windowOps: list[dict[str, Any]] | None = None  # [{kind, orderBy, partitionBy, orderAsc, into}]
    countMatchOps: list[dict[str, Any]] | None = None  # [{column, operator, value, into, partitionBy}]
    caseWhenOps: list[dict[str, Any]] | None = None  # [{branches, else, into}]
    concatOps: list[dict[str, str]] | None = None  # [{columns, separator, into}]
    dateExtractOps: list[dict[str, str]] | None = None  # [{column, part, into}]
    substringOps: list[dict[str, Any]] | None = None  # [{column, start, length, into}]
    numericOps: list[dict[str, Any]] | None = None  # [{column, op, digits, into}]
    sampleConfig: dict[str, Any] | None = None  # {n, fraction, random}
    binOps: list[dict[str, Any]] | None = None  # [{column, boundaries, labels, into}]
    dedupeSubset: dict[str, Any] | None = None  # {subsetCols, keep}
    cumsumOps: list[dict[str, Any]] | None = None  # [{column, partitionBy, orderBy, orderAsc, into}]
    fillDirectionOps: list[dict[str, Any]] | None = None  # [{column, direction, partitionBy, orderBy}]


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

    print(f"[Create Transformer] ========== START ==========", flush=True)
    print(f"[Create Transformer] Request data: sourceAssetKey='{request.sourceAssetKey}', newAssetName='{request.newAssetName}'", flush=True)
    print(f"[Create Transformer] Transform config: {request.transformConfig}", flush=True)

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

    # Detect whether the upstream asset lives in a warehouse (dbt model / sink
    # component output) vs. produces a Python DataFrame in-process. Warehouse
    # upstreams get the SqlTransformerComponent (in-warehouse SQL, no data
    # movement); DataFrame upstreams get DataFrameTransformerComponent.
    #
    # MVP heuristic: dbt asset keys always look like "models/<name>" or
    # "seeds/<name>". Anything else is treated as a DataFrame. We can add
    # richer detection (introspect the source component's output type) once
    # this lands.
    upstream_is_warehouse = '/' in request.sourceAssetKey and request.sourceAssetKey.split('/', 1)[0] in {
        'models', 'seeds', 'snapshots', 'analyses'
    }

    # Build transformation configuration for the transformer component
    # The DataFrameTransformerComponent expects specific attributes, not a transforms array
    attributes = {
        "asset_name": component_id,
        "upstream_asset_keys": request.sourceAssetKey  # Set upstream dependency immediately
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

    # Add row limit
    if request.transformConfig.limitRows is not None and request.transformConfig.limitRows > 0:
        attributes["limit_rows"] = request.transformConfig.limitRows

    # Add replace / split / window ops. The community DataFrameTransformer may
    # not recognize these fields yet (its schema is external), but passing
    # them through is harmless and lets it pick them up once its schema
    # widens. Our own SqlTransformerComponent has first-class support.
    if request.transformConfig.replaceOps:
        attributes["replace_ops"] = json.dumps(request.transformConfig.replaceOps)
    if request.transformConfig.splitOps:
        attributes["split_ops"] = json.dumps(request.transformConfig.splitOps)
    if request.transformConfig.windowOps:
        attributes["window_ops"] = json.dumps(request.transformConfig.windowOps)
    if request.transformConfig.countMatchOps:
        attributes["count_match_ops"] = json.dumps(request.transformConfig.countMatchOps)
    if request.transformConfig.caseWhenOps:
        attributes["case_when_ops"] = json.dumps(request.transformConfig.caseWhenOps)
    if request.transformConfig.concatOps:
        attributes["concat_ops"] = json.dumps(request.transformConfig.concatOps)
    if request.transformConfig.dateExtractOps:
        attributes["date_extract_ops"] = json.dumps(request.transformConfig.dateExtractOps)
    if request.transformConfig.substringOps:
        attributes["substring_ops"] = json.dumps(request.transformConfig.substringOps)
    if request.transformConfig.numericOps:
        attributes["numeric_ops"] = json.dumps(request.transformConfig.numericOps)
    if request.transformConfig.sampleConfig:
        attributes["sample_config"] = json.dumps(request.transformConfig.sampleConfig)
    if request.transformConfig.binOps:
        attributes["bin_ops"] = json.dumps(request.transformConfig.binOps)
    if request.transformConfig.dedupeSubset:
        attributes["dedupe_subset"] = json.dumps(request.transformConfig.dedupeSubset)
    if request.transformConfig.cumsumOps:
        attributes["cumsum_ops"] = json.dumps(request.transformConfig.cumsumOps)
    if request.transformConfig.fillDirectionOps:
        attributes["fill_direction_ops"] = json.dumps(request.transformConfig.fillDirectionOps)

    # Pick the right transformer backend based on upstream type.
    if upstream_is_warehouse:
        # Translate the DF-style attributes we built above into SQL-style ones
        # SqlTransformerComponent expects. Fields the SQL backend doesn't
        # support (group_by, aggregations, pivot, unpivot, string_operations,
        # string_replace, drop_na, fill_na) are dropped with a warning — the
        # user can re-do those in a DataFrame branch if they need them.
        sql_attrs: dict = {
            "asset_name": attributes["asset_name"],
            "upstream_asset_keys": attributes["upstream_asset_keys"],
            # dbt models materialize under `main` in the default profile;
            # the last segment of the asset key is the table name.
            "upstream_table": f"main.{request.sourceAssetKey.rsplit('/', 1)[-1]}",
            "output_schema": "main",
        }
        # Direct passes.
        if request.transformConfig.columnsToKeep:
            sql_attrs["columns_to_keep"] = ",".join(request.transformConfig.columnsToKeep)
        if request.transformConfig.columnsToDrop:
            sql_attrs["columns_to_drop"] = ",".join(request.transformConfig.columnsToDrop)
        if request.transformConfig.columnRenames:
            sql_attrs["rename_columns"] = json.dumps(request.transformConfig.columnRenames)
        if request.transformConfig.dropDuplicates:
            sql_attrs["drop_duplicates"] = True
        if request.transformConfig.sortBy:
            sql_attrs["sort_by"] = ",".join(request.transformConfig.sortBy)
            sql_attrs["sort_ascending"] = request.transformConfig.sortAscending
        if request.transformConfig.calculatedColumns:
            sql_attrs["calculated_columns"] = json.dumps(request.transformConfig.calculatedColumns)
        if request.transformConfig.limitRows is not None and request.transformConfig.limitRows > 0:
            sql_attrs["limit_rows"] = request.transformConfig.limitRows
        if request.transformConfig.replaceOps:
            sql_attrs["replace_ops"] = json.dumps(request.transformConfig.replaceOps)
        if request.transformConfig.splitOps:
            sql_attrs["split_ops"] = json.dumps(request.transformConfig.splitOps)
        if request.transformConfig.windowOps:
            sql_attrs["window_ops"] = json.dumps(request.transformConfig.windowOps)
        if request.transformConfig.countMatchOps:
            sql_attrs["count_match_ops"] = json.dumps(request.transformConfig.countMatchOps)
        if request.transformConfig.caseWhenOps:
            sql_attrs["case_when_ops"] = json.dumps(request.transformConfig.caseWhenOps)
        if request.transformConfig.concatOps:
            sql_attrs["concat_ops"] = json.dumps(request.transformConfig.concatOps)
        if request.transformConfig.dateExtractOps:
            sql_attrs["date_extract_ops"] = json.dumps(request.transformConfig.dateExtractOps)
        if request.transformConfig.substringOps:
            sql_attrs["substring_ops"] = json.dumps(request.transformConfig.substringOps)
        if request.transformConfig.numericOps:
            sql_attrs["numeric_ops"] = json.dumps(request.transformConfig.numericOps)
        if request.transformConfig.sampleConfig:
            sql_attrs["sample_config"] = json.dumps(request.transformConfig.sampleConfig)
        if request.transformConfig.binOps:
            sql_attrs["bin_ops"] = json.dumps(request.transformConfig.binOps)
        if request.transformConfig.dedupeSubset:
            sql_attrs["dedupe_subset"] = json.dumps(request.transformConfig.dedupeSubset)
        if request.transformConfig.cumsumOps:
            sql_attrs["cumsum_ops"] = json.dumps(request.transformConfig.cumsumOps)
        if request.transformConfig.fillDirectionOps:
            sql_attrs["fill_direction_ops"] = json.dumps(request.transformConfig.fillDirectionOps)
        # Filter translation: pandas query → SQL WHERE. Basic operators only;
        # anything involving `.str.contains` or method chains falls through
        # unchanged and may fail at run time.
        if request.transformConfig.filters:
            sql_parts = []
            for f in request.transformConfig.filters:
                col, op, val = f.column, f.operator, f.value
                if op == "equals":
                    sql_parts.append(f'"{col}" = ' + (val if val.lower() in ('true', 'false') else f"'{val}'"))
                elif op == "not_equals":
                    sql_parts.append(f'"{col}" != ' + (val if val.lower() in ('true', 'false') else f"'{val}'"))
                elif op == "greater_than":
                    sql_parts.append(f'"{col}" > {val}')
                elif op == "less_than":
                    sql_parts.append(f'"{col}" < {val}')
                elif op == "contains":
                    sql_parts.append(f'"{col}" LIKE \'%{val}%\'')
                elif op == "not_contains":
                    sql_parts.append(f'"{col}" NOT LIKE \'%{val}%\'')
            if sql_parts:
                sql_attrs["filter_expression"] = " AND ".join(sql_parts)

        # Auto-detect a Dagster resource_key from the upstream's defs.yaml so
        # the SqlTransformer inherits warehouse credentials the same way its
        # upstream does. We look for any attribute matching *_resource_key
        # (or bare `resource_key`) on the upstream component. First match wins
        # — surfaced in the SQL transformer so users can override in the UI.
        inferred_resource_key = _infer_upstream_resource_key(src_dir, request.sourceAssetKey)
        if inferred_resource_key:
            sql_attrs["resource_key"] = inferred_resource_key
            print(f"[Create Transformer] Auto-detected resource_key='{inferred_resource_key}' from upstream {request.sourceAssetKey}", flush=True)

        attributes = sql_attrs
        transformer_component_type = f"{project.directory_name}.dagster_designer_components.SqlTransformerComponent"
        print(f"[Create Transformer] Using SqlTransformerComponent for warehouse upstream {request.sourceAssetKey}", flush=True)
    else:
        transformer_component_type = f"{project.directory_name}.components.dataframe_transformer.DataFrameTransformerComponent"
        # DataFrameTransformerComponent is a community template. If the user
        # hasn't installed it yet, the defs.yaml we're about to write will
        # reference a module that doesn't exist and Dagster's next reload
        # will error. Install it via the CLI on demand.
        dft_dir = src_dir / "components" / "dataframe_transformer"
        if not dft_dir.exists():
            print(f"[Create Transformer] dataframe_transformer template not installed; auto-installing via CLI…", flush=True)
            import subprocess
            try:
                cli_result = subprocess.run(
                    [
                        "uvx", "--from", "dagster-community-components-cli",
                        "dagster-component", "add", "dataframe_transformer",
                        "--auto-install", "--manager", "uv", "--force",
                    ],
                    cwd=str(project_dir),
                    capture_output=True, text=True, timeout=300,
                )
                if cli_result.returncode != 0:
                    tail = (cli_result.stderr or cli_result.stdout or "").strip().splitlines()[-5:]
                    raise HTTPException(
                        status_code=500,
                        detail=(
                            "Couldn't install DataFrameTransformerComponent (community template). "
                            "Please install it manually via the Library tab, or use a warehouse-mode "
                            f"upstream (dbt model / sink). CLI output: {' | '.join(tail)}"
                        ),
                    )
                print(f"[Create Transformer] Installed dataframe_transformer template", flush=True)
                # dg's `add` also writes its own defs.yaml stub at
                # defs/dataframe_transformer/defs.yaml — we're about to write
                # our own instance elsewhere, so nuke the stub to avoid a
                # duplicate 0-config instance that would break validation.
                stub_defs = src_dir / "defs" / "dataframe_transformer" / "defs.yaml"
                if stub_defs.exists():
                    try:
                        import shutil as _sh
                        _sh.rmtree(stub_defs.parent)
                        print(f"[Create Transformer] Cleaned up stub defs at {stub_defs.parent}", flush=True)
                    except Exception as e:
                        print(f"[Create Transformer] Warning: couldn't remove stub defs: {e}", flush=True)
            except subprocess.TimeoutExpired:
                raise HTTPException(status_code=504, detail="Auto-install of dataframe_transformer timed out.")
            except FileNotFoundError:
                raise HTTPException(
                    status_code=500,
                    detail="uvx not found — install `uv` to enable auto-install of community components.",
                )

    defs_yaml = {
        "type": transformer_component_type,
        "attributes": attributes
    }

    print(f"[Create Transformer] About to write YAML with attributes: {attributes}", flush=True)
    print(f"[Create Transformer] upstream_asset_keys value: '{attributes.get('upstream_asset_keys')}'", flush=True)

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

    # Add component to project's components list if not already there.
    # transformer_component_type was set correctly above based on the branch;
    # don't re-hardcode DataFrameTransformerComponent here.
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

    try:
        asset_nodes, asset_edges = await asset_introspection_service.get_assets_for_project_async(project, recalculate_layout=True)

        # Find the new transformer asset node
        transformer_node = None
        for node in asset_nodes:
            if node.id == component_id or node.data.get('asset_key') == component_id:
                transformer_node = node
                break

        if not transformer_node:
            print(f"[Create Transformer] Warning: Could not find transformer node '{component_id}' in regenerated assets", flush=True)
        else:
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

            print(f"[Create Transformer] Successfully updated graph with {len(asset_nodes)} asset nodes", flush=True)

    except Exception as e:
        print(f"[Create Transformer] Warning: Failed to regenerate assets, but transformer files were created: {e}", flush=True)
        # Don't fail the request - the files were created successfully
        # The user can manually regenerate the graph later

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
