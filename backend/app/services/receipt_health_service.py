"""Knowledge-base health, read straight from a context receipt store's SQLite file.

The store (resources/context_receipt_store in the community templates) records, for every retrieval, which chunks
were served, and later attaches outcomes (thumbs, edits, escalations) and evidence (citations). This reads those
tables read-only and folds them into what an owner of a knowledge base wants to see: how much it is used, how well it
is working, which chunks keep failing, and which recipe (code_version) built the chunks that are doing badly.

The folding mirrors the store's own ``item_feedback`` (a receipt's effective outcome is the mean of its outcomes, a
later outcome with the same ``outcome_ref`` supersedes the earlier). It deliberately does not import the store: it
only needs the five-table schema, so it works on any DB written by the SQLite backend regardless of the project's
sandbox environment. BigQuery-backed stores are reported as unsupported rather than guessed at.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# A chunk needs this many rated retrievals before its mean outcome is trusted (same default as receipts.min_outcomes).
MIN_RATED = 3
FAILING_BELOW = -0.3
TOP_N = 10


class ReceiptStoreUnavailable(RuntimeError):
    pass


def _connect_readonly(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise ReceiptStoreUnavailable(f"No receipt database at {path} yet -- nothing has been recorded.")
    conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _has_tables(conn: sqlite3.Connection) -> bool:
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {"context_receipts", "context_receipt_items", "context_receipt_events"} <= names


def _since_iso(days: int | None) -> str:
    if not days:
        return ""
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def list_assets(path: Path) -> list[str]:
    """Knowledge-base asset keys that have at least one recorded retrieval."""
    with closing(_connect_readonly(path)) as conn:
        if not _has_tables(conn):
            return []
        return [r[0] for r in conn.execute(
            "SELECT DISTINCT source_asset_key FROM context_receipt_items WHERE source_asset_key IS NOT NULL ORDER BY 1"
        )]


def _effective_outcomes(events: list[sqlite3.Row]) -> tuple[dict[str, dict[str, float]], dict[str, list[set[str] | None]]]:
    outcomes: dict[str, dict[str, float]] = {}
    cited: dict[str, list[set[str] | None]] = {}
    for ev in events:
        try:
            payload = json.loads(ev["payload_json"])
        except (TypeError, ValueError):
            continue
        rid = ev["receipt_id"]
        if ev["event_type"] == "outcome":
            value = payload.get("value")
            if isinstance(value, (int, float)):
                key = payload.get("outcome_ref") or f"anon-{len(outcomes.get(rid, {}))}"
                outcomes.setdefault(rid, {})[key] = float(value)
        elif payload.get("level") in ("cited", "verified", "counterfactual_tested"):
            scoped = (payload.get("details") or {}).get("item_ids")
            cited.setdefault(rid, []).append(set(scoped) if isinstance(scoped, list) else None)
    return outcomes, cited


def asset_health(path: Path, asset_key: str, days: int | None = 30) -> dict[str, Any]:
    since = _since_iso(days)
    with closing(_connect_readonly(path)) as conn:
        if not _has_tables(conn):
            raise ReceiptStoreUnavailable("This database has no receipt tables -- is it a context receipt store?")
        item_rows = conn.execute(
            "SELECT DISTINCT i.receipt_id, i.item_id, r.created_at, COALESCE(i.source_code_version, 'unknown') AS code_version "
            "FROM context_receipt_items i JOIN context_receipts r ON r.receipt_id = i.receipt_id "
            "WHERE i.source_asset_key = ? AND r.created_at >= ?", (asset_key, since),
        ).fetchall()
        excl_rows = conn.execute(
            "SELECT e.item_id, e.reason FROM context_receipt_excluded e JOIN context_receipts r ON r.receipt_id = e.receipt_id "
            "WHERE e.source_asset_key = ? AND r.created_at >= ?", (asset_key, since),
        ).fetchall() if "context_receipt_excluded" in {r[0] for r in conn.execute("SELECT name FROM sqlite_master")} else []
        receipt_ids = sorted({r["receipt_id"] for r in item_rows})
        events: list[sqlite3.Row] = []
        for start in range(0, len(receipt_ids), 500):  # stay under SQLite's bound-variable limit
            batch = receipt_ids[start:start + 500]
            events.extend(conn.execute(
                "SELECT receipt_id, event_type, payload_json FROM context_receipt_events "
                f"WHERE event_type IN ('outcome', 'evidence') AND receipt_id IN ({','.join('?' * len(batch))}) ORDER BY rowid",
                batch,
            ).fetchall())

    outcomes, cited = _effective_outcomes(events)
    receipt_outcome = {rid: sum(v.values()) / len(v) for rid, v in outcomes.items() if v}

    chunks: dict[str, dict[str, Any]] = {}
    versions: dict[str, dict[str, Any]] = {}
    last_retrieved: str | None = None
    for row in item_rows:
        c = chunks.setdefault(row["item_id"], {"retrievals": 0, "rated": 0, "_sum": 0.0, "cited": 0, "excluded": {}})
        c["retrievals"] += 1
        v = versions.setdefault(row["code_version"], {"retrievals": 0, "rated": 0, "_sum": 0.0})
        v["retrievals"] += 1
        if last_retrieved is None or row["created_at"] > last_retrieved:
            last_retrieved = row["created_at"]
        out = receipt_outcome.get(row["receipt_id"])
        if out is not None:
            c["rated"] += 1
            c["_sum"] += out
            v["rated"] += 1
            v["_sum"] += out
        if any(scope is None or row["item_id"] in scope for scope in cited.get(row["receipt_id"], [])):
            c["cited"] += 1
    excluded_totals: dict[str, int] = {}
    for row in excl_rows:
        excluded_totals[row["reason"]] = excluded_totals.get(row["reason"], 0) + 1
        c = chunks.setdefault(row["item_id"], {"retrievals": 0, "rated": 0, "_sum": 0.0, "cited": 0, "excluded": {}})
        c["excluded"][row["reason"]] = c["excluded"].get(row["reason"], 0) + 1

    def mean(entry: dict[str, Any]) -> float | None:
        return round(entry["_sum"] / entry["rated"], 4) if entry["rated"] else None

    chunk_list = [
        {"chunk_id": cid, "retrievals": c["retrievals"], "rated": c["rated"], "mean_outcome": mean(c), "cited": c["cited"], "excluded": c["excluded"]}
        for cid, c in chunks.items()
    ]
    trusted = [c for c in chunk_list if c["rated"] >= MIN_RATED and c["mean_outcome"] is not None]
    failing = sorted((c for c in trusted if c["mean_outcome"] <= FAILING_BELOW), key=lambda c: (c["mean_outcome"], -c["rated"]))
    best = sorted((c for c in trusted if c["mean_outcome"] > 0), key=lambda c: (-c["mean_outcome"], -c["rated"]))
    rated_total = sum(c["rated"] for c in chunks.values())
    outcome_sum = sum(c["_sum"] for c in chunks.values())

    return {
        "asset_key": asset_key,
        "window_days": days,
        "receipts": len(receipt_ids),
        "chunks_retrieved": sum(1 for c in chunk_list if c["retrievals"] > 0),
        "retrievals": sum(c["retrievals"] for c in chunks.values()),
        "rated_retrievals": rated_total,
        "mean_outcome": round(outcome_sum / rated_total, 4) if rated_total else None,
        "cited_retrievals": sum(c["cited"] for c in chunks.values()),
        "last_retrieved_at": last_retrieved,
        "excluded": excluded_totals,
        "failing_chunks": failing[:TOP_N],
        "failing_chunk_count": len(failing),
        "top_chunks": best[:TOP_N],
        "by_code_version": [
            {"code_version": cv, "retrievals": v["retrievals"], "rated": v["rated"], "mean_outcome": mean(v)}
            for cv, v in sorted(versions.items(), key=lambda kv: -kv[1]["retrievals"])
        ],
        "thresholds": {"min_rated": MIN_RATED, "failing_below": FAILING_BELOW},
    }
