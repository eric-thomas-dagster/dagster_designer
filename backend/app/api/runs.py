"""Runs API -- unified view of Dagster run history from either the
local `dagster dev` GraphQL endpoint (default port 3000) or the
Dagster+ deployment. Same JSON shape returned in both cases so the
frontend RunsPanel doesn't branch by project type.

Design decisions:
  * We paginate with a cursor (opaque to the frontend, passed straight
    back for the next page). Standard Dagster GraphQL pagination.
  * `runsOrError` supports a `filter` field with statuses, tags, job
    name, run id. We surface the two we expect users to reach for:
    status filter and job-name filter. Others can be added later.
  * For local projects, we hit the local webserver. If it isn't running,
    return a clear error rather than a generic 500 -- the panel then
    shows a "Start Dagster dev to see runs" state.
"""
from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.project_service import project_service
from ..services.dagster_plus_client import query as dp_query, DagsterPlusError, RUNS_QUERY


router = APIRouter(prefix="/projects", tags=["runs"])


class Run(BaseModel):
    run_id: str
    job_name: str | None = None
    pipeline_name: str | None = None
    status: str                  # QUEUED | STARTING | STARTED | SUCCESS | FAILURE | CANCELED ...
    start_time: float | None = None
    end_time: float | None = None
    steps_succeeded: int | None = None
    steps_failed: int | None = None
    materializations: int | None = None


class RunsListResponse(BaseModel):
    runs: list[Run]
    # `next_cursor` is null when there are no more pages. When present,
    # the frontend passes it back as `cursor` on the next request.
    next_cursor: str | None = None
    source: str                  # 'cloud' | 'local'
    error: str | None = None     # populated on non-fatal issues (e.g. local dev not running)


LOCAL_GRAPHQL_URL_TEMPLATE = "http://localhost:{port}/graphql"


async def _fetch_local_runs_v2(
    port: int,
    limit: int,
    cursor: str | None,
    *,
    statuses: list[str] | None = None,
    job_name: str | None = None,
    tags: list[dict[str, str]] | None = None,
    created_after: float | None = None,
    created_before: float | None = None,
    updated_after: float | None = None,
) -> dict[str, Any]:
    """Hit the local dagster dev GraphQL endpoint with the full filter
    surface. Same response shape as cloud so callers don't branch."""
    url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=port)
    body: dict[str, Any] = {
        "query": RUNS_QUERY,
        "variables": {
            "limit": limit,
            "cursor": cursor,
            "filter": _build_filter(
                statuses=statuses,
                job_name=job_name,
                tags=tags,
                created_after=created_after,
                created_before=created_before,
                updated_after=updated_after,
            ),
        },
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(url, json=body, headers={"content-type": "application/json"})
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Local Dagster GraphQL returned HTTP {r.status_code}. Is `dg dev` running?")
    data = r.json()
    if data.get("errors"):
        msg = "; ".join(e.get("message", "") for e in data["errors"])
        raise HTTPException(status_code=502, detail=f"GraphQL errors from local Dagster: {msg}")
    return data.get("data") or {}


def _build_filter(
    statuses: list[str] | None = None,
    job_name: str | None = None,
    tags: list[dict[str, str]] | None = None,
    created_after: float | None = None,
    created_before: float | None = None,
    updated_after: float | None = None,
) -> dict[str, Any] | None:
    """Compose the Dagster GraphQL RunsFilter dict, or None if empty.
    Supports the full RunsFilter surface: statuses, pipelineName (job),
    tags (including `dagster/code_location` for code-location filter),
    createdAfter/Before, updatedAfter."""
    f: dict[str, Any] = {}
    if statuses:
        f["statuses"] = [s.upper() for s in statuses if s]
    if job_name:
        f["pipelineName"] = job_name
    if tags:
        # RunsFilter expects [{key, value}] tag entries; drop any with
        # empty keys/values so a partial user input doesn't blow up the
        # server-side validator.
        clean = [{"key": t.get("key", ""), "value": t.get("value", "")} for t in tags if t.get("key")]
        if clean:
            f["tags"] = clean
    if created_after is not None:
        f["createdAfter"] = created_after
    if created_before is not None:
        f["createdBefore"] = created_before
    if updated_after is not None:
        f["updatedAfter"] = updated_after
    return f or None


def _normalize_runs(payload: dict[str, Any]) -> tuple[list[Run], str | None]:
    """Convert the run list response into our Run models + derive a
    next-cursor from the last runId (Dagster's paginated APIs treat the
    last returned runId as the cursor for the next page). Accepts
    either the modern `pipelineRunsOrError` or the older `runsOrError`
    top-level so we work across schema versions."""
    node = payload.get("runsOrError") or payload.get("pipelineRunsOrError") or {}
    if node.get("__typename") == "PythonError":
        raise HTTPException(status_code=502, detail=(node.get("message") or "Dagster GraphQL error"))
    results = node.get("results") or []
    runs: list[Run] = []
    for r in results:
        stats = r.get("stats") or {}
        runs.append(Run(
            run_id=r.get("runId") or "",
            # pipelineName is universal; we surface it as job_name too so
            # the UI has a name to show even on schemas without jobName.
            job_name=r.get("pipelineName"),
            pipeline_name=r.get("pipelineName"),
            status=(r.get("status") or "").upper(),
            start_time=r.get("startTime"),
            end_time=r.get("endTime"),
            steps_succeeded=stats.get("stepsSucceeded"),
            steps_failed=stats.get("stepsFailed"),
            materializations=stats.get("materializations"),
        ))
    next_cursor = runs[-1].run_id if runs else None
    return runs, next_cursor


class TagFilter(BaseModel):
    key: str
    value: str = ""


class RunsQueryParams(BaseModel):
    limit: int = 25
    cursor: str | None = None
    statuses: list[str] | None = None       # ['SUCCESS', 'FAILURE', ...]
    job_name: str | None = None              # matches RunsFilter.pipelineName
    tags: list[TagFilter] | None = None      # [{key, value}, ...]
    # Free-form "code location" filter -- Dagster tags runs with
    # `dagster/code_location` on Dagster+ deployments. We map the
    # convenience field to a tag filter so users don't have to know
    # the underlying tag name.
    code_location: str | None = None
    created_after: float | None = None       # unix seconds
    created_before: float | None = None
    updated_after: float | None = None


@router.post("/{project_id}/runs/query", response_model=RunsListResponse)
async def query_runs(project_id: str, params: RunsQueryParams):
    """Paginated list of runs. POST rather than GET so we can accept a
    structured filter body without cramming everything into query params."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    limit = max(1, min(params.limit or 25, 100))

    # ---- Cloud path -----------------------------------------------------
    if getattr(project, "is_dagster_plus", False):
        # Merge convenience code_location filter into the tags list
        # -- Dagster+ tags runs with `dagster/code_location = <name>`.
        merged_tags: list[dict[str, str]] = [t.model_dump() for t in (params.tags or [])]
        if params.code_location:
            merged_tags.append({"key": "dagster/code_location", "value": params.code_location})
        filt = _build_filter(
            statuses=params.statuses,
            job_name=params.job_name,
            tags=merged_tags,
            created_after=params.created_after,
            created_before=params.created_before,
            updated_after=params.updated_after,
        )
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                RUNS_QUERY,
                variables={
                    "limit": limit,
                    "cursor": params.cursor,
                    "filter": filt,
                },
            )
        except DagsterPlusError as e:
            raise HTTPException(status_code=502, detail=str(e))
        runs, next_cursor = _normalize_runs(data)
        return RunsListResponse(
            runs=runs,
            next_cursor=next_cursor if len(runs) == limit else None,
            source="cloud",
        )

    # ---- Local path -----------------------------------------------------
    # Talk to the local dagster dev GraphQL. If dev isn't running,
    # httpx will fail with ConnectError -- return a helpful message so
    # the panel shows "start dev" instead of a scary 500.
    port = 3000  # dagster dev default; could be overridden per-project later
    merged_tags = [t.model_dump() for t in (params.tags or [])]
    if params.code_location:
        merged_tags.append({"key": "dagster/code_location", "value": params.code_location})
    try:
        data = await _fetch_local_runs_v2(
            port, limit, params.cursor,
            statuses=params.statuses,
            job_name=params.job_name,
            tags=merged_tags,
            created_after=params.created_after,
            created_before=params.created_before,
            updated_after=params.updated_after,
        )
    except HTTPException:
        raise
    except httpx.ConnectError:
        return RunsListResponse(
            runs=[], next_cursor=None, source="local",
            error=f"Local Dagster GraphQL isn't running (looked at localhost:{port}). Start `dg dev` -- either via Actions > Open Dagster UI, or the button on this page.",
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Local Dagster GraphQL error: {e}")

    runs, next_cursor = _normalize_runs(data)
    return RunsListResponse(
        runs=runs,
        next_cursor=next_cursor if len(runs) == limit else None,
        source="local",
    )


class RunStatusResponse(BaseModel):
    run_id: str
    status: str
    error: str | None = None


class CodeLocationsResponse(BaseModel):
    code_locations: list[str]
    source: str                  # 'local' | 'cloud'


# Enumerate code locations via `workspaceOrError.locationEntries` —
# that's the shape Dagster+ ships (matches the built-in
# CodeLocationStatusQuery). Each entry's `name` is the location name
# used in the `dagster/code_location` tag we filter on. We also fall
# back to `repositoriesOrError` which every version exposes.
CODE_LOCATIONS_QUERY = """
query CodeLocations {
  workspaceOrError {
    __typename
    ... on Workspace {
      locationEntries {
        name
      }
    }
  }
  repositoriesOrError {
    __typename
    ... on RepositoryConnection {
      nodes {
        name
        location { name }
      }
    }
  }
}
"""


@router.get("/{project_id}/runs/code-locations", response_model=CodeLocationsResponse)
async def list_code_locations(project_id: str):
    """Return distinct code-location names, used to populate the
    Runs page code-location filter dropdown. Local mode hits local
    dagster dev; cloud mode uses the Dagster+ GraphQL endpoint."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if getattr(project, "is_dagster_plus", False):
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                CODE_LOCATIONS_QUERY,
            )
        except DagsterPlusError as e:
            raise HTTPException(status_code=502, detail=str(e))
        return CodeLocationsResponse(
            code_locations=_extract_location_names(data), source="cloud",
        )

    port = 3000
    url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=port)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(url, json={"query": CODE_LOCATIONS_QUERY},
                                  headers={"content-type": "application/json"})
    except httpx.ConnectError:
        return CodeLocationsResponse(code_locations=[], source="local")
    if r.status_code >= 400:
        return CodeLocationsResponse(code_locations=[], source="local")
    return CodeLocationsResponse(
        code_locations=_extract_location_names(r.json().get("data") or {}),
        source="local",
    )


class TagKeysResponse(BaseModel):
    tag_keys: list[str]


class TagValuesResponse(BaseModel):
    key: str
    values: list[str]


# Dagster GraphQL exposes both. `runTagKeysOrError` gives the full set
# of known tag keys; `runTagsOrError(tagKeys: [...])` gives values for
# a specific key. Both power the "filter by tag" dropdowns.
RUN_TAG_KEYS_QUERY = """
query RunTagKeys {
  runTagKeysOrError {
    __typename
    ... on RunTagKeys { keys }
  }
}
"""

RUN_TAG_VALUES_QUERY = """
query RunTagValues($tagKeys: [String!]!) {
  runTagsOrError(tagKeys: $tagKeys) {
    __typename
    ... on RunTags {
      tags { key values }
    }
  }
}
"""


async def _run_local_query(port: int, query: str, variables: dict | None = None) -> dict[str, Any]:
    url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=port)
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            url,
            json={"query": query, "variables": variables or {}},
            headers={"content-type": "application/json"},
        )
    if r.status_code >= 400:
        return {}
    body = r.json()
    return body.get("data") or {}


@router.get("/{project_id}/runs/tag-keys", response_model=TagKeysResponse)
async def list_tag_keys(project_id: str):
    """Distinct tag keys across recent runs. Powers the tag-key dropdown
    on the Runs filter row."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if getattr(project, "is_dagster_plus", False):
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                RUN_TAG_KEYS_QUERY,
            )
        except DagsterPlusError:
            return TagKeysResponse(tag_keys=[])
    else:
        try:
            data = await _run_local_query(3000, RUN_TAG_KEYS_QUERY)
        except httpx.ConnectError:
            return TagKeysResponse(tag_keys=[])

    node = data.get("runTagKeysOrError") or {}
    keys = node.get("keys") or []
    return TagKeysResponse(tag_keys=sorted(set(k for k in keys if k)))


@router.get("/{project_id}/runs/tag-values", response_model=TagValuesResponse)
async def list_tag_values(project_id: str, key: str):
    """Distinct values for a specific tag key. Powers the value dropdown
    once the user picks a tag key."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not key:
        return TagValuesResponse(key="", values=[])

    if getattr(project, "is_dagster_plus", False):
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                RUN_TAG_VALUES_QUERY,
                variables={"tagKeys": [key]},
            )
        except DagsterPlusError:
            return TagValuesResponse(key=key, values=[])
    else:
        try:
            data = await _run_local_query(3000, RUN_TAG_VALUES_QUERY, {"tagKeys": [key]})
        except httpx.ConnectError:
            return TagValuesResponse(key=key, values=[])

    node = data.get("runTagsOrError") or {}
    values: list[str] = []
    for t in (node.get("tags") or []):
        if t.get("key") == key:
            values.extend(t.get("values") or [])
    return TagValuesResponse(key=key, values=sorted(set(v for v in values if v)))


def _extract_location_names(data: dict[str, Any]) -> list[str]:
    """Pull location names from either `workspaceOrError.locationEntries`
    (Dagster+'s preferred shape) or `repositoriesOrError.nodes[].location.name`
    (universal fallback)."""
    names: set[str] = set()
    ws = data.get("workspaceOrError") or {}
    for e in (ws.get("locationEntries") or []):
        n = (e or {}).get("name")
        if n:
            names.add(n)
    repos = data.get("repositoriesOrError") or {}
    for r in (repos.get("nodes") or []):
        loc = (r or {}).get("location") or {}
        n = loc.get("name")
        if n:
            names.add(n)
    return sorted(names)


# In modern Dagster the top-level field is `runOrError` and the type
# is `Run`. Kept to the fields that reliably exist across recent
# versions. Step stats + materializations are split into their own
# probe queries so a schema mismatch on either doesn't kill the whole
# response.
RUN_DETAIL_QUERY = """
query RunDetail($runId: ID!) {
  runOrError(runId: $runId) {
    __typename
    ... on Run {
      runId
      status
      pipelineName
      startTime
      endTime
      runConfigYaml
      tags { key value }
      executionPlan {
        steps {
          key
          kind
          inputs { dependsOn { key } }
        }
      }
      stats {
        ... on RunStatsSnapshot {
          stepsSucceeded
          stepsFailed
          materializations
        }
      }
    }
    ... on RunNotFoundError { message }
    ... on PythonError { message stack }
  }
}
"""

# Step stats -- best-effort. The concrete type might be RunStepStats
# or PipelineRunStepStats depending on the Dagster version; querying
# `stepStats` directly should work either way as long as the fields
# on the objects are correct.
RUN_STEP_STATS_QUERY = """
query RunStepStats($runId: ID!) {
  runOrError(runId: $runId) {
    __typename
    ... on Run {
      stepStats {
        stepKey
        status
        startTime
        endTime
        attempts { startTime endTime }
      }
    }
  }
}
"""

# Separate query so materializations schema drift doesn't take down
# the whole detail view.
RUN_MATERIALIZATIONS_QUERY = """
query RunMats($runId: ID!) {
  runOrError(runId: $runId) {
    __typename
    ... on Run {
      assetMaterializations {
        assetKey { path }
        partition
        timestamp
        metadataEntries { __typename label description }
      }
    }
  }
}
"""


class RunStep(BaseModel):
    step_key: str
    status: str
    start_time: float | None = None
    end_time: float | None = None


class RunMaterialization(BaseModel):
    asset_key: str
    partition: str | None = None
    timestamp: float | None = None
    metadata: list[dict] = []


class StepEdge(BaseModel):
    """Directed edge in the execution plan DAG. `from_step` produces
    a value that `to_step` consumes as one of its inputs."""
    from_step: str
    to_step: str


class RunDetailResponse(BaseModel):
    run_id: str
    job_name: str | None = None
    pipeline_name: str | None = None
    status: str
    start_time: float | None = None
    end_time: float | None = None
    run_config_yaml: str | None = None
    tags: dict[str, str] = {}
    steps: list[RunStep] = []
    step_edges: list[StepEdge] = []       # execution-plan DAG edges
    materializations: list[RunMaterialization] = []
    steps_succeeded: int | None = None
    steps_failed: int | None = None
    source: str    # 'cloud' | 'local'
    external_url: str | None = None


@router.get("/{project_id}/runs/{run_id}", response_model=RunDetailResponse)
async def get_run_detail(project_id: str, run_id: str):
    """Detailed view of a single run -- status, steps, materializations,
    config, tags. Same shape whether it comes from local dagster dev or
    Dagster+, so the frontend RunDetailPage has one code path."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    variables = {"runId": run_id}

    async def _run_query(gql: str, strict: bool = True) -> dict:
        """Run a GraphQL query against the appropriate endpoint. When
        `strict` is True (default), any top-level `errors` array raises
        HTTP 502. When strict=False we log and return whatever partial
        `data` came back -- useful for optional field probes where we
        don't want a single missing field to sink the whole endpoint."""
        if getattr(project, "is_dagster_plus", False):
            try:
                return await dp_query(
                    project.dagster_plus_org or "",
                    project.dagster_plus_deployment or "",
                    project.dagster_plus_token or "",
                    gql,
                    variables=variables,
                )
            except DagsterPlusError as e:
                if strict:
                    raise HTTPException(status_code=502, detail=str(e))
                print(f"[runs] non-strict Dagster+ error: {e}", flush=True)
                return {}
        url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=3000)
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(url, json={"query": gql, "variables": variables})
        except httpx.ConnectError:
            raise HTTPException(status_code=502, detail="Local Dagster GraphQL isn't running. Start `dg dev` first.")
        except Exception as e:
            if strict:
                raise HTTPException(status_code=502, detail=f"Local Dagster GraphQL error: {e}")
            print(f"[runs] non-strict local error: {e}", flush=True)
            return {}
        try:
            body = r.json()
        except Exception:
            if strict:
                raise HTTPException(status_code=502, detail=f"Non-JSON response from local Dagster GraphQL (HTTP {r.status_code}).")
            return {}
        # Surface GraphQL errors -- these are the real failure mode when
        # the schema drifts (unknown field, wrong type, etc.). Without
        # this we'd fall through and return 404 with a misleading message.
        if body.get("errors"):
            msgs = "; ".join(e.get("message", "") for e in body["errors"])
            if strict:
                raise HTTPException(status_code=502, detail=f"GraphQL errors from local Dagster: {msgs}")
            # Non-strict: log and return the (possibly partial) data.
            print(f"[runs] non-strict GraphQL errors on optional query: {msgs}", flush=True)
        return body.get("data") or {}

    source = "cloud" if getattr(project, "is_dagster_plus", False) else "local"
    data = await _run_query(RUN_DETAIL_QUERY)
    node = data.get("runOrError") or {}
    tn = node.get("__typename")
    if tn in ("RunNotFoundError", "PipelineRunNotFoundError"):
        raise HTTPException(status_code=404, detail=node.get("message") or f"Run {run_id} not found")
    if tn == "PythonError":
        raise HTTPException(status_code=502, detail=node.get("message", "Dagster GraphQL error"))
    if not node or tn != "Run":
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    # Tags list [{key, value}] -> dict
    tags = {t.get("key"): t.get("value") for t in (node.get("tags") or []) if t.get("key")}

    # Step stats -- best-effort probe. If it fails, we fall back to
    # deriving step keys from the execution plan (no timings, just
    # structure). This keeps the lineage view working even when
    # stepStats is unavailable / empty (e.g. runs that haven't
    # produced stats yet).
    steps: list[RunStep] = []
    step_stats_by_key: dict[str, dict] = {}
    # For each original stepKey, the retry-chain expansion produces
    # multiple attempt nodes. These maps let the edge builder wire
    # upstream edges into the FIRST attempt of each downstream step and
    # downstream edges out of the LAST attempt of each upstream step.
    first_attempt_key: dict[str, str] = {}   # original key -> node key of attempt-0
    last_attempt_key: dict[str, str] = {}    # original key -> node key of final attempt
    retry_edges: list[StepEdge] = []         # attempt-i -> attempt-i+1 for each retried step
    try:
        step_data = await _run_query(RUN_STEP_STATS_QUERY, strict=False)
        step_node = step_data.get("runOrError") or {}
        for s in (step_node.get("stepStats") or []):
            key = s.get("stepKey") or ""
            if not key:
                continue
            step_stats_by_key[key] = s
            attempts = s.get("attempts") or []
            final_status = (s.get("status") or "").upper()
            # 0 or 1 attempts -> single node, matches the existing shape.
            # 2+ attempts -> N nodes chained together. The last node keeps
            # the original key (so click-to-filter-logs by step key still
            # works). Earlier attempts get a `#attempt-N` suffix and status
            # RETRY (frontend renders that as orange).
            if len(attempts) <= 1:
                steps.append(RunStep(
                    step_key=key,
                    status=final_status,
                    start_time=s.get("startTime"),
                    end_time=s.get("endTime"),
                ))
                first_attempt_key[key] = key
                last_attempt_key[key] = key
            else:
                node_keys: list[str] = []
                for i, a in enumerate(attempts):
                    is_last = (i == len(attempts) - 1)
                    node_key = key if is_last else f"{key}#attempt-{i}"
                    node_keys.append(node_key)
                    steps.append(RunStep(
                        step_key=node_key,
                        # Earlier attempts by definition failed and got
                        # retried. Frontend renders RETRIED as orange.
                        status=final_status if is_last else "RETRIED",
                        start_time=a.get("startTime"),
                        end_time=a.get("endTime"),
                    ))
                first_attempt_key[key] = node_keys[0]
                last_attempt_key[key] = node_keys[-1]
                # Chain attempts: attempt-0 -> attempt-1 -> ... -> final.
                for a, b in zip(node_keys, node_keys[1:]):
                    retry_edges.append(StepEdge(from_step=a, to_step=b))
    except Exception as e:
        print(f"[runs] stepStats probe failed: {e}", flush=True)

    # Fallback: if the step-stats query returned nothing, derive
    # placeholder steps from the execution plan so the lineage view
    # still has nodes. Status is 'UNKNOWN' since we don't have runtime data.
    if not steps:
        plan = node.get("executionPlan") or {}
        for s in (plan.get("steps") or []):
            key = s.get("key")
            if key:
                steps.append(RunStep(step_key=key, status="UNKNOWN"))

    # Best-effort materializations fetch. Runs its own query so a
    # schema mismatch on assetMaterializations doesn't take down the
    # rest of the detail response.
    mats: list[RunMaterialization] = []
    try:
        mat_data = await _run_query(RUN_MATERIALIZATIONS_QUERY)
        mat_node = mat_data.get("runOrError") or {}
        for m in (mat_node.get("assetMaterializations") or []):
            mats.append(RunMaterialization(
                asset_key="/".join((m.get("assetKey") or {}).get("path") or []),
                partition=m.get("partition"),
                timestamp=m.get("timestamp"),
                metadata=[{
                    "label": me.get("label"),
                    "description": me.get("description"),
                    "type": me.get("__typename"),
                } for me in (m.get("metadataEntries") or [])],
            ))
    except HTTPException:
        # Non-fatal -- users still see all the other run info.
        pass

    stats = node.get("stats") or {}

    # Execution-plan DAG edges. Two tricky bits handled here:
    #
    #  1. `executionPlan.steps` returns BASE op names (`process_chunk`)
    #     while `stepStats` returns RUNTIME instance keys
    #     (`process_chunk[0]`, `[1]`, ...) for dynamic fan-outs. We
    #     match instances back to their base by stripping the `[...]`
    #     suffix, then EXPAND each base-level edge across every
    #     runtime instance so the DAG shows the actual fan-out
    #     (`split_rows -> process_chunk[0..N] -> concat`).
    #
    #  2. Dedup: a step often reads from the same upstream via
    #     multiple named inputs; collapse duplicate edges to one.
    import re
    _dyn_suffix = re.compile(r"\[[^\]]*\]$")
    def _base(k: str) -> str:
        return _dyn_suffix.sub("", k)

    # base name -> [runtime instance ORIGINAL keys]. We deliberately
    # key by the ORIGINAL step keys (not the attempt-suffixed ones)
    # because the execution plan talks in original keys. The edge
    # builder then bridges from `last_attempt_key[original]` (of the
    # upstream step) to `first_attempt_key[original]` (of the
    # downstream step). Non-dynamic ops fall through as base == original.
    original_keys = set(first_attempt_key.keys())
    by_base: dict[str, list[str]] = {}
    for k in original_keys:
        by_base.setdefault(_base(k), []).append(k)

    step_edges: list[StepEdge] = list(retry_edges)   # start with retry chain
    plan = node.get("executionPlan") or {}
    for step in (plan.get("steps") or []):
        to_key = step.get("key")
        if not to_key:
            continue
        # Strip `[?]` / `[N]` before lookup -- the execution plan uses
        # `process_chunk[?]` as a placeholder for the runtime instances
        # `process_chunk[0..N]`. Without stripping we'd miss the whole
        # fan-out (`by_base` is keyed on the stripped base name).
        to_base = _base(to_key)
        to_instances = by_base.get(to_base) or ([to_key] if to_key in original_keys else [])
        if not to_instances:
            continue
        for inp in (step.get("inputs") or []):
            for dep in (inp.get("dependsOn") or []):
                from_key = dep.get("key")
                if not from_key:
                    continue
                from_base = _base(from_key)
                from_instances = by_base.get(from_base) or (
                    [from_key] if from_key in original_keys else []
                )
                for f in from_instances:
                    for t in to_instances:
                        if f != t:
                            # Route upstream from the last attempt of f
                            # into the first attempt of t so retries chain
                            # naturally between them.
                            step_edges.append(StepEdge(
                                from_step=last_attempt_key.get(f, f),
                                to_step=first_attempt_key.get(t, t),
                            ))

    seen_edges: set[tuple[str, str]] = set()
    deduped: list[StepEdge] = []
    for e in step_edges:
        key = (e.from_step, e.to_step)
        if key in seen_edges:
            continue
        seen_edges.add(key)
        deduped.append(e)
    step_edges = deduped

    # Debug: log what we resolved so we can diagnose miswired DAGs
    # without asking the user to open devtools. Cheap, one-line-per-run.
    plan_keys = [(s.get("key") or "") for s in (plan.get("steps") or [])]
    print(
        f"[runs] {run_id[:8]} plan_steps={len(plan_keys)} plan_keys={plan_keys[:6]}{'...' if len(plan_keys) > 6 else ''} "
        f"runtime_steps={len(steps)} original_keys={len(original_keys)} retries={len(retry_edges)} "
        f"by_base_keys={list(by_base.keys())[:6]} edges={len(step_edges)}",
        flush=True,
    )

    # External URL to open in Dagster UI (as a fallback for logs)
    external_url = None
    if source == "cloud":
        org = (project.dagster_plus_org or "").replace(".dagster.cloud", "").replace(".dagster.plus", "").split(".")[0]
        dep = project.dagster_plus_deployment or ""
        external_url = f"https://{org}.dagster.cloud/{dep}/runs/{run_id}" if dep else f"https://{org}.dagster.cloud/runs/{run_id}"
    else:
        external_url = f"http://localhost:3000/runs/{run_id}"

    return RunDetailResponse(
        run_id=node.get("runId") or run_id,
        # `jobName` was removed from the query (not in every schema);
        # fall back to `pipelineName` which is the modern universal field.
        job_name=node.get("pipelineName"),
        pipeline_name=node.get("pipelineName"),
        status=(node.get("status") or "").upper(),
        start_time=node.get("startTime"),
        end_time=node.get("endTime"),
        run_config_yaml=node.get("runConfigYaml"),
        tags=tags,
        steps=steps,
        step_edges=step_edges,
        materializations=mats,
        steps_succeeded=stats.get("stepsSucceeded"),
        steps_failed=stats.get("stepsFailed"),
        source=source,
        external_url=external_url,
    )


RUN_LOGS_QUERY = """
query RunLogs($runId: ID!, $cursor: String, $limit: Int) {
  logsForRun(runId: $runId, afterCursor: $cursor, limit: $limit) {
    __typename
    ... on EventConnection {
      events {
        __typename
        ... on MessageEvent {
          runId
          message
          level
          timestamp
          stepKey
          eventType
        }
      }
      cursor
      hasMore
    }
    ... on RunNotFoundError { message }
    ... on PythonError { message }
  }
}
"""


class LogEvent(BaseModel):
    type_name: str            # e.g. LogMessageEvent, StepSuccessEvent
    message: str | None = None
    level: str | None = None   # DEBUG / INFO / WARNING / ERROR / CRITICAL
    timestamp: float | None = None
    step_key: str | None = None


class RunLogsResponse(BaseModel):
    events: list[LogEvent]
    cursor: str | None = None
    has_more: bool = False
    source: str
    error: str | None = None


@router.get("/{project_id}/runs/{run_id}/logs", response_model=RunLogsResponse)
async def get_run_logs(
    project_id: str,
    run_id: str,
    cursor: str | None = None,
    limit: int = 200,
):
    """Structured event log for a single run. Cursor-paginated so
    tail-poll works without re-fetching the full history each cycle.
    Same shape whether the run lives locally or on Dagster+."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    variables = {"runId": run_id, "cursor": cursor, "limit": max(1, min(limit, 1000))}

    if getattr(project, "is_dagster_plus", False):
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                RUN_LOGS_QUERY,
                variables=variables,
            )
        except DagsterPlusError as e:
            raise HTTPException(status_code=502, detail=str(e))
        source = "cloud"
    else:
        url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=3000)
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(url, json={"query": RUN_LOGS_QUERY, "variables": variables})
            body = r.json()
        except httpx.ConnectError:
            return RunLogsResponse(events=[], source="local", error="Local Dagster GraphQL isn't running. Start `dg dev` first.")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Local Dagster GraphQL error: {e}")
        # Surface GraphQL errors -- previously they were being swallowed
        # and the frontend just saw an empty log list. If the schema
        # drifted on the events fragment, users see the exact issue.
        if body.get("errors"):
            msgs = "; ".join(e.get("message", "") for e in body["errors"])
            raise HTTPException(status_code=502, detail=f"GraphQL errors from local Dagster logs: {msgs}")
        data = body.get("data") or {}
        source = "local"

    node = data.get("logsForRun") or {}
    tn = node.get("__typename")
    if tn == "RunNotFoundError":
        raise HTTPException(status_code=404, detail=node.get("message", "Run not found"))
    if tn == "PythonError":
        raise HTTPException(status_code=502, detail=node.get("message", "Log fetch error"))

    events: list[LogEvent] = []
    for e in (node.get("events") or []):
        events.append(LogEvent(
            type_name=e.get("__typename") or "",
            message=e.get("message"),
            level=e.get("level"),
            timestamp=e.get("timestamp"),
            step_key=e.get("stepKey"),
        ))
    return RunLogsResponse(
        events=events,
        cursor=node.get("cursor"),
        has_more=bool(node.get("hasMore")),
        source=source,
    )


# --- Re-execution / termination ---------------------------------------

# GraphQL mutation for re-launching a run. Dagster supports several
# `strategy` values here; we surface the two most common:
#   FROM_FAILURE -- skip already-succeeded steps, restart failures
#   ALL_STEPS    -- full fresh re-execution (default)
# Users can also pass an explicit `stepSelection` to re-run just some
# steps (e.g. picked from the lineage view).
REEXECUTE_MUTATION = """
mutation Reexecute($params: ReexecutionParams!) {
  launchPipelineReexecution(reexecutionParams: $params) {
    __typename
    ... on LaunchRunSuccess { run { runId status } }
    ... on RunConfigValidationInvalid { errors { message } }
    ... on PipelineNotFoundError { message }
    ... on ConflictingExecutionParamsError { message }
    ... on InvalidStepError { invalidStepKey }
    ... on InvalidOutputError { invalidOutputName stepKey }
    ... on PythonError { message stack }
  }
}
"""

# Older Dagster versions accept a differently-named field. Ordering-
# invariant fallback -- try modern first, then legacy.
REEXECUTE_MUTATION_LEGACY = """
mutation ReexecuteLegacy($executionParams: ExecutionParams!) {
  launchPipelineReexecution(executionParams: $executionParams) {
    __typename
    ... on LaunchRunSuccess { run { runId status } }
    ... on PythonError { message stack }
  }
}
"""

TERMINATE_MUTATION = """
mutation Terminate($runId: String!) {
  terminatePipelineExecution(runId: $runId) {
    __typename
    ... on TerminateRunSuccess { run { runId status } }
    ... on TerminateRunFailure { message }
    ... on RunNotFoundError { message }
    ... on PythonError { message }
  }
}
"""


class ReexecuteRequest(BaseModel):
    strategy: str = "ALL_STEPS"          # ALL_STEPS | FROM_FAILURE
    step_keys: list[str] | None = None    # optional -- re-run just these


class RunActionResponse(BaseModel):
    success: bool
    new_run_id: str | None = None
    status: str | None = None
    detail: str | None = None


@router.post("/{project_id}/runs/{run_id}/reexecute", response_model=RunActionResponse)
async def reexecute_run(project_id: str, run_id: str, request: ReexecuteRequest):
    """Launch a new run derived from an existing one. Strategy controls
    whether we skip succeeded steps (FROM_FAILURE) or re-run everything
    (ALL_STEPS). `step_keys` is optional -- pass a subset to re-run
    only those steps."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    strategy = (request.strategy or "ALL_STEPS").upper()
    if strategy not in ("ALL_STEPS", "FROM_FAILURE"):
        raise HTTPException(status_code=400, detail=f"Unknown strategy '{strategy}'. Use ALL_STEPS or FROM_FAILURE.")

    params: dict[str, Any] = {
        "parentRunId": run_id,
        "strategy": strategy,
    }
    if request.step_keys:
        params["stepSelection"] = request.step_keys

    async def _do(gql: str, var_key: str) -> dict:
        variables = {var_key: params if var_key == "params" else {"executionMetadata": {"rootRunId": run_id, "parentRunId": run_id}}}
        if getattr(project, "is_dagster_plus", False):
            return await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                gql,
                variables=variables,
            )
        url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=3000)
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(url, json={"query": gql, "variables": variables})
        body = r.json()
        if body.get("errors"):
            msgs = "; ".join(e.get("message", "") for e in body["errors"])
            raise HTTPException(status_code=502, detail=f"GraphQL errors: {msgs}")
        return body.get("data") or {}

    try:
        data = await _do(REEXECUTE_MUTATION, "params")
    except (DagsterPlusError, HTTPException) as e:
        raise HTTPException(status_code=502, detail=str(getattr(e, "detail", None) or e))

    node = data.get("launchPipelineReexecution") or {}
    tn = node.get("__typename")
    if tn == "LaunchRunSuccess":
        run = node.get("run") or {}
        return RunActionResponse(
            success=True,
            new_run_id=run.get("runId"),
            status=(run.get("status") or "").upper(),
            detail=f"Launched re-execution ({strategy}).",
        )
    # Surface the actual error type for common failures.
    if tn == "RunConfigValidationInvalid":
        errs = "; ".join((e.get("message", "") for e in (node.get("errors") or [])))
        raise HTTPException(status_code=400, detail=f"Config validation failed: {errs}")
    if tn in ("PipelineNotFoundError", "RunNotFoundError"):
        raise HTTPException(status_code=404, detail=node.get("message") or "Run not found")
    if tn == "InvalidStepError":
        raise HTTPException(status_code=400, detail=f"Invalid step: {node.get('invalidStepKey')}")
    if tn == "PythonError":
        raise HTTPException(status_code=502, detail=node.get("message", "Dagster error"))
    raise HTTPException(status_code=502, detail=f"Unexpected response: {tn}")


@router.post("/{project_id}/runs/{run_id}/terminate", response_model=RunActionResponse)
async def terminate_run(project_id: str, run_id: str):
    """Terminate an in-flight run. Best-effort -- Dagster may take a
    beat to actually stop the workers, so the run status transitions
    through CANCELING before landing on CANCELED."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    variables = {"runId": run_id}
    if getattr(project, "is_dagster_plus", False):
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                TERMINATE_MUTATION,
                variables=variables,
            )
        except DagsterPlusError as e:
            raise HTTPException(status_code=502, detail=str(e))
    else:
        url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=3000)
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(url, json={"query": TERMINATE_MUTATION, "variables": variables})
            body = r.json()
        except httpx.ConnectError:
            raise HTTPException(status_code=502, detail="Local Dagster GraphQL isn't running.")
        if body.get("errors"):
            msgs = "; ".join(e.get("message", "") for e in body["errors"])
            raise HTTPException(status_code=502, detail=f"GraphQL errors: {msgs}")
        data = body.get("data") or {}

    node = data.get("terminatePipelineExecution") or {}
    tn = node.get("__typename")
    if tn == "TerminateRunSuccess":
        run = node.get("run") or {}
        return RunActionResponse(success=True, status=(run.get("status") or "").upper(), detail="Termination requested.")
    if tn == "TerminateRunFailure":
        raise HTTPException(status_code=400, detail=node.get("message") or "Termination failed")
    if tn == "RunNotFoundError":
        raise HTTPException(status_code=404, detail=node.get("message") or "Run not found")
    raise HTTPException(status_code=502, detail=node.get("message") or f"Unexpected response: {tn}")


@router.get("/{project_id}/runs/{run_id}/status", response_model=RunStatusResponse)
async def get_run_status(project_id: str, run_id: str):
    """Quick single-run status check. Used by the frontend to poll a
    specific run when the user drills in. Kept minimal so it can fire
    every few seconds without smoking the deployment."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    STATUS_QUERY = """
      query RunStatus($runId: ID!) {
        runOrError(runId: $runId) {
          __typename
          ... on Run { runId status }
          ... on PythonError { message }
        }
      }
    """
    variables = {"runId": run_id}

    if getattr(project, "is_dagster_plus", False):
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                project.dagster_plus_deployment or "",
                project.dagster_plus_token or "",
                STATUS_QUERY,
                variables=variables,
            )
        except DagsterPlusError as e:
            return RunStatusResponse(run_id=run_id, status="UNKNOWN", error=str(e))
    else:
        url = LOCAL_GRAPHQL_URL_TEMPLATE.format(port=3000)
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.post(url, json={"query": STATUS_QUERY, "variables": variables})
            data = r.json().get("data") or {}
        except Exception as e:
            return RunStatusResponse(run_id=run_id, status="UNKNOWN", error=str(e))

    node = (data.get("runOrError") or {})
    if node.get("__typename") == "Run":
        return RunStatusResponse(run_id=run_id, status=(node.get("status") or "").upper())
    return RunStatusResponse(run_id=run_id, status="UNKNOWN", error=node.get("message"))
