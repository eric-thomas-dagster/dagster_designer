"""API endpoints for asset operations."""

import sys
import json
import subprocess
import importlib.util
import time
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

from ..services.project_service import project_service
from ..core.uv_binary import find_uv_binary, env_with_bundled_uv_on_path
from ..services.dagster_plus_client import query as dagster_plus_query, ASSET_MATERIALIZATIONS_QUERY, DagsterPlusError

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


class ColumnLineageAsset(BaseModel):
    asset_key: str
    columns: list[str]


class ColumnLineageEdge(BaseModel):
    """Column-to-column edge inferred from preview cache. Confidence is
    high when the column name matches upstream exactly (passthrough
    heuristic), and lower when we can only tell "these upstreams feed
    that column somehow" (derived columns)."""
    from_asset: str
    from_column: str
    to_asset: str
    to_column: str
    confidence: float = 1.0


class ColumnLineageResponse(BaseModel):
    asset_key: str
    upstream: list[ColumnLineageAsset]     # upstream assets + their observed columns
    downstream: list[ColumnLineageAsset]   # downstream assets + their observed columns
    columns: list[str]                     # this asset's columns
    dtypes: dict[str, str]
    upstream_edges: list[ColumnLineageEdge]      # upstream.col → this.col
    downstream_edges: list[ColumnLineageEdge]    # this.col → downstream.col
    derived_columns: list[str] = []              # this asset's cols with NO upstream name match
    dropped_from_upstream: list[str] = []        # upstream cols with no downstream / this-asset match


@router.get("/{project_id}/column-lineage", response_model=ColumnLineageResponse)
async def column_lineage(project_id: str, asset_key: str):
    """Heuristic column-level lineage for one asset, derived from the
    preview cache. When both sides of an edge have been previewed at
    least once we can generate name-match edges (high confidence);
    columns that don't line up show as derived / dropped so users know
    the heuristic didn't cover them. Same primitive works across every
    component in the catalog — no per-component instrumentation
    required.

    For an asset that hasn't been previewed yet, the response is empty
    on that side; the frontend renders "preview to enable" instead of
    hallucinating edges.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    schemas = get_known_schemas(project_id)

    # Walk the persisted graph edges to find the upstream + downstream
    # asset keys of this asset. Handles both `asset_key/asset_key` and
    # bare-id references.
    upstream_keys: list[str] = []
    downstream_keys: list[str] = []
    for e in project.graph.edges:
        if e.target == asset_key:
            upstream_keys.append(e.source)
        if e.source == asset_key:
            downstream_keys.append(e.target)
    # Some graphs store asset_key via node.data.asset_key rather than
    # the node id. Fall back to matching that way too so we don't miss
    # legit deps when ids and keys diverge.
    node_id_to_key: dict[str, str] = {}
    for n in project.graph.nodes:
        key = (n.data or {}).get('asset_key') or n.id
        node_id_to_key[n.id] = key

    def _to_key(id_or_key: str) -> str:
        return node_id_to_key.get(id_or_key, id_or_key)

    upstream_keys = list(dict.fromkeys(_to_key(k) for k in upstream_keys))
    downstream_keys = list(dict.fromkeys(_to_key(k) for k in downstream_keys))

    this_schema = schemas.get(asset_key) or {}
    this_cols: list[str] = list(this_schema.get('columns') or [])
    this_dtypes: dict[str, str] = dict(this_schema.get('dtypes') or {})

    # Build upstream + downstream ColumnLineageAsset entries. Missing
    # schemas render as empty lists so the frontend can flag them.
    upstream = [
        ColumnLineageAsset(
            asset_key=k,
            columns=list((schemas.get(k) or {}).get('columns') or []),
        )
        for k in upstream_keys
    ]
    downstream = [
        ColumnLineageAsset(
            asset_key=k,
            columns=list((schemas.get(k) or {}).get('columns') or []),
        )
        for k in downstream_keys
    ]

    upstream_edges: list[ColumnLineageEdge] = []
    dropped_from_upstream: list[str] = []

    # Heuristic 1 — name match: if this asset has column X and any
    # upstream also has X, edge upstream.X → this.X with confidence 1.
    for up in upstream:
        this_cols_set = set(this_cols)
        for col in up.columns:
            if col in this_cols_set:
                upstream_edges.append(ColumnLineageEdge(
                    from_asset=up.asset_key,
                    from_column=col,
                    to_asset=asset_key,
                    to_column=col,
                    confidence=1.0,
                ))
            else:
                # Column exists on upstream but not this asset — dropped.
                dropped_from_upstream.append(f"{up.asset_key}.{col}")

    # Heuristic 2 — derived: any of THIS asset's columns without a
    # name match on any upstream is a derived / calculated / renamed
    # column. Frontend renders these as "derived" chips (no
    # incoming edge, marked with a small ✨ badge).
    upstream_col_names = {c for up in upstream for c in up.columns}
    derived_columns = [c for c in this_cols if c not in upstream_col_names]

    # Downstream edges — mirror image. For every downstream asset,
    # match its columns against this asset's columns to build outgoing
    # edges.
    downstream_edges: list[ColumnLineageEdge] = []
    for dn in downstream:
        this_cols_set = set(this_cols)
        for col in dn.columns:
            if col in this_cols_set:
                downstream_edges.append(ColumnLineageEdge(
                    from_asset=asset_key,
                    from_column=col,
                    to_asset=dn.asset_key,
                    to_column=col,
                    confidence=1.0,
                ))

    return ColumnLineageResponse(
        asset_key=asset_key,
        upstream=upstream,
        downstream=downstream,
        columns=this_cols,
        dtypes=this_dtypes,
        upstream_edges=upstream_edges,
        downstream_edges=downstream_edges,
        derived_columns=derived_columns,
        dropped_from_upstream=dropped_from_upstream,
    )


async def _cloud_ingestion_events(project, limit: int) -> list[dict]:
    """Reconstructs events in the same shape ingestion_history.record_event
    writes locally, from real Dagster+ materialization history --
    per-asset via assetMaterializations, since the frontend filters events
    down to known ingestion asset keys (a run-level event wouldn't carry
    one). `rows`/`bytes` have no Dagster+ GraphQL equivalent (parsed from
    local materialize output, not a standard Dagster concept) and are
    simply omitted; every materialization Dagster reports is inherently a
    success (a failed step doesn't emit one), so status is always
    "success" here."""
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            project.dagster_plus_deployment or "",
            project.dagster_plus_token or "",
            ASSET_MATERIALIZATIONS_QUERY,
            variables={"limit": min(limit, 50)},  # per-asset cap -- this is per assetNode, not a global limit
            region=project.dagster_plus_region,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch materialization history from Dagster+: {e}")
    events: list[dict] = []
    for node in (data.get("assetNodes") or []):
        asset_key = "/".join((node.get("assetKey") or {}).get("path") or [])
        for m in (node.get("assetMaterializations") or []):
            ts_millis = m.get("timestamp")
            if not ts_millis:
                continue
            events.append({
                "ts": datetime.fromtimestamp(int(ts_millis) / 1000, tz=timezone.utc).isoformat(),
                "type": "materialize",
                "asset_key": asset_key,
                "status": "success",
                "run_id": m.get("runId"),
            })
    events.sort(key=lambda e: e["ts"], reverse=True)
    return events[:limit]


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
    # Dagster+ (cloud) projects have no local ingestion log file --
    # reconstruct an equivalent from real materialization history instead
    # of returning empty. "Total rows" won't populate (no Dagster+
    # equivalent for that local-only metric) but 24h count / success rate
    # / the trend chart all work from real data.
    if getattr(project, "is_dagster_plus", False):
        return {"events": await _cloud_ingestion_events(project, limit)}
    project_dir = project_service._get_project_dir(project)
    events = read_events(project_dir, limit=limit)
    return {"events": events}


@router.post("/{project_id}/{asset_key:path}/tag-ingestion")
async def tag_asset_as_ingestion(project_id: str, asset_key: str):
    """Manually mark an asset as an ingestion source, overriding the
    Ingestions tab's automatic heuristic. Needed for assets the heuristic
    has no signal for — e.g. a plain Python asset that calls a REST API
    and writes to Snowflake looks identical to any other transformation
    from the outside. Works for local AND cloud projects since it's just
    an asset-key list, independent of where the asset is defined."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if asset_key not in project.manual_ingestion_asset_keys:
        project.manual_ingestion_asset_keys.append(asset_key)
        project_service._save_project(project)
    return {"manual_ingestion_asset_keys": project.manual_ingestion_asset_keys}


@router.delete("/{project_id}/{asset_key:path}/tag-ingestion")
async def untag_asset_as_ingestion(project_id: str, asset_key: str):
    """Remove a manual ingestion tag (does not affect automatic detection —
    an asset the heuristic already matches stays visible either way)."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if asset_key in project.manual_ingestion_asset_keys:
        project.manual_ingestion_asset_keys.remove(asset_key)
        project_service._save_project(project)
    return {"manual_ingestion_asset_keys": project.manual_ingestion_asset_keys}


class AssetInsightMetric(BaseModel):
    metric_name: str
    label: str
    unit: str  # 'count' | 'credits' | 'ms' | 'percent'
    aggregate_value: float | None
    # Same aggregation over the PRIOR window of equal length (e.g. the
    # 30 days before the requested 30) -- Dagster+'s own
    # aggregate_value_change field on this tool is always 0.0 in
    # practice, so this is computed here instead by fetching double the
    # window and splitting it, rather than trusting that field.
    previous_aggregate_value: float | None
    timestamps: list[float]
    values: list[float]
    # Daily values for the prior period, aligned by day-offset-within-
    # period (previous_values[0] is the same offset into its window as
    # values[0] is into the current one) rather than by calendar date --
    # lets the frontend overlay "this period" vs "the period before it"
    # on one chart without the two lines needing matching timestamps.
    previous_values: list[float]


class AssetInsightsResponse(BaseModel):
    asset_key: str
    window_days: int
    metrics: list[AssetInsightMetric]


# (metric_name, display label, unit, aggregation function) -- a curated
# subset of the ~37 metric types Dagster+ Insights tracks, picked for
# relevance at the single-asset level. Fetched directly via MCP tools,
# not through an LLM -- this is pure fetch-and-display data, so routing
# it through a model would just add latency and cost for no benefit.
_ASSET_INSIGHT_METRICS = [
    ("__dagster_materializations", "Materializations", "count", "SUM"),
    ("__dagster_dagster_credits", "Dagster Credits", "credits", "SUM"),
    ("__dagster_execution_time_ms", "Execution Time", "ms", "SUM"),
    ("__dagster_asset_success_rate", "Success Rate", "percent", "AVERAGE"),
    ("__dagster_run_failures", "Run Failures", "count", "SUM"),
    ("__dagster_observations", "Observations", "count", "SUM"),
    ("__dagster_failed_to_materialize", "Failed to Materialize", "count", "SUM"),
    ("__dagster_step_retries", "Step Retries", "count", "SUM"),
    ("__dagster_asset_check_errors", "Check Errors", "count", "SUM"),
    ("row_count", "Row Count", "count", "LATEST"),
    ("__dagster_asset_check_success_rate", "Check Success Rate", "percent", "AVERAGE"),
    ("__dagster_freshness_pass_rate", "Freshness Pass Rate", "percent", "AVERAGE"),
]


async def _fetch_insight_metric(
    mcp: "Any", tool_name: str, metric_name: str, label: str, unit: str, agg: str,
    window_start: float, window_end: float, deployment_name: str | None, extra_params: dict,
) -> AssetInsightMetric | None:
    """Shared fetch+parse for a single Insights metric, used by the
    per-asset, per-deployment, and asset-breakdown endpoints below --
    they only differ in which MCP tool they call and what extra
    selector params (asset_keys, none) that tool needs.

    Makes TWO separate calls -- the requested window, and the equal-length
    window immediately before it -- rather than one call spanning both.
    Dagster+'s Insights API hard-caps any single query to 120 days
    ("Invalid time range. The maximum allowed time range is 120 days.");
    doubling the window in one call silently broke for any request over
    60 days, and the DagsterPlusMcpError got caught below and swallowed
    into a plain "no data" response -- exactly backwards, since 60-120 day
    windows are the ones a real deployment has the most historical data
    for. Two bounded calls (each ≤ the requested days, capped at 120)
    avoid the limit entirely and run concurrently, so this isn't slower
    than the single wide call was."""
    from ..services.dagster_plus_mcp import DagsterPlusMcpError
    import asyncio as _asyncio

    async def _call(after: float, before: float) -> tuple[float | None, list[float], list[float]] | None:
        try:
            raw = await mcp.call_tool(tool_name, {
                "metric_name": metric_name, "after": after, "before": before,
                "granularity": "DAILY", "aggregation_function": agg,
                "deployment_name": deployment_name,
                **extra_params,
            })
        except DagsterPlusMcpError:
            return None
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        items = data.get("items") or []
        if not items:
            return None
        item = items[0]
        timestamps = data.get("timestamps") or []
        values = [v if v is not None else 0.0 for v in (item.get("values") or [])]
        return item.get("aggregate_value"), timestamps, values

    window_width = window_end - window_start
    current_result, previous_result = await _asyncio.gather(
        _call(window_start, window_end),
        _call(window_start - window_width, window_start),
    )
    if current_result is None:
        return None

    def _reaggregate(vals: list[float]) -> float | None:
        if not vals:
            return None
        if agg == "AVERAGE":
            return sum(vals) / len(vals)
        if agg == "LATEST":
            # A snapshot metric (e.g. row_count) -- re-summing daily
            # values would double/triple count a value that just hasn't
            # changed day to day. Take the most recent day's value
            # instead (values are chronological, oldest first).
            return vals[-1]
        if agg == "MAX":
            return max(vals)
        if agg == "MIN":
            return min(vals)
        return sum(vals)

    current_agg, current_ts, current_vals = current_result
    if current_agg is None:
        current_agg = _reaggregate(current_vals)
    if current_agg is None:
        return None

    previous_agg: float | None = None
    previous_vals: list[float] = []
    if previous_result is not None:
        previous_agg, _prev_ts, previous_vals = previous_result
        if previous_agg is None:
            previous_agg = _reaggregate(previous_vals)

    return AssetInsightMetric(
        metric_name=metric_name, label=label, unit=unit,
        aggregate_value=current_agg,
        previous_aggregate_value=previous_agg,
        timestamps=current_ts,
        values=current_vals,
        previous_values=previous_vals,
    )


@router.get("/{project_id}/{asset_key:path}/insights-metrics", response_model=AssetInsightsResponse)
async def get_asset_insights_metrics(project_id: str, asset_key: str, days: int = 30):
    """Live Dagster+ Insights usage/cost/reliability metrics for a single
    asset over a trailing window, fetched directly via the Dagster+ MCP
    server's reporting-metrics tools. There's no GraphQL equivalent for
    this -- Insights data lives behind a separate internal API that only
    MCP (and the Dagster+ UI itself) expose."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=404, detail="Insights metrics are only available for Dagster+ connections.")

    from ..services.dagster_plus_mcp import DagsterPlusMcpSession, DagsterPlusMcpError
    import asyncio as _asyncio

    days = max(1, min(days, 120))
    before = time.time()
    after = before - days * 86400
    path = [seg for seg in asset_key.split("/") if seg]

    try:
        async with DagsterPlusMcpSession(
            project.dagster_plus_org or "", project.dagster_plus_token or "", project.dagster_plus_region,
        ) as mcp:
            results = await _asyncio.gather(*(
                _fetch_insight_metric(
                    mcp, "get_asset_metrics", name, label, unit, agg, after, before,
                    project.dagster_plus_deployment, {"asset_keys": [path]},
                )
                for name, label, unit, agg in _ASSET_INSIGHT_METRICS
            ))
    except DagsterPlusMcpError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch Insights metrics: {e}")

    metrics = [m for m in results if m is not None]
    return AssetInsightsResponse(asset_key=asset_key, window_days=days, metrics=metrics)


# Deployment-level metrics -- same curated shape as the per-asset set
# above, but a few asset-specific ones (freshness, per-asset success
# rate) don't make sense rolled up, so this is its own, slightly
# broader list including run/queue health.
_DEPLOYMENT_INSIGHT_METRICS = [
    ("__dagster_materializations", "Materializations", "count", "SUM"),
    ("__dagster_dagster_credits", "Dagster Credits", "credits", "SUM"),
    ("__dagster_run_successes", "Run Successes", "count", "SUM"),
    ("__dagster_run_failures", "Run Failures", "count", "SUM"),
    ("__dagster_run_duration_ms", "Run Duration", "ms", "AVERAGE"),
    ("__dagster_step_failures", "Step Failures", "count", "SUM"),
    ("__dagster_failed_to_materialize", "Failed to Materialize", "count", "SUM"),
    ("__dagster_run_queue_time_ms", "Run Queue Time", "ms", "AVERAGE"),
    ("__dagster_observations", "Observations", "count", "SUM"),
    ("row_count", "Row Count", "count", "SUM"),
]

# The metric a caller can pick for the "top assets by ..." breakdown --
# same catalog as the asset-level cards so the two views stay consistent.
_BREAKDOWN_METRICS = {name: (label, unit) for name, label, unit, _agg in _ASSET_INSIGHT_METRICS}


class DeploymentInsightsResponse(BaseModel):
    window_days: int
    metrics: list[AssetInsightMetric]


@router.get("/{project_id}/insights/deployment", response_model=DeploymentInsightsResponse)
async def get_deployment_insights_metrics(project_id: str, days: int = 30):
    """Deployment-wide Insights metrics -- the top-level view before
    drilling into a specific asset's own Insights tab."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=404, detail="Insights metrics are only available for Dagster+ connections.")

    from ..services.dagster_plus_mcp import DagsterPlusMcpSession, DagsterPlusMcpError
    import asyncio as _asyncio

    days = max(1, min(days, 120))
    before = time.time()
    after = before - days * 86400

    try:
        async with DagsterPlusMcpSession(
            project.dagster_plus_org or "", project.dagster_plus_token or "", project.dagster_plus_region,
        ) as mcp:
            results = await _asyncio.gather(*(
                _fetch_insight_metric(
                    mcp, "get_deployment_metrics", name, label, unit, agg, after, before,
                    project.dagster_plus_deployment, {},
                )
                for name, label, unit, agg in _DEPLOYMENT_INSIGHT_METRICS
            ))
    except DagsterPlusMcpError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch deployment Insights metrics: {e}")

    metrics = [m for m in results if m is not None]
    return DeploymentInsightsResponse(window_days=days, metrics=metrics)


class AssetBreakdownRow(BaseModel):
    asset_key: str
    value: float


class AssetBreakdownResponse(BaseModel):
    metric_name: str
    label: str
    unit: str
    window_days: int
    rows: list[AssetBreakdownRow]


@router.get("/{project_id}/insights/breakdown", response_model=AssetBreakdownResponse)
async def get_asset_insights_breakdown(project_id: str, metric_name: str = "__dagster_dagster_credits", days: int = 30):
    """Per-asset breakdown for one metric across every asset in the
    project, sorted highest first -- the "top assets by ..." drill-down
    list on the deployment-level Insights page. Dagster+'s tool caps
    this at its own top-N server-side (observed: 20), which is exactly
    the shape a drill-down list wants anyway."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=404, detail="Insights metrics are only available for Dagster+ connections.")
    if metric_name not in _BREAKDOWN_METRICS:
        raise HTTPException(status_code=400, detail=f"Unknown metric '{metric_name}'.")
    label, unit = _BREAKDOWN_METRICS[metric_name]

    asset_keys = [
        n.data.get("asset_key", "").split("/")
        for n in (project.graph.nodes if project.graph else [])
        if n.node_kind == "asset" and n.data.get("asset_key")
    ]
    if not asset_keys:
        return AssetBreakdownResponse(metric_name=metric_name, label=label, unit=unit, window_days=days, rows=[])

    from ..services.dagster_plus_mcp import DagsterPlusMcpSession, DagsterPlusMcpError

    days = max(1, min(days, 120))
    before = time.time()
    after = before - days * 86400
    # Aggregation function doesn't matter much for a ranking list -- SUM
    # for counts/credits, AVERAGE for rate-shaped metrics (matches the
    # same choice _ASSET_INSIGHT_METRICS makes per metric).
    agg = next((a for n, _, _, a in _ASSET_INSIGHT_METRICS if n == metric_name), "SUM")

    try:
        async with DagsterPlusMcpSession(
            project.dagster_plus_org or "", project.dagster_plus_token or "", project.dagster_plus_region,
        ) as mcp:
            raw = await mcp.call_tool("get_asset_metrics", {
                "metric_name": metric_name, "after": after, "before": before,
                "granularity": "DAILY", "aggregation_function": agg,
                "asset_keys": asset_keys, "deployment_name": project.dagster_plus_deployment,
            })
    except DagsterPlusMcpError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch Insights breakdown: {e}")

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        data = {}
    rows: list[AssetBreakdownRow] = []
    for item in (data.get("items") or []):
        val = item.get("aggregate_value")
        if val is None:
            continue
        key = "/".join(((item.get("entity") or {}).get("assetKey") or {}).get("path") or [])
        if not key:
            continue
        rows.append(AssetBreakdownRow(asset_key=key, value=val))
    rows.sort(key=lambda r: r.value, reverse=True)
    return AssetBreakdownResponse(metric_name=metric_name, label=label, unit=unit, window_days=days, rows=rows)


class JobBreakdownRow(BaseModel):
    job_name: str
    code_location: str | None
    value: float


class JobBreakdownResponse(BaseModel):
    metric_name: str
    label: str
    unit: str
    window_days: int
    rows: list[JobBreakdownRow]


# Metric picker for the job breakdown -- job-flavored (run health/cost),
# reusing the deployment catalog's labels rather than the asset one
# (asset-level concepts like freshness/observations don't apply to a job).
_JOB_BREAKDOWN_METRICS = {name: (label, unit) for name, label, unit, _agg in _DEPLOYMENT_INSIGHT_METRICS}


@router.get("/{project_id}/insights/job-breakdown", response_model=JobBreakdownResponse)
async def get_job_insights_breakdown(project_id: str, metric_name: str = "__dagster_dagster_credits", days: int = 30):
    """Per-job breakdown for one metric across every job in the
    deployment, sorted highest first -- the job-level counterpart to
    get_asset_insights_breakdown. Unlike get_asset_metrics, get_job_metrics
    doesn't require an explicit selector -- omitting `jobs` returns every
    job directly, so there's no need to enumerate them from the project
    graph first."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=404, detail="Insights metrics are only available for Dagster+ connections.")
    if metric_name not in _JOB_BREAKDOWN_METRICS:
        raise HTTPException(status_code=400, detail=f"Unknown metric '{metric_name}'.")
    label, unit = _JOB_BREAKDOWN_METRICS[metric_name]

    from ..services.dagster_plus_mcp import DagsterPlusMcpSession, DagsterPlusMcpError

    days = max(1, min(days, 120))
    before = time.time()
    after = before - days * 86400
    agg = next((a for n, _, _, a in _DEPLOYMENT_INSIGHT_METRICS if n == metric_name), "SUM")

    try:
        async with DagsterPlusMcpSession(
            project.dagster_plus_org or "", project.dagster_plus_token or "", project.dagster_plus_region,
        ) as mcp:
            raw = await mcp.call_tool("get_job_metrics", {
                "metric_name": metric_name, "after": after, "before": before,
                "granularity": "DAILY", "aggregation_function": agg,
                "deployment_name": project.dagster_plus_deployment,
            })
    except DagsterPlusMcpError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch job Insights breakdown: {e}")

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        data = {}
    rows: list[JobBreakdownRow] = []
    for item in (data.get("items") or []):
        val = item.get("aggregate_value")
        if val is None:
            continue
        entity = item.get("entity") or {}
        job_name = entity.get("jobName") or ""
        # Dagster's own auto-generated "materialize everything" implicit
        # job, not something a user created -- noise in a ranking list.
        if not job_name or job_name.startswith("__"):
            continue
        rows.append(JobBreakdownRow(job_name=job_name, code_location=entity.get("codeLocationName"), value=val))
    rows.sort(key=lambda r: r.value, reverse=True)
    return JobBreakdownResponse(metric_name=metric_name, label=label, unit=unit, window_days=days, rows=rows)


class JobInsightsResponse(BaseModel):
    job_name: str
    window_days: int
    metrics: list[AssetInsightMetric]


async def _resolve_job_selector(mcp: "Any", job_name: str, deployment_name: str | None) -> dict | None:
    """Look up a job's (repository_name, code_location_name) qualifier.
    get_job_metrics' `jobs` selector 500s when given a bare job_name
    without these -- there's no dedicated "list jobs" tool, so this
    reuses the same no-selector call get_job_insights_breakdown makes
    (cheap: one metric, a short window) and picks out the matching
    entity's qualifier fields."""
    before = time.time()
    after = before - 7 * 86400
    try:
        raw = await mcp.call_tool("get_job_metrics", {
            "metric_name": "__dagster_dagster_credits", "after": after, "before": before,
            "granularity": "DAILY", "aggregation_function": "SUM",
            "deployment_name": deployment_name,
        })
    except Exception:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    for item in (data.get("items") or []):
        entity = item.get("entity") or {}
        if entity.get("jobName") == job_name:
            return {
                "jobs": [{
                    "job_name": job_name,
                    "repository_name": entity.get("repositoryName"),
                    "code_location_name": entity.get("codeLocationName"),
                }],
            }
    return None


@router.get("/{project_id}/insights/job-metrics", response_model=JobInsightsResponse)
async def get_job_insights_metrics(project_id: str, job_name: str, days: int = 30):
    """Live per-job Insights metrics over a trailing window -- the job-level
    counterpart to get_asset_insights_metrics. Powers a richer job detail
    view than the plain "no pipeline selected" the Automation tab's job
    dialog showed before."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=404, detail="Insights metrics are only available for Dagster+ connections.")

    from ..services.dagster_plus_mcp import DagsterPlusMcpSession, DagsterPlusMcpError
    import asyncio as _asyncio

    days = max(1, min(days, 120))
    before = time.time()
    after = before - days * 86400

    try:
        async with DagsterPlusMcpSession(
            project.dagster_plus_org or "", project.dagster_plus_token or "", project.dagster_plus_region,
        ) as mcp:
            selector = await _resolve_job_selector(mcp, job_name, project.dagster_plus_deployment)
            if selector is None:
                raise HTTPException(status_code=404, detail=f"Job '{job_name}' not found in Dagster+ Insights.")
            results = await _asyncio.gather(*(
                _fetch_insight_metric(
                    mcp, "get_job_metrics", name, label, unit, agg, after, before,
                    project.dagster_plus_deployment, selector,
                )
                for name, label, unit, agg in _DEPLOYMENT_INSIGHT_METRICS
            ))
    except DagsterPlusMcpError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch job Insights metrics: {e}")

    metrics = [m for m in results if m is not None]
    return JobInsightsResponse(job_name=job_name, window_days=days, metrics=metrics)


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
                        find_uv_binary("uvx"), "--from", "dagster-community-components-cli",
                        "dagster-component", "add", "dataframe_transformer",
                        "--auto-install", "--manager", "uv", "--force",
                    ],
                    cwd=str(project_dir),
                    # See templates_registry.py's identical install call for
                    # why: --manager uv makes the CLI itself shell out to
                    # bare "uv" internally, which needs our bundled uv on
                    # PATH to find it.
                    env=env_with_bundled_uv_on_path(),
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
