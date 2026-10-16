"""Backfill: (1) `dg launch --partition-range` fails outright for assets with no single-run
BackfillPolicy ("Partition ranges with the CLI require all selected assets to have a
BackfillPolicy.single_run() policy") -- a full-range backfill launched nothing, yet the UI
said "Backfill launched". (2) The launch is a background task whose result was only logged;
callers now get a backfill_id to poll."""
import asyncio
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import projects as P
from app.main import app

POLICY_ERROR = (
    "dagster_shared.check.functions.CheckError: Failure condition: Partition ranges with the CLI require "
    "all selected assets to have a BackfillPolicy.single_run() policy. This allows the partition range to be "
    "executed in a single run."
)
KEYS = [f"2026-09-{d:02d}" for d in range(1, 11)]


def test_policy_error_detector():
    assert P._needs_single_run_policy(POLICY_ERROR)
    assert not P._needs_single_run_policy("ModuleNotFoundError: no module named x")
    assert not P._needs_single_run_policy(None)


def _info(keys, count=None):
    return SimpleNamespace(partitions_def={"partition_keys": keys, "partition_count": count or len(keys)})


def _expand(monkeypatch, info, start, end, assets=("a",)):
    async def fake(project_id, asset_key):
        return info
    monkeypatch.setattr(P, "get_asset_partitions", fake)
    return asyncio.run(P._expand_partition_range("p", list(assets), start, end))


def test_range_expands_to_inclusive_keys(monkeypatch):
    assert _expand(monkeypatch, _info(KEYS), "2026-09-03", "2026-09-06") == KEYS[2:6]


def test_expansion_refuses_when_it_cannot_be_exact(monkeypatch):
    assert _expand(monkeypatch, _info(KEYS, count=5000), "2026-09-01", "2026-09-05") is None   # sampled keys
    assert _expand(monkeypatch, _info(KEYS), "2026-09-06", "2026-09-03") is None               # reversed
    assert _expand(monkeypatch, _info(KEYS), "2026-09-01", "2030-01-01") is None               # unknown end


@pytest.fixture()
def run_backfill(tmp_path, monkeypatch):
    project_dir = tmp_path / "proj"
    (project_dir / ".venv/bin").mkdir(parents=True)
    (project_dir / ".venv/bin/dg").write_text("")

    def go(request, results, keys=KEYS):
        launches: list[list[str]] = []

        def fake_run(cmd, **kw):
            if "launch" in cmd:
                launches.append(cmd)
                rc, err = results[min(len(launches), len(results)) - 1]
                return subprocess.CompletedProcess(cmd, rc, "", err)
            return subprocess.CompletedProcess(cmd, 0, "", "")  # metadata extraction etc.

        async def fake_partitions(project_id, asset_key):
            return _info(keys)

        monkeypatch.setattr(subprocess, "run", fake_run)
        monkeypatch.setattr(P, "get_asset_partitions", fake_partitions)
        P._backfill_jobs["b1"] = {"project_id": "p", "state": "running", "total": 1, "launched": 0, "message": None, "expanded_range": False}
        asyncio.run(P._run_backfill_in_background("p", project_dir, request, "b1"))
        return P._backfill_jobs.pop("b1"), launches
    return go


def req(**kw):
    return P.BackfillRequest(asset_keys=["raw_orders"], **kw)


def test_full_range_without_a_single_run_policy_runs_partition_by_partition(run_backfill):
    job, launches = run_backfill(
        req(partition_range={"start": KEYS[0], "end": KEYS[3]}),
        [(1, POLICY_ERROR), (0, ""), (0, ""), (0, ""), (0, "")],
    )
    assert job["state"] == "succeeded" and job["expanded_range"] is True
    assert job["launched"] == 4 and job["total"] == 4
    assert "--partition-range" in launches[0]                                   # tried the range first
    assert [c[c.index("--partition") + 1] for c in launches[1:]] == KEYS[:4]    # then one launch per key
    assert len(launches) == 5


def test_a_range_that_works_is_still_one_launch(run_backfill):
    job, launches = run_backfill(req(partition_range={"start": KEYS[0], "end": KEYS[-1]}), [(0, "")])
    assert job["state"] == "succeeded" and job["expanded_range"] is False and len(launches) == 1


def test_a_real_failure_is_reported_not_swallowed(run_backfill):
    job, launches = run_backfill(req(partition_selection=KEYS[:3]), [(1, "noise\nSomething real broke")])
    assert job["state"] == "failed" and job["message"] == "Something real broke"
    assert len(launches) == 1                                                    # stops at the first failure


def test_failure_in_an_expanded_partition_reports_progress_so_far(run_backfill):
    job, _ = run_backfill(
        req(partition_range={"start": KEYS[0], "end": KEYS[4]}),
        [(1, POLICY_ERROR), (0, ""), (0, ""), (1, "disk full")],
    )
    assert job["state"] == "failed" and job["launched"] == 2 and job["message"] == "disk full"


def test_unexpandable_range_surfaces_the_original_error(run_backfill):
    job, launches = run_backfill(req(partition_range={"start": "2020-01-01", "end": "2020-02-01"}), [(1, POLICY_ERROR)])
    assert job["state"] == "failed" and "single_run()" in job["message"] and len(launches) == 1


def test_endpoint_returns_a_backfill_id_and_the_status_route_reports_it(monkeypatch):
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: SimpleNamespace(id=pid))
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: __import__("pathlib").Path("/tmp"))
    started = {}

    async def noop(project_id, project_dir, request, backfill_id=None):
        started["id"] = backfill_id
    monkeypatch.setattr(P, "_run_backfill_in_background", noop)
    c = TestClient(app)
    r = c.post("/api/v1/projects/p/backfill", json={"asset_keys": ["a"], "partition_selection": ["x", "y"]}).json()
    assert r["success"] and r["backfill_id"] == started["id"] and r["launches"] == 2
    s = c.get(f"/api/v1/projects/p/backfills/{r['backfill_id']}").json()
    assert s["state"] == "running" and s["total"] == 2 and s["launched"] == 0
    assert c.get(f"/api/v1/projects/other/backfills/{r['backfill_id']}").status_code == 404   # wrong project
    assert c.get("/api/v1/projects/p/backfills/nope").status_code == 404
