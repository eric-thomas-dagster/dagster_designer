"""Lightweight ingestion event log.

Every materialize + successful preview appends a JSON-line to
`<project>/data/ingestion_events.jsonl`. Cheap to write, cheap to read
(one file per project, capped by rotation in the reader), and doesn't
introduce a new DB dependency. The frontend computes KPIs and trend
charts client-side from the returned events.

Event shape (one line per event):
    {
        "ts":         "2026-07-10T14:22:31.123456+00:00",  # ISO-8601 UTC
        "type":       "materialize" | "preview",
        "asset_key":  "seeds/raw_customers",
        "component":  "raw_customers_ingest",              # instance id
        "rows":       12345,                                # optional
        "bytes":      987654,                               # optional, best-effort
        "duration_ms": 4210,                                # optional
        "status":     "success" | "failure" | "running",
    }
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


# Cap so a chatty project can't run us out of memory when the frontend
# fetches history — 5000 events is ~1MB and covers weeks of activity.
_MAX_EVENTS_PER_PROJECT = 5000


def _log_path(project_dir: Path) -> Path:
    p = project_dir / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p / "ingestion_events.jsonl"


def record_event(
    project_dir: Path,
    *,
    event_type: str,
    asset_key: str,
    component: str | None = None,
    rows: int | None = None,
    bytes_ingested: int | None = None,
    duration_ms: int | None = None,
    status: str = "success",
) -> None:
    """Append a single event. Non-fatal on any error — the primary flow
    (materialize / preview) must never fail because logging can't."""
    try:
        path = _log_path(project_dir)
        event: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "type": event_type,
            "asset_key": asset_key,
            "status": status,
        }
        if component is not None:
            event["component"] = component
        if rows is not None:
            event["rows"] = rows
        if bytes_ingested is not None:
            event["bytes"] = bytes_ingested
        if duration_ms is not None:
            event["duration_ms"] = duration_ms
        with open(path, "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception as e:
        # Deliberately swallow — logging must never break the caller.
        print(f"[ingestion_history] Failed to record event: {e}", flush=True)


def read_events(project_dir: Path, limit: int = 1000) -> list[dict[str, Any]]:
    """Read the last N events for a project. Malformed lines are silently
    dropped so a truncated write doesn't take down the endpoint."""
    path = _log_path(project_dir)
    if not path.exists():
        return []
    try:
        with open(path, "r") as f:
            lines = f.readlines()
    except Exception:
        return []
    # Keep only the tail. If we're above the cap, also rewrite the file
    # to trim it so it doesn't grow unbounded across sessions.
    if len(lines) > _MAX_EVENTS_PER_PROJECT:
        try:
            with open(path, "w") as f:
                f.writelines(lines[-_MAX_EVENTS_PER_PROJECT:])
        except Exception:
            pass
        lines = lines[-_MAX_EVENTS_PER_PROJECT:]

    lines = lines[-limit:]
    out: list[dict[str, Any]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    return out


class MaterializeTimer:
    """Context manager that measures wall-clock duration and records an
    ingestion event when it exits. Failures record status='failure' with
    the exception message in the outer flow if the caller cares."""

    def __init__(self, project_dir: Path, asset_key: str, component: str | None = None):
        self.project_dir = project_dir
        self.asset_key = asset_key
        self.component = component
        self._start = 0.0
        self.status = "success"
        self.rows: int | None = None
        self.bytes: int | None = None

    def __enter__(self) -> "MaterializeTimer":
        self._start = time.time()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        duration_ms = int((time.time() - self._start) * 1000)
        if exc_type is not None:
            self.status = "failure"
        record_event(
            self.project_dir,
            event_type="materialize",
            asset_key=self.asset_key,
            component=self.component,
            rows=self.rows,
            bytes_ingested=self.bytes,
            duration_ms=duration_ms,
            status=self.status,
        )


def iter_kpis(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Helper used mostly by tests — the real UI computes these client-side."""
    materializes = [e for e in events if e.get("type") == "materialize"]
    successes = [e for e in materializes if e.get("status") == "success"]
    total_rows = sum(e.get("rows") or 0 for e in successes)
    total_bytes = sum(e.get("bytes") or 0 for e in successes)
    return {
        "materialize_count": len(materializes),
        "success_count": len(successes),
        "failure_count": len(materializes) - len(successes),
        "total_rows_ingested": total_rows,
        "total_bytes_ingested": total_bytes,
    }
