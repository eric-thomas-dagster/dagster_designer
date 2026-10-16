"""Monitors must show the asset-check results Dagster recorded in the project's own
instance. They used to read only dbt's run_results.json (never updated by the Dagster
dbt component) or a live `dg dev`, so after "Materialize all" every check read
'never run' (95 of 95) while the instance held the results."""
import sqlite3
from types import SimpleNamespace

import pytest

from app.services.local_check_results import (
    _dbt_test_name, apply_local_check_results, read_latest_check_results,
)

SCHEMA = """CREATE TABLE asset_check_executions (
  id INTEGER PRIMARY KEY, asset_key TEXT, check_name TEXT, partition TEXT, run_id VARCHAR(255),
  execution_status VARCHAR(255), evaluation_event TEXT, evaluation_event_timestamp DATETIME,
  evaluation_event_storage_id INTEGER, materialization_event_storage_id INTEGER, create_timestamp DATETIME)"""


@pytest.fixture()
def project(tmp_path):
    d = tmp_path / "proj"
    db = d / ".designer_dagster_home/history/runs/index.db"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(db)
    conn.execute(SCHEMA)
    conn.commit()
    conn.close()
    return d


def add(project, asset, check, status, ts="2026-10-16 14:00:00", run="r1", event=None):
    conn = sqlite3.connect(project / ".designer_dagster_home/history/runs/index.db")
    conn.execute(
        "INSERT INTO asset_check_executions (asset_key, check_name, run_id, execution_status, evaluation_event, create_timestamp) VALUES (?,?,?,?,?,?)",
        (asset, check, run, status, event, ts))
    conn.commit()
    conn.close()


def mon(id, kind="asset_check", label="", targets=(), status=None, at=None):
    return SimpleNamespace(id=id, kind=kind, label=label, target_asset_keys=list(targets),
                           last_status=status, last_run_at=at, recent_statuses=[])


def test_status_mapping_and_unfinished_executions_are_ignored(project):
    add(project, '["a"]', "ok", "SUCCEEDED")
    add(project, '["a"]', "bad", "FAILED")
    add(project, '["a"]', "boom", "EXECUTION_FAILED")
    add(project, '["a"]', "warned", "FAILED", event='{"severity": {"__enum__": "AssetCheckSeverity.WARN"}}')
    add(project, '["a"]', "planned", "PLANNED")
    add(project, '["a"]', "skipped", "SKIPPED")
    got = {k[1]: v["status"] for k, v in read_latest_check_results(project).items()}
    assert got == {"ok": "pass", "bad": "fail", "boom": "error", "warned": "warn"}


def test_latest_wins_and_history_is_oldest_first(project):
    add(project, '["a"]', "c", "FAILED", ts="2026-10-16 10:00:00")
    add(project, '["a"]', "c", "SUCCEEDED", ts="2026-10-16 11:00:00")
    r = read_latest_check_results(project)[("a", "c")]
    assert r["status"] == "pass" and r["last_run_at"] == "2026-10-16T11:00:00Z"
    assert r["recent"] == ["fail", "pass"]


def test_history_is_capped_at_20(project):
    for i in range(30):
        add(project, '["a"]', "c", "SUCCEEDED", ts=f"2026-10-16 10:{i:02d}:00")
    assert len(read_latest_check_results(project)[("a", "c")]["recent"]) == 20


def test_multi_segment_asset_keys_join_with_slashes(project):
    add(project, '["raw", "orders"]', "c", "SUCCEEDED")
    assert ("raw/orders", "c") in read_latest_check_results(project)


def test_missing_or_corrupt_instance_never_raises(tmp_path, project):
    assert read_latest_check_results(tmp_path / "nothing") == {}
    (project / ".designer_dagster_home/history/runs/index.db").write_bytes(b"not a database")
    assert read_latest_check_results(project) == {}


@pytest.mark.parametrize("uid,name", [
    ("test.shop.unique_orders_order_id.fc5a4e0d3e", "unique_orders_order_id"),   # generic test, hashed
    ("test.shop.assert_order_amounts_non_negative", "assert_order_amounts_non_negative"),  # singular, no hash
    ("model.shop.orders", None),
    ("test.shop", None),
])
def test_dbt_test_name_parsing(uid, name):
    assert _dbt_test_name(uid) == name


def test_apply_matches_dbt_tests_and_native_checks_in_both_id_shapes(project):
    add(project, '["orders"]', "unique_orders_order_id", "SUCCEEDED", ts="2026-10-16 14:00:00")
    add(project, '["orders"]', "assert_x", "FAILED", ts="2026-10-16 14:00:00")
    add(project, '["orders"]', "native_one", "SUCCEEDED")
    add(project, '["orders"]', "native_two", "SUCCEEDED")
    ms = [
        mon("test.shop.unique_orders_order_id.abc", kind="dbt_test"),
        mon("test.shop.assert_x", kind="dbt_test"),                                            # singular
        mon("orders:native_one", label="native_one", targets=["orders"]),                      # single colon id
        mon("orders::native_two", label="", targets=[]),                                       # '::' id, no label
        mon("orders:never_ran", label="never_ran", targets=["orders"]),
    ]
    assert apply_local_check_results(project, ms) == 4
    assert [m.last_status for m in ms] == ["pass", "fail", "pass", "pass", None]
    assert ms[0].last_run_at == "2026-10-16T14:00:00Z" and ms[0].recent_statuses == ["pass"]


def test_apply_keeps_a_monitors_own_newer_result(project):
    add(project, '["a"]', "c", "FAILED", ts="2026-10-16 10:00:00")
    newer = mon("a:c", label="c", targets=["a"], status="pass", at="2026-10-16T12:00:00Z")
    older = mon("a:c", label="c", targets=["a"], status="pass", at="2026-10-16T08:00:00Z")
    apply_local_check_results(project, [newer, older])
    assert newer.last_status == "pass" and newer.last_run_at == "2026-10-16T12:00:00Z"   # untouched
    assert older.last_status == "fail" and older.last_run_at == "2026-10-16T10:00:00Z"   # superseded


def test_apply_with_no_results_changes_nothing(tmp_path):
    m = mon("a:c", label="c", targets=["a"])
    assert apply_local_check_results(tmp_path, [m]) == 0 and m.last_status is None
