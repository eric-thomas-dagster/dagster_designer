"""Monitor run history — append-only jsonl per project.

Each monitor run (dbt test, native asset check, or enhanced check)
appends a line to `<project>/data/monitor_events.jsonl`. The frontend
Monitors drawer reads these back and renders:
  • pass/fail timeline (last N runs)
  • numeric metric chart (row_count / null_ratio / freshness_age / ...)

Non-destructive to the project; the file is capped so a chatty pipeline
can't run us out of disk.

Event shape (one line per event):
    {
        "ts":         "2026-07-10T14:22:31.123456+00:00",
        "monitor_id": "test.jaffle_shop.not_null_customers_id",
        "kind":       "dbt_test" | "asset_check" | "enhanced_check",
        "status":     "pass" | "fail" | "warn" | "error" | "skipped",
        "duration_ms": 4210,        # optional
        "failures":    0,           # optional — rows-failed for dbt tests
        "message":     "...",       # optional — failure detail
        "value":       0.02,        # optional — numeric metric (for charting)
        "value_label": "null_ratio" # optional — chart y-axis
    }
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Keep well below the ingestion cap; monitors run less often but the
# file grows across many monitors so 20k gives us headroom (~4MB).
_MAX_EVENTS_PER_PROJECT = 20_000


def _log_path(project_dir: Path) -> Path:
    p = project_dir / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p / "monitor_events.jsonl"


def record_event(
    project_dir: Path,
    *,
    monitor_id: str,
    kind: str,
    status: str,
    duration_ms: int | None = None,
    failures: int | None = None,
    message: str | None = None,
    value: float | None = None,
    value_label: str | None = None,
    expected_min: float | None = None,
    expected_max: float | None = None,
    ts: str | None = None,
) -> None:
    """Append one monitor event. Non-fatal on any I/O error — logging
    should never break the caller (dbt run, materialize, etc.).

    expected_min/expected_max let anomaly-detection enhanced checks
    record the band their datapoint was compared against, which the
    UI then renders as Sifflet-style per-point bounds on the chart.
    """
    try:
        path = _log_path(project_dir)
        event: dict[str, Any] = {
            "ts": ts or datetime.now(timezone.utc).isoformat(),
            "monitor_id": monitor_id,
            "kind": kind,
            "status": status,
        }
        if duration_ms is not None: event["duration_ms"] = duration_ms
        if failures is not None: event["failures"] = failures
        if message: event["message"] = message[:1000]
        if value is not None: event["value"] = value
        if value_label: event["value_label"] = value_label
        if expected_min is not None: event["expected_min"] = expected_min
        if expected_max is not None: event["expected_max"] = expected_max
        with open(path, "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception as e:
        print(f"[monitor_history] Failed to record event: {e}", flush=True)


def read_events(project_dir: Path, *, monitor_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    """Read events for one monitor (or all when monitor_id is None).
    Malformed lines are silently dropped. Rotates the file if it grows
    past the cap."""
    path = _log_path(project_dir)
    if not path.exists():
        return []
    try:
        with open(path, "r") as f:
            lines = f.readlines()
    except Exception:
        return []
    if len(lines) > _MAX_EVENTS_PER_PROJECT:
        try:
            with open(path, "w") as f:
                f.writelines(lines[-_MAX_EVENTS_PER_PROJECT:])
        except Exception:
            pass
        lines = lines[-_MAX_EVENTS_PER_PROJECT:]

    out: list[dict[str, Any]] = []
    for line in reversed(lines):  # newest first — makes early-exit on limit cheap
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if monitor_id and evt.get("monitor_id") != monitor_id:
            continue
        out.append(evt)
        if len(out) >= limit:
            break
    # Return in chronological order for chart-friendliness.
    out.reverse()
    return out


def snapshot_dbt_run_results(project_dir: Path, run_results: dict[str, Any]) -> int:
    """Snapshot all test results from a `run_results.json` into the
    history log. Returns the number of new events recorded. Skips
    non-test results — those show up in the model list, not here.

    We de-dupe against the last-seen ts per monitor so re-parsing the
    same run_results doesn't double-append if the caller invokes us
    twice in a row.
    """
    if not run_results:
        return 0

    # Build a "last ts per monitor" map from the current tail so we
    # don't append duplicates across repeated snapshots.
    tail = read_events(project_dir, limit=2_000)
    seen: dict[str, str] = {}
    for evt in tail:
        mid = evt.get("monitor_id")
        ts = evt.get("ts")
        if mid and ts:
            if mid not in seen or ts > seen[mid]:
                seen[mid] = ts

    written = 0
    ts_iso = datetime.now(timezone.utc).isoformat()
    # Prefer the run's own completed_at when present — helps history
    # look correct if a snapshot happens later than the actual run.
    for r in run_results.get("results", []) or []:
        uid = r.get("unique_id")
        if not uid or not uid.startswith("test."):
            continue
        completed = r.get("completed_at") if isinstance(r.get("completed_at"), str) else None
        this_ts = completed or ts_iso
        if seen.get(uid) == this_ts:
            continue
        record_event(
            project_dir,
            monitor_id=uid,
            kind="dbt_test",
            status=(r.get("status") or "unknown"),
            duration_ms=(int(r.get("execution_time", 0) * 1000) if r.get("execution_time") is not None else None),
            failures=(r.get("failures") if isinstance(r.get("failures"), int) else None),
            message=(r.get("message") or None),
            ts=this_ts,
        )
        written += 1
    return written
