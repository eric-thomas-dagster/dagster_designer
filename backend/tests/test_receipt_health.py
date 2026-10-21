"""Knowledge-base health read from a (SQLite) context receipt store."""

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import knowledge_base
from app.services import receipt_health_service as health

DDL = """
CREATE TABLE context_receipts (receipt_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, context_name TEXT NOT NULL);
CREATE TABLE context_receipt_items (receipt_id TEXT NOT NULL, item_id TEXT NOT NULL, source_asset_key TEXT, source_code_version TEXT,
    rank INTEGER, PRIMARY KEY (receipt_id, item_id, rank));
CREATE TABLE context_receipt_excluded (receipt_id TEXT NOT NULL, item_id TEXT NOT NULL, reason TEXT NOT NULL, source_asset_key TEXT,
    source_code_version TEXT, PRIMARY KEY (receipt_id, item_id));
CREATE TABLE context_receipt_events (event_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL);
"""


class Db:
    def __init__(self, path):
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.executescript(DDL)
        self.n = 0

    def receipt(self, items, outcomes=(), age_days=1, asset="kb", code_version="v1", cited=None):
        self.n += 1
        rid = f"r{self.n}"
        ts = (datetime.now(timezone.utc) - timedelta(days=age_days)).isoformat()
        self.conn.execute("INSERT INTO context_receipts VALUES (?,?,?)", (rid, ts, asset))
        for rank, item in enumerate(items):
            self.conn.execute("INSERT INTO context_receipt_items VALUES (?,?,?,?,?)", (rid, item, asset, code_version, rank))
        for i, (value, ref) in enumerate(outcomes):
            self.event(rid, "outcome", {"value": value, "outcome_ref": ref}, i)
        if cited is not None:
            self.event(rid, "evidence", {"level": "cited", "details": {"item_ids": cited}}, 9)
        self.conn.commit()
        return rid

    def event(self, rid, kind, payload, i):
        self.conn.execute("INSERT INTO context_receipt_events VALUES (?,?,?,?,?)", (f"{rid}-{kind}-{i}", rid, kind, "t", json.dumps(payload)))

    def exclude(self, rid, item, reason, asset="kb"):
        self.conn.execute("INSERT INTO context_receipt_excluded VALUES (?,?,?,?,?)", (rid, item, reason, asset, "v1"))
        self.conn.commit()


@pytest.fixture
def db(tmp_path):
    return Db(tmp_path / "r.sqlite3")


def test_missing_database_is_reported_not_created(tmp_path):
    with pytest.raises(health.ReceiptStoreUnavailable):
        health.asset_health(tmp_path / "nope.sqlite3", "kb")
    assert not (tmp_path / "nope.sqlite3").exists()


def test_a_non_receipt_database_is_rejected(tmp_path):
    sqlite3.connect(tmp_path / "x.sqlite3").close()
    assert health.list_assets(tmp_path / "x.sqlite3") == []
    with pytest.raises(health.ReceiptStoreUnavailable):
        health.asset_health(tmp_path / "x.sqlite3", "kb")


def test_counts_means_and_citations(db):
    db.receipt(["a", "b"], outcomes=[(1.0, "u1")], cited=["a"])
    db.receipt(["a"], outcomes=[(-1.0, "u2")])
    db.receipt(["b"])  # served, never rated
    h = health.asset_health(db.path, "kb")
    assert (h["receipts"], h["retrievals"], h["rated_retrievals"], h["chunks_retrieved"]) == (3, 4, 3, 2)
    assert h["mean_outcome"] == pytest.approx(1 / 3, abs=1e-3)
    assert h["cited_retrievals"] == 1
    assert h["last_retrieved_at"] is not None


def test_later_outcome_with_same_ref_supersedes_the_earlier(db):
    db.receipt(["a"], outcomes=[(1.0, "u1"), (-1.0, "u1")])
    assert health.asset_health(db.path, "kb")["mean_outcome"] == -1.0


def test_a_receipts_effective_outcome_is_the_mean_of_its_outcomes(db):
    db.receipt(["a"], outcomes=[(1.0, "u1"), (-0.5, "u2")])
    assert health.asset_health(db.path, "kb")["mean_outcome"] == 0.25


def test_failing_chunks_need_enough_ratings_to_be_trusted(db):
    for _ in range(3):
        db.receipt(["bad"], outcomes=[(-1.0, None)])
    db.receipt(["twice"], outcomes=[(-1.0, None)])
    db.receipt(["twice"], outcomes=[(-1.0, None)])
    for _ in range(4):
        db.receipt(["good"], outcomes=[(1.0, None)])
    h = health.asset_health(db.path, "kb")
    assert [c["chunk_id"] for c in h["failing_chunks"]] == ["bad"]
    assert h["failing_chunk_count"] == 1
    assert [c["chunk_id"] for c in h["top_chunks"]] == ["good"]


def test_window_excludes_old_receipts_and_other_assets(db):
    db.receipt(["a"], age_days=90)
    db.receipt(["a"], asset="other")
    db.receipt(["a"], age_days=2)
    assert health.asset_health(db.path, "kb", days=30)["receipts"] == 1
    assert health.asset_health(db.path, "kb", days=None)["receipts"] == 2
    assert health.list_assets(db.path) == ["kb", "other"]


def test_exclusions_are_totalled(db):
    rid = db.receipt(["a"])
    db.exclude(rid, "pii_chunk", "pii")
    db.exclude(rid, "old_chunk", "stale")
    assert health.asset_health(db.path, "kb")["excluded"] == {"pii": 1, "stale": 1}


def test_outcomes_are_broken_out_by_the_recipe_that_built_the_chunks(db):
    db.receipt(["a"], outcomes=[(-1.0, None)], code_version="recipe-1")
    db.receipt(["a"], outcomes=[(1.0, None)], code_version="recipe-2")
    db.receipt(["a"], outcomes=[(1.0, None)], code_version="recipe-2")
    rows = {r["code_version"]: r for r in health.asset_health(db.path, "kb")["by_code_version"]}
    assert rows["recipe-1"]["mean_outcome"] == -1.0 and rows["recipe-2"]["mean_outcome"] == 1.0


def test_database_is_opened_read_only(db):
    db.receipt(["a"])
    with pytest.raises(sqlite3.OperationalError):
        health._connect_readonly(db.path).execute("INSERT INTO context_receipts VALUES ('x','t','n')")


# --- endpoint -------------------------------------------------------------------------------------------------------

def _client(monkeypatch, tmp_path, components):
    project = SimpleNamespace(components=components)
    fake = SimpleNamespace(get_project=lambda pid: project if pid == "p1" else None, _get_project_dir=lambda p: tmp_path)
    monkeypatch.setattr(knowledge_base, "project_service", fake)
    app = FastAPI()
    app.include_router(knowledge_base.router, prefix="/api")
    return TestClient(app)


def _store(**attrs):
    return SimpleNamespace(component_type="dagster_community_components.ContextReceiptStoreComponent", attributes=attrs)


def test_endpoint_reports_missing_store_and_unknown_project(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path, [])
    assert client.get("/api/projects/p1/knowledge-base/health").json()["status"] == "no_store"
    assert client.get("/api/projects/nope/knowledge-base/health").status_code == 404


def test_endpoint_resolves_a_relative_database_path_against_the_project(monkeypatch, tmp_path):
    (tmp_path / "var").mkdir()
    d = Db(tmp_path / "var" / "r.sqlite3")
    d.receipt(["a"], outcomes=[(1.0, None)])
    client = _client(monkeypatch, tmp_path, [_store(database_path="./var/r.sqlite3")])
    body = client.get("/api/projects/p1/knowledge-base/health").json()
    assert body["status"] == "ok"
    assert body["knowledge_bases"][0]["asset_key"] == "kb" and body["knowledge_bases"][0]["receipts"] == 1


def test_endpoint_says_so_when_nothing_is_recorded_or_the_backend_is_unsupported(monkeypatch, tmp_path):
    empty = _client(monkeypatch, tmp_path, [_store(database_path="./none.sqlite3")]).get("/api/projects/p1/knowledge-base/health").json()
    assert empty["status"] == "empty"
    body = _client(monkeypatch, tmp_path, [_store(backend="bigquery")]).get("/api/projects/p1/knowledge-base/health").json()
    assert body["status"] == "unsupported_backend"
