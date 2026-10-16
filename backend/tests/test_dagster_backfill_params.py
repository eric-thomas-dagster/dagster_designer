"""Designer BackfillRequest -> Dagster `launchPartitionBackfill` params (shapes validated against a
live `dg dev`), and Dagster's backfill status -> Designer's progress."""
from types import SimpleNamespace

import pytest

from app.services import dagster_backfill as db


def req(**kw):
    base = dict(asset_keys=["raw_orders"], partition_selection=None, partition_range=None, partition_ranges=None, tags=None, config=None)
    base.update(kw)
    return SimpleNamespace(**base)


def test_asset_path_handles_slashes_and_selection_syntax():
    assert db.asset_path("a/b") == ["a", "b"] and db.asset_path("+orders") == ["orders"] and db.asset_path("orders+") == ["orders"]


def test_no_partitions_requested_means_all_partitions():
    p = db.build_launch_params(req(), {"raw_orders": True}, "t")
    assert p == {"title": "t", "assetSelection": [{"path": ["raw_orders"]}], "allPartitions": True}


def test_discrete_keys_on_partitioned_assets_use_partition_names():
    p = db.build_launch_params(req(partition_selection=["2026-09-01", "2026-09-03"]), {"raw_orders": True}, "t")
    assert p["assetSelection"] == [{"path": ["raw_orders"]}] and p["partitionNames"] == ["2026-09-01", "2026-09-03"]
    assert "partitionsByAssets" not in p            # Dagster forbids combining the two shapes


def test_a_range_uses_partitions_by_assets():
    p = db.build_launch_params(req(partition_range={"start": "2026-09-01", "end": "2026-10-14"}), {"raw_orders": True}, "t")
    assert p["partitionsByAssets"] == [{"assetKey": {"path": ["raw_orders"]}, "partitions": {"ranges": [{"start": "2026-09-01", "end": "2026-10-14"}]}}]
    assert "assetSelection" not in p and "partitionNames" not in p and "allPartitions" not in p


def test_mixed_selection_gives_unpartitioned_assets_no_partitions():
    """The case verified live: raw_customers (unpartitioned) runs once, raw_orders once per partition."""
    p = db.build_launch_params(
        req(asset_keys=["raw_customers", "raw_orders"], partition_selection=["2026-09-04", "2026-09-05"]),
        {"raw_customers": False, "raw_orders": True}, "t")
    by = {e["assetKey"]["path"][0]: e for e in p["partitionsByAssets"]}
    assert "partitions" not in by["raw_customers"]
    assert by["raw_orders"]["partitions"]["ranges"] == [{"start": "2026-09-04", "end": "2026-09-04"}, {"start": "2026-09-05", "end": "2026-09-05"}]


def test_ranges_and_discrete_keys_combine():
    p = db.build_launch_params(
        req(partition_ranges=[{"start": "a", "end": "c"}], partition_selection=["z"]), {"raw_orders": True}, "t")
    assert p["partitionsByAssets"][0]["partitions"]["ranges"] == [{"start": "a", "end": "c"}, {"start": "z", "end": "z"}]


def test_tags_are_passed_as_key_value_pairs():
    p = db.build_launch_params(req(tags={"team": "data", "n": 3}), {"raw_orders": True}, "t")
    assert p["tags"] == [{"key": "team", "value": "data"}, {"key": "n", "value": "3"}]


def test_daemon_health_parsing():
    ok = {"instance": {"daemonHealth": {"allDaemonStatuses": [{"daemonType": "SENSOR", "healthy": True}, {"daemonType": "BACKFILL", "healthy": True}]}}}
    bad = {"instance": {"daemonHealth": {"allDaemonStatuses": [{"daemonType": "BACKFILL", "healthy": False}]}}}
    missing = {"instance": {"daemonHealth": {"allDaemonStatuses": [{"daemonType": "SENSOR", "healthy": True}]}}}
    assert db.backfill_daemon_healthy(ok)
    assert not db.backfill_daemon_healthy(bad) and not db.backfill_daemon_healthy(missing)
    assert not db.backfill_daemon_healthy(None) and not db.backfill_daemon_healthy({})


def backfill(status, runs=(), n=44, error=None):
    return {"__typename": "PartitionBackfill", "status": status, "numPartitions": n,
            "error": {"message": error} if error else None, "runs": [{"runId": f"r{i}", "status": s} for i, s in enumerate(runs)]}


def test_status_in_flight():
    s = db.map_status(backfill("REQUESTED", ["SUCCESS", "STARTED", "QUEUED"]))
    assert s["state"] == "running" and s["total"] == 44 and s["launched"] == 3 and s["finished"] == 1


def test_status_success_counts_unpartitioned_assets_in_the_total():
    s = db.map_status(backfill("COMPLETED_SUCCESS", ["SUCCESS"] * 3, n=2), unpartitioned_assets=1)
    assert s["state"] == "succeeded" and s["total"] == 3 and s["launched"] == 3 and s["message"] is None


@pytest.mark.parametrize("status", ["COMPLETED_SUCCESS", "COMPLETED"])
def test_a_finished_backfill_with_failed_runs_is_a_failure(status):
    s = db.map_status(backfill(status, ["SUCCESS", "FAILURE", "FAILURE"]))
    assert s["state"] == "failed" and s["failed_runs"] == 2 and "2 of 3 runs failed" in s["message"]


def test_failed_backfill_surfaces_dagsters_error():
    s = db.map_status(backfill("FAILED", [], error="Another daemon is still sending heartbeats"))
    assert s["state"] == "failed" and "heartbeats" in s["message"]
    assert db.map_status(backfill("COMPLETED_FAILED", ["FAILURE"]))["state"] == "failed"


def test_canceled_and_unknown():
    assert db.map_status(backfill("CANCELED"))["message"] == "The backfill was canceled."
    s = db.map_status({"__typename": "BackfillNotFoundError", "message": "No backfill"})
    assert s["state"] == "failed" and s["message"] == "No backfill"
    assert db.map_status(None)["state"] == "failed"


def test_missing_asset_keys_and_locations():
    from app.services import dagster_backfill as dbf
    data = {"assetNodes": [{"assetKey": {"path": ["raw_orders"]}}, {"assetKey": {"path": ["a", "b"]}}]}
    assert dbf.missing_asset_keys(["raw_orders", "a/b", "+with_phone*"], data) == ["+with_phone*"]
    assert dbf.missing_asset_keys(["x"], None) == ["x"]
    ws = {"workspaceOrError": {"locationEntries": [{"name": "loc", "loadStatus": "LOADED"}]}}
    assert dbf.location_names(ws) == ["loc"] and dbf.locations_loaded(ws)
    ws["workspaceOrError"]["locationEntries"][0]["loadStatus"] = "LOADING"
    assert not dbf.locations_loaded(ws) and not dbf.locations_loaded(None)
