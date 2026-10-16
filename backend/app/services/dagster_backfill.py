"""Run a backfill the way Dagster itself does: a real *backfill* on the project's own running
`dg dev` (webserver + daemon), via the `launchPartitionBackfill` GraphQL mutation.

Why not just `dg launch --partition-range`: the CLI can only run a range as ONE run, which Dagster
allows only when every asset has BackfillPolicy.single_run() ("Assets without this policy would
require creating a backfill with separate runs per partition, which needs a running daemon
process"). A real backfill has no such limit, and -- verified against a live server -- it also
does the right thing with a mixed selection: an unpartitioned asset runs ONCE (first, if it is
upstream) as its own run, and each partitioned asset runs once per partition, never re-running the
unpartitioned ones for every partition.

Everything here is pure (request -> GraphQL variables, GraphQL result -> status) so it can be
tested without a server; the GraphQL calls themselves live in api/projects.py.
"""
from __future__ import annotations

from typing import Any

DAEMON_HEALTH_QUERY = "{ instance { daemonHealth { allDaemonStatuses { daemonType healthy required } } } }"

LAUNCH_MUTATION = """
mutation($p: LaunchBackfillParams!) {
  launchPartitionBackfill(backfillParams: $p) {
    __typename
    ... on LaunchBackfillSuccess { backfillId }
    ... on PythonError { message }
    ... on UnauthorizedError { message }
    ... on PartitionSetNotFoundError { message }
  }
}
"""

STATUS_QUERY = """
query($id: String!) {
  partitionBackfillOrError(backfillId: $id) {
    __typename
    ... on PartitionBackfill {
      status
      numPartitions
      error { message }
      runs(limit: 500) { runId status }
    }
    ... on BackfillNotFoundError { message }
    ... on PythonError { message }
  }
}
"""

ASSET_KEYS_QUERY = "{ assetNodes { assetKey { path } } }"

LOCATIONS_QUERY = "{ workspaceOrError { __typename ... on Workspace { locationEntries { name loadStatus } } } }"

RELOAD_MUTATION = """
mutation($n: String!) {
  reloadRepositoryLocation(repositoryLocationName: $n) {
    __typename
    ... on WorkspaceLocationEntry { loadStatus }
    ... on PythonError { message }
    ... on RepositoryLocationNotFound { message }
    ... on UnauthorizedError { message }
  }
}
"""

ID_PREFIX = "dagster:"


def missing_asset_keys(requested: list[str], data: dict | None) -> list[str]:
    """Requested asset keys ('a/b', selection syntax allowed) that the running server's
    `assetNodes` result doesn't contain. A server started before an asset was added doesn't
    know it, and launching a backfill that includes it fails with `KeyError: AssetKey([...])`."""
    known = {tuple(n["assetKey"]["path"]) for n in ((data or {}).get("assetNodes") or [])}
    return [k for k in requested if tuple(asset_path(k)) not in known]


def location_names(data: dict | None) -> list[str]:
    entries = (((data or {}).get("workspaceOrError") or {}).get("locationEntries")) or []
    return [e["name"] for e in entries if e.get("name")]


def locations_loaded(data: dict | None) -> bool:
    entries = (((data or {}).get("workspaceOrError") or {}).get("locationEntries")) or []
    return bool(entries) and all(e.get("loadStatus") == "LOADED" for e in entries)

_TERMINAL_RUN = {"SUCCESS", "FAILURE", "CANCELED"}


def asset_path(key: str) -> list[str]:
    """'a/b' -> ['a', 'b'] (Designer's slash-joined key; selection syntax +/* stripped)."""
    return [seg for seg in key.strip().strip("+*").split("/") if seg]


def backfill_daemon_healthy(data: dict | None) -> bool:
    """True if the BACKFILL daemon reports healthy in a daemonHealth query result."""
    try:
        statuses = data["instance"]["daemonHealth"]["allDaemonStatuses"]
    except (TypeError, KeyError):
        return False
    return any(s.get("daemonType") == "BACKFILL" and s.get("healthy") for s in statuses)


def partition_ranges(request: Any) -> list[dict[str, str]]:
    """Every {start, end} the request asks for: explicit ranges, then each discrete key as a
    one-partition range (how Dagster's own UI expresses a hand-picked set)."""
    ranges: list[dict[str, str]] = []
    for r in (getattr(request, "partition_ranges", None) or []):
        if r.get("start") and r.get("end"):
            ranges.append({"start": r["start"], "end": r["end"]})
        elif r.get("start"):
            ranges.append({"start": r["start"], "end": r["start"]})
    single = getattr(request, "partition_range", None)
    if single and single.get("start"):
        ranges.append({"start": single["start"], "end": single.get("end") or single["start"]})
    for key in (getattr(request, "partition_selection", None) or []):
        ranges.append({"start": key, "end": key})
    return ranges


def build_launch_params(request: Any, partitioned: dict[str, bool], title: str) -> dict:
    """`launchPartitionBackfill` params for a Designer BackfillRequest.

    `partitioned` maps each requested asset key -> whether it has a partitions definition.
      * nothing partition-specific requested  -> every partition of the selection
      * all assets partitioned, discrete keys -> assetSelection + partitionNames (same keys for all)
      * ranges, or any unpartitioned asset    -> partitionsByAssets: each partitioned asset gets the
        ranges, each unpartitioned asset none (Dagster materialises it once, in dependency order).
    Dagster forbids partitionsByAssets together with assetSelection/partitionNames, hence the split.
    """
    keys = list(request.asset_keys or [])
    ranges = partition_ranges(request)
    params: dict[str, Any] = {"title": title}
    if getattr(request, "tags", None):
        params["tags"] = [{"key": k, "value": str(v)} for k, v in request.tags.items()]

    selection = [{"path": asset_path(k)} for k in keys]
    any_unpartitioned = any(not partitioned.get(k, True) for k in keys)
    discrete_only = (
        ranges
        and not (getattr(request, "partition_ranges", None) or getattr(request, "partition_range", None))
    )

    if not ranges:
        params.update(assetSelection=selection, allPartitions=True)
    elif discrete_only and not any_unpartitioned:
        params.update(assetSelection=selection, partitionNames=list(request.partition_selection))
    else:
        by_asset = []
        for k in keys:
            entry: dict[str, Any] = {"assetKey": {"path": asset_path(k)}}
            if partitioned.get(k, True):
                entry["partitions"] = {"ranges": ranges}
            by_asset.append(entry)
        params["partitionsByAssets"] = by_asset
    return params


def map_status(result: dict | None, unpartitioned_assets: int = 0) -> dict:
    """Dagster's PartitionBackfill (or error) -> {state, total, launched, finished, failed_runs,
    message}. state: running | succeeded | failed."""
    if not result or result.get("__typename") != "PartitionBackfill":
        msg = (result or {}).get("message") or "Backfill not found"
        return {"state": "failed", "total": 0, "launched": 0, "finished": 0, "failed_runs": 0, "message": msg}

    runs = result.get("runs") or []
    statuses = [r.get("status") for r in runs]
    failed_runs = sum(1 for s in statuses if s == "FAILURE")
    out = {
        "total": (result.get("numPartitions") or 0) + unpartitioned_assets,
        "launched": len(runs),
        "finished": sum(1 for s in statuses if s in _TERMINAL_RUN),
        "failed_runs": failed_runs,
        "message": None,
    }
    status = result.get("status")
    err = ((result.get("error") or {}).get("message") or "").strip() or None
    if status in ("COMPLETED_SUCCESS", "COMPLETED"):
        out["state"] = "failed" if failed_runs else "succeeded"
        if failed_runs:
            out["message"] = f"{failed_runs} of {len(runs)} runs failed"
    elif status in ("COMPLETED_FAILED", "FAILED"):
        out["state"] = "failed"
        out["message"] = err or (f"{failed_runs} of {len(runs)} runs failed" if failed_runs else "The backfill failed.")
    elif status == "CANCELED":
        out["state"], out["message"] = "failed", "The backfill was canceled."
    else:  # REQUESTED, CANCELING, FAILING -- still in flight
        out["state"] = "running"
    return out
