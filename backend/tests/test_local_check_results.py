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


# ------------------------------------------------------------------------------------
# Per-monitor run history (monitor detail page)
# ------------------------------------------------------------------------------------
import json

from app.services.local_check_results import read_check_history


def evaluation(description=None, metadata=None, severity="ERROR", ts=1781000000.5, message="Asset check passed."):
    return json.dumps({
        "__class__": "EventLogEntry", "timestamp": ts,
        "dagster_event": {
            "message": message,
            "event_specific_data": {
                "__class__": "AssetCheckEvaluation", "description": description,
                "metadata": metadata or {}, "severity": {"__enum__": f"AssetCheckSeverity.{severity}"},
            },
        },
    })


def test_history_is_chronological_with_run_ids_and_typed_metadata(project):
    meta = {
        "Execution Duration": {"__class__": "FloatMetadataEntryData", "value": 0.0075},
        "dagster_dbt/failed_row_count": {"__class__": "IntMetadataEntryData", "value": 3},
        "note": {"__class__": "TextMetadataEntryData", "text": "hello"},
        "weird": {"__class__": "TableMetadataEntryData"},
    }
    add(project, '["orders"]', "chk", "FAILED", ts="2026-10-16 10:00:00", run="run-old",
        event=evaluation(metadata=meta, description="3 rows failed"))
    add(project, '["orders"]', "chk", "SUCCEEDED", ts="2026-10-16 11:00:00", run="run-new",
        event=evaluation(metadata={"dagster_dbt/failed_row_count": {"__class__": "IntMetadataEntryData", "value": 0}}))
    ev = read_check_history(project, "orders::chk")
    assert [e["run_id"] for e in ev] == ["run-old", "run-new"]            # oldest first
    assert [e["status"] for e in ev] == ["fail", "pass"]
    old = ev[0]
    assert old["message"] == "3 rows failed" and old["kind"] == "asset_check" and old["monitor_id"] == "orders::chk"
    by_label = {m["label"]: m for m in old["metadata"]}
    assert by_label["note"]["type"] == "text" and by_label["note"]["value"] == "hello"
    assert by_label["Execution Duration"]["type"] == "float" and by_label["weird"]["type"] == "other"
    # chart value prefers a domain metric over Execution Duration; failures comes from failed_row_count
    assert old["value"] == 3.0 and old["value_label"] == "dagster_dbt/failed_row_count" and old["failures"] == 3
    assert ev[1]["failures"] == 0


def test_history_falls_back_to_the_dagster_message_and_row_time(project):
    add(project, '["a"]', "c", "SUCCEEDED", ts="2026-10-16 09:00:00", event=evaluation(description=None, message="passed!", ts=None))
    e = read_check_history(project, "a:c")[0]
    assert e["message"] == "passed!" and e["ts"] == "2026-10-16T09:00:00Z"


def test_history_finds_dbt_tests_by_name_and_both_id_shapes_by_asset(project):
    add(project, '["orders"]', "unique_orders_id", "SUCCEEDED", run="r1")
    add(project, '["other"]', "shared", "SUCCEEDED", run="r-other")
    add(project, '["orders"]', "shared", "FAILED", run="r-orders")
    assert [e["run_id"] for e in read_check_history(project, "test.shop.unique_orders_id.hash")] == ["r1"]
    assert [e["run_id"] for e in read_check_history(project, "orders:shared")] == ["r-orders"]    # asset-scoped
    assert [e["run_id"] for e in read_check_history(project, "other::shared")] == ["r-other"]


def test_history_limit_keeps_the_most_recent_and_warn_severity_is_a_warning(project):
    for i in range(5):
        add(project, '["a"]', "c", "SUCCEEDED", ts=f"2026-10-16 10:0{i}:00", run=f"r{i}")
    assert [e["run_id"] for e in read_check_history(project, "a::c", limit=2)] == ["r3", "r4"]
    add(project, '["a"]', "w", "FAILED", event=evaluation(severity="WARN"))
    assert read_check_history(project, "a::w")[0]["status"] == "warn"


def test_history_is_empty_for_unknown_monitors_and_missing_instances(tmp_path, project):
    assert read_check_history(project, "a::nothing") == []
    assert read_check_history(project, "no-separator-here") == []
    assert read_check_history(tmp_path / "nope", "a::c") == []


def test_history_endpoint_reads_the_instance_without_dg_dev(project, monkeypatch):
    """GET /monitors/history for a local project used to need `dg dev` GraphQL (and only for
    '::' ids) or dbt snapshots, so the detail page showed no run history after a normal run."""
    from fastapi.testclient import TestClient
    from app.api import projects as projects_api
    from app.main import app

    add(project, '["orders"]', "chk", "SUCCEEDED", run="run-1",
        event=evaluation(metadata={"rows": {"__class__": "IntMetadataEntryData", "value": 42}}))
    monkeypatch.setattr(projects_api.project_service, "get_project", lambda pid: SimpleNamespace(id=pid, is_dagster_plus=False))
    monkeypatch.setattr(projects_api.project_service, "_get_project_dir", lambda p: project)

    async def no_dev_server(*a, **k):  # dg dev is NOT running
        raise AssertionError("must not need dg dev when the instance has the data")
    monkeypatch.setattr(projects_api, "_asset_check_history", no_dev_server)

    r = TestClient(app).get("/api/v1/projects/p/monitors/history", params={"monitor_id": "orders:chk"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [e["run_id"] for e in body["events"]] == ["run-1"] and body["events"][0]["status"] == "pass"
    assert any(m["label"] == "rows" for m in body["numeric_metrics"])   # feeds the chart


def test_apply_to_asset_nodes_fills_checks_tab_rows(tmp_path):
    import sqlite3
    from types import SimpleNamespace
    from app.services.local_check_results import apply_to_asset_nodes

    d = tmp_path / ".designer_dagster_home" / "history" / "runs"
    d.mkdir(parents=True)
    c = sqlite3.connect(d / "index.db")
    c.execute("create table asset_check_executions (id integer primary key, asset_key text, check_name text, execution_status text, create_timestamp text, run_id text, evaluation_event text)")
    c.execute("insert into asset_check_executions values (1,'[\"customers\"]','nn','SUCCEEDED','2026-10-16 14:00:00','r1',null)")
    c.commit(); c.close()
    node = SimpleNamespace(data={"asset_key": "customers", "checks": [{"name": "nn"}, {"name": "other"}]})
    assert apply_to_asset_nodes(tmp_path, [node]) == 1
    assert node.data["checks"][0]["last_status"] == "pass"
    assert node.data["checks"][0]["last_run_at"] == "2026-10-16T14:00:00Z"
    assert "last_status" not in node.data["checks"][1]
