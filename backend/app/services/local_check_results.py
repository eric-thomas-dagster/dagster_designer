"""Latest asset-check results for a LOCAL project, read straight from its own Dagster
instance (`<project>/.designer_dagster_home`).

Why: the Monitors page used to learn a check's last status only from dbt's own
`run_results.json` (which the Dagster dbt component never updates -- it runs dbt in a
staged copy of the project) or from a live `dg dev` GraphQL server. With neither, every
check read "never run" even though Dagster had recorded the results of each run in the
instance's `asset_check_executions` table (confirmed: 79 successful executions across 37
checks while Monitors showed 95 "never run").
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# Dagster's AssetCheckExecutionRecordStatus -> the statuses the Monitors page buckets on.
# PLANNED / IN_PROGRESS / SKIPPED aren't results, so they're never reported.
_STATUS = {"SUCCEEDED": "pass", "FAILED": "fail", "EXECUTION_FAILED": "error"}
_HISTORY = 20

_QUERY = """
SELECT asset_key, check_name, execution_status, create_timestamp, run_id, evaluation_event
FROM asset_check_executions
WHERE execution_status IN ('SUCCEEDED', 'FAILED', 'EXECUTION_FAILED')
ORDER BY id
"""


def _asset_key_to_path(raw: str) -> str:
    """'["a", "b"]' (Dagster's stored asset key) -> 'a/b'."""
    try:
        parts = json.loads(raw)
        return "/".join(parts) if isinstance(parts, list) else str(raw)
    except (TypeError, ValueError):
        return str(raw)


def _iso(ts: Any) -> str | None:
    """Dagster stores naive UTC datetimes ('2026-10-16 14:26:22[.ffffff]')."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts)).replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def read_latest_check_results(project_dir: Path) -> dict[tuple[str, str], dict]:
    """{(asset_key 'a/b', check_name): {status, last_run_at, run_id, recent}} -- latest
    completed result per check, plus its last <=20 results oldest-first for the trend.
    Empty if the project has no instance yet. Never raises."""
    db = project_dir / ".designer_dagster_home" / "history" / "runs" / "index.db"
    if not db.exists():
        return {}
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        try:
            rows = conn.execute(_QUERY).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return {}

    out: dict[tuple[str, str], dict] = {}
    for asset_key, check_name, status, created, run_id, evaluation in rows:
        mapped = _STATUS.get(status)
        if not mapped:
            continue
        # A failed WARN-severity check is a warning, not a failure.
        if mapped == "fail" and evaluation and "AssetCheckSeverity.WARN" in str(evaluation):
            mapped = "warn"
        entry = out.setdefault((_asset_key_to_path(asset_key), check_name), {"recent": []})
        entry["recent"].append(mapped)  # rows are in id order => oldest first
        entry.update(status=mapped, last_run_at=_iso(created), run_id=run_id)
    for entry in out.values():
        entry["recent"] = entry["recent"][-_HISTORY:]
    return out


def _dbt_test_name(unique_id: str) -> str | None:
    """'test.<project>.<test name>[.<hash>]' -> '<test name>' (how dagster-dbt names the
    check). Generic tests (not_null, unique, ...) carry a trailing hash; singular tests
    (tests/*.sql) don't."""
    parts = unique_id.split(".")
    return parts[2] if len(parts) >= 3 and parts[0] == "test" else None


def _check_identity(m: Any) -> tuple[str, str] | None:
    """(asset_key, check_name) for a native/enhanced check monitor. The id is
    '<asset>:<check>' for graph-derived checks (single colon) but '<asset>::<check>' for
    others, so prefer the monitor's own target asset + label, and only then parse the id."""
    if getattr(m, "target_asset_keys", None) and getattr(m, "label", None):
        return m.target_asset_keys[0], m.label
    for sep in ("::", ":"):
        if sep in m.id:
            asset_key, check_name = m.id.rsplit(sep, 1)
            return asset_key, check_name
    return None


def _newer(candidate: str | None, existing: str | None) -> bool:
    if not existing:
        return True
    return bool(candidate) and candidate > existing  # both 'YYYY-MM-DDTHH:MM:SSZ'


def apply_local_check_results(project_dir: Path, monitors: Iterable[Any]) -> int:
    """Fill last_status / last_run_at / recent_statuses on monitors from the instance,
    unless the monitor already has a NEWER result of its own. Returns how many were set."""
    results = read_latest_check_results(project_dir)
    if not results:
        return 0
    by_name: dict[str, dict] = {}
    for (_, name), r in results.items():
        cur = by_name.get(name)
        if cur is None or _newer(r.get("last_run_at"), cur.get("last_run_at")):
            by_name[name] = r

    applied = 0
    for m in monitors:
        r = None
        if m.kind == "dbt_test":
            name = _dbt_test_name(m.id)
            r = by_name.get(name) if name else None
        else:
            ident = _check_identity(m)
            r = results.get(ident) if ident else None
        if not r:
            continue
        if _newer(r.get("last_run_at"), m.last_run_at):
            m.last_status = r["status"]
            m.last_run_at = r["last_run_at"]
        if r.get("recent") and not m.recent_statuses:
            m.recent_statuses = list(r["recent"])
        applied += 1
    return applied
