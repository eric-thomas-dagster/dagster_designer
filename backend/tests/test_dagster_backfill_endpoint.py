"""POST /backfill prefers a real Dagster backfill on the project's dev server (parallel runs, dependency
order, unpartitioned assets once) and falls back to one `dg launch` per partition when that isn't
possible; GET /backfills/{id} serves both engines."""
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import projects as P
from app.main import app
from app.services import dagster_backfill as dbf

HEALTHY = {"instance": {"daemonHealth": {"allDaemonStatuses": [{"daemonType": "BACKFILL", "healthy": True, "required": True}]}}}
SUCCESS = {"launchPartitionBackfill": {"__typename": "LaunchBackfillSuccess", "backfillId": "abc123"}}


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: SimpleNamespace(id=pid, is_dagster_plus=False))
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: Path("/tmp"))
    state = SimpleNamespace(graphql_calls=[], cli_started=None, partitioned={"raw_orders": True, "raw_customers": False})

    async def fake_partitions(project_id, asset_key):
        return SimpleNamespace(is_partitioned=state.partitioned.get(asset_key, True),
                               partitions_def={"partition_keys": [f"2026-09-{d:02d}" for d in range(1, 11)], "partition_count": 10})

    async def fake_cli(project_id, project_dir, request, backfill_id=None):
        state.cli_started = backfill_id

    monkeypatch.setattr(P, "get_asset_partitions", fake_partitions)
    monkeypatch.setattr(P, "_run_backfill_in_background", fake_cli)
    state.client = TestClient(app)
    state.script = {}

    async def fake_graphql(project, query, variables):
        state.graphql_calls.append((query, variables))
        for marker, answer in state.script.items():
            if marker in query:
                return answer
        return None
    monkeypatch.setattr(P, "_run_dagster_graphql", fake_graphql)
    P._backfill_jobs.clear(); P._dagster_backfills.clear()
    return state


def post(env, **body):
    body.setdefault("asset_keys", ["raw_orders"])
    return env.client.post("/api/v1/projects/p/backfill", json=body).json()


def test_uses_a_real_dagster_backfill_when_the_dev_server_is_up(env):
    env.script = {"daemonHealth": HEALTHY, "launchPartitionBackfill": SUCCESS}
    r = post(env, partition_range={"start": "2026-09-01", "end": "2026-09-10"})
    assert r["engine"] == "dagster" and r["backfill_id"] == "dagster:abc123" and r["success"]
    assert r["launches"] == 10                         # range expanded from the partitions definition
    assert env.cli_started is None                     # no per-partition dg launch background task
    params = env.graphql_calls[-1][1]["p"]
    assert params["partitionsByAssets"][0]["partitions"]["ranges"] == [{"start": "2026-09-01", "end": "2026-09-10"}]


def test_mixed_selection_counts_the_unpartitioned_asset_once(env):
    env.script = {"daemonHealth": HEALTHY, "launchPartitionBackfill": SUCCESS}
    r = post(env, asset_keys=["raw_customers", "raw_orders"], partition_selection=["2026-09-02", "2026-09-03"])
    assert r["engine"] == "dagster" and r["launches"] == 3          # 2 partitions + raw_customers once
    by = {e["assetKey"]["path"][0]: e for e in env.graphql_calls[-1][1]["p"]["partitionsByAssets"]}
    assert "partitions" not in by["raw_customers"] and "partitions" in by["raw_orders"]


@pytest.mark.parametrize("script,why", [
    ({}, "dev server isn't running"),                                                           # GraphQL unreachable
    ({"daemonHealth": {"instance": {"daemonHealth": {"allDaemonStatuses": [{"daemonType": "BACKFILL", "healthy": False}]}}}}, "daemon isn't healthy"),
    ({"daemonHealth": HEALTHY, "launchPartitionBackfill": {"launchPartitionBackfill": {"__typename": "PythonError", "message": "boom"}}}, "boom"),
])
def test_falls_back_to_dg_launch_per_partition(env, script, why, capsys):
    env.script = script
    r = post(env, partition_selection=["2026-09-01", "2026-09-02"])
    assert r["engine"] == "cli" and r["launches"] == 2 and env.cli_started == r["backfill_id"]
    assert why in capsys.readouterr().out                                                        # the reason is logged


def test_run_config_requests_use_the_cli_path_without_touching_graphql(env):
    env.script = {"daemonHealth": HEALTHY, "launchPartitionBackfill": SUCCESS}
    r = post(env, partition_selection=["2026-09-01"], config={"ops": {}})
    assert r["engine"] == "cli" and env.graphql_calls == []


def test_status_route_serves_a_dagster_backfill(env):
    env.script = {"daemonHealth": HEALTHY, "launchPartitionBackfill": SUCCESS}
    bid = post(env, asset_keys=["raw_customers", "raw_orders"], partition_selection=["2026-09-02"])["backfill_id"]
    env.script = {"partitionBackfillOrError": {"partitionBackfillOrError": {
        "__typename": "PartitionBackfill", "status": "REQUESTED", "numPartitions": 1, "error": None,
        "runs": [{"runId": "r1", "status": "SUCCESS"}, {"runId": "r2", "status": "STARTED"}]}}}
    s = env.client.get(f"/api/v1/projects/p/backfills/{bid}").json()
    assert (s["engine"], s["state"], s["total"], s["launched"], s["finished"]) == ("dagster", "running", 2, 2, 1)
    env.script = {"partitionBackfillOrError": {"partitionBackfillOrError": {
        "__typename": "PartitionBackfill", "status": "COMPLETED_SUCCESS", "numPartitions": 1, "error": None,
        "runs": [{"runId": "r1", "status": "SUCCESS"}, {"runId": "r2", "status": "SUCCESS"}]}}}
    assert env.client.get(f"/api/v1/projects/p/backfills/{bid}").json()["state"] == "succeeded"


def test_dagster_status_errors_are_distinguishable(env):
    env.script = {"daemonHealth": HEALTHY, "launchPartitionBackfill": SUCCESS}
    bid = post(env)["backfill_id"]
    env.script = {}                                                                       # dev server went away
    assert env.client.get(f"/api/v1/projects/p/backfills/{bid}").status_code == 502
    assert env.client.get("/api/v1/projects/p/backfills/dagster:unknown").status_code == 404
    assert env.client.get(f"/api/v1/projects/other/backfills/{bid}").status_code == 404
