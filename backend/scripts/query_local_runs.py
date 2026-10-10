"""Direct-instance replacement for the local half of runs.py's GraphQL
calls (see that file's module docstring for the cloud half, which is
untouched -- Dagster+ has no file-level instance access at all, so
GraphQL remains the only option there).

Every "local" Dagster feature EXCEPT Runs/Partitions already reads
straight from the project's own persistent instance (.designer_dagster_home)
via a short-lived subprocess -- see extract_run_metadata.py. Runs and
Partitions were the two exceptions, built against a live
`dg dev` GraphQL endpoint instead, which meant they (and only they)
stopped working the moment that process wasn't running -- confirmed
directly responsible for a string of real, reported issues this
session (empty Runs page, "none" partition info, a genuinely stuck-but-
invisible-why run). This script closes that gap for every READ path.
Re-execution is the one piece left on GraphQL (see runs.py) -- it has no
`dg launch` CLI equivalent and would need full in-process repository
loading, a materially bigger and riskier lift than everything else here.

Usage: python -m scripts.query_local_runs <dagster_home> <mode> <json_args>
Prints one JSON object to stdout. Never raises past main() -- errors
come back as {"error": "..."} so the caller gets a clean message instead
of a stack trace mixed into stdout.
"""
import sys
import json
import warnings

warnings.filterwarnings('ignore')


def _event_type_label(event_type_value: str | None) -> str:
    """'STEP_SUCCESS' -> 'StepSuccessEvent', matching the GraphQL
    __typename convention closely enough for display (the frontend only
    ever shows this as a label, see RunsPanel.tsx's `.replace(/Event$/, '')`
    -- never branches logic on exact value)."""
    if not event_type_value:
        return "LogMessageEvent"
    return "".join(w.capitalize() for w in event_type_value.split("_")) + "Event"


def mode_list_runs(instance, args: dict) -> dict:
    from datetime import datetime, timezone
    from dagster._core.storage.dagster_run import RunsFilter, DagsterRunStatus

    # RunsFilter's real shape differs from the GraphQL RunsFilter this
    # replaces in three ways, all confirmed by reading RunsFilter's own
    # source rather than guessing: statuses are enum members (not plain
    # strings), tags is a Dict[str, str] (not a [{key,value}] list), and
    # the date filters are `datetime` objects (not unix timestamps).
    statuses = []
    for s in (args.get("statuses") or []):
        try:
            statuses.append(DagsterRunStatus[s.upper()])
        except KeyError:
            continue

    tags_list = args.get("tags") or []
    tags = {t["key"]: t["value"] for t in tags_list if t.get("key")}

    def _dt(ts):
        return datetime.fromtimestamp(ts, tz=timezone.utc) if ts is not None else None

    filters = RunsFilter(
        job_name=args.get("job_name") or None,
        statuses=statuses or None,
        tags=tags or None,
        created_after=_dt(args.get("created_after")),
        created_before=_dt(args.get("created_before")),
        updated_after=_dt(args.get("updated_after")),
    )
    limit = args.get("limit") or 25
    cursor = args.get("cursor")
    records = instance.get_run_records(filters=filters, limit=limit, cursor=cursor)

    runs = []
    for r in records:
        run = r.dagster_run
        try:
            stats = instance.get_run_stats(run.run_id)
        except Exception:
            stats = None
        runs.append({
            "run_id": run.run_id,
            "job_name": run.job_name,
            "status": run.status.value if hasattr(run.status, "value") else str(run.status),
            "start_time": getattr(stats, "start_time", None),
            "end_time": getattr(stats, "end_time", None),
            "steps_succeeded": getattr(stats, "steps_succeeded", None),
            "steps_failed": getattr(stats, "steps_failed", None),
            "materializations": getattr(stats, "materializations", None),
        })
    next_cursor = runs[-1]["run_id"] if runs else None
    return {"runs": runs, "next_cursor": next_cursor}


def mode_run_detail(instance, args: dict) -> dict:
    import yaml
    from dagster._core.storage.dagster_run import DagsterRunStatus

    run_id = args["run_id"]
    run = instance.get_run_by_id(run_id)
    if run is None:
        return {"error": "not_found", "message": f"Run {run_id} not found"}

    try:
        stats = instance.get_run_stats(run_id)
    except Exception:
        stats = None

    # Steps + retry-chain expansion -- same shape/semantics as runs.py's
    # existing GraphQL-based logic (step_edges built below reuse the exact
    # same first/last-attempt-key bridging approach).
    steps = []
    first_attempt_key: dict[str, str] = {}
    last_attempt_key: dict[str, str] = {}
    retry_edges: list[dict] = []
    try:
        step_stats = instance.get_run_step_stats(run_id)
        for s in step_stats:
            key = s.step_key
            # `attempts` is just a COUNT (an int) -- the actual per-attempt
            # records (with their own start/end times) are in
            # `attempts_list`, confirmed live (the int tripped up an
            # earlier version of this that assumed `attempts` was the list).
            attempts = list(getattr(s, "attempts_list", None) or [])
            final_status = s.status.value if hasattr(s.status, "value") else str(s.status)
            if len(attempts) <= 1:
                steps.append({"step_key": key, "status": final_status,
                              "start_time": s.start_time, "end_time": s.end_time})
                first_attempt_key[key] = key
                last_attempt_key[key] = key
            else:
                node_keys = []
                for i, a in enumerate(attempts):
                    is_last = (i == len(attempts) - 1)
                    node_key = key if is_last else f"{key}#attempt-{i}"
                    node_keys.append(node_key)
                    steps.append({
                        "step_key": node_key,
                        "status": final_status if is_last else "RETRIED",
                        "start_time": getattr(a, "start_time", None),
                        "end_time": getattr(a, "end_time", None),
                    })
                first_attempt_key[key] = node_keys[0]
                last_attempt_key[key] = node_keys[-1]
                for a, b in zip(node_keys, node_keys[1:]):
                    retry_edges.append({"from_step": a, "to_step": b})
    except Exception as e:
        print(f"[query_local_runs] step stats failed: {e}", file=sys.stderr, flush=True)

    # Execution plan -- step dependency DAG, same dynamic-fanout handling
    # (base-name stripping + expansion) as runs.py's GraphQL version.
    step_edges = list(retry_edges)
    plan_keys: list[str] = []
    if not steps:
        # Fallback: no runtime stats yet -- derive placeholder steps from
        # the plan snapshot alone (no timings), same as the GraphQL path's
        # own fallback.
        try:
            if run.execution_plan_snapshot_id:
                plan = instance.get_execution_plan_snapshot(run.execution_plan_snapshot_id)
                for s in plan.steps:
                    steps.append({"step_key": s.key, "status": "UNKNOWN"})
        except Exception:
            pass

    try:
        if run.execution_plan_snapshot_id:
            import re
            dyn_suffix = re.compile(r"\[[^\]]*\]$")
            def base(k: str) -> str:
                return dyn_suffix.sub("", k)

            plan = instance.get_execution_plan_snapshot(run.execution_plan_snapshot_id)
            plan_keys = [s.key for s in plan.steps]
            original_keys = set(first_attempt_key.keys())
            by_base: dict[str, list[str]] = {}
            for k in original_keys:
                by_base.setdefault(base(k), []).append(k)

            for step in plan.steps:
                to_key = step.key
                to_base = base(to_key)
                to_instances = by_base.get(to_base) or ([to_key] if to_key in original_keys else [])
                if not to_instances:
                    continue
                for inp in (step.inputs or []):
                    for handle in (inp.upstream_output_handles or []):
                        from_key = handle.step_key
                        from_base = base(from_key)
                        from_instances = by_base.get(from_base) or (
                            [from_key] if from_key in original_keys else []
                        )
                        for f in from_instances:
                            for t in to_instances:
                                if f != t:
                                    step_edges.append({
                                        "from_step": last_attempt_key.get(f, f),
                                        "to_step": first_attempt_key.get(t, t),
                                    })
    except Exception as e:
        print(f"[query_local_runs] execution plan failed: {e}", file=sys.stderr, flush=True)

    seen = set()
    deduped = []
    for e in step_edges:
        k = (e["from_step"], e["to_step"])
        if k in seen:
            continue
        seen.add(k)
        deduped.append(e)
    step_edges = deduped

    # Materializations -- direct event-log read, not a per-asset fetch.
    mats = []
    try:
        from dagster import DagsterEventType
        conn = instance.get_records_for_run(run_id, of_type=DagsterEventType.ASSET_MATERIALIZATION)
        for rec in conn.records:
            mat = rec.asset_materialization
            if mat is None:
                continue
            entries = []
            for label, mv in (mat.metadata or {}).items():
                entries.append({
                    "label": label,
                    "description": None,
                    "type": type(mv).__name__,
                })
            mats.append({
                "asset_key": "/".join(mat.asset_key.path) if mat.asset_key else "",
                "partition": rec.partition_key,
                "timestamp": rec.timestamp,
                "metadata": entries,
            })
    except Exception as e:
        print(f"[query_local_runs] materializations failed: {e}", file=sys.stderr, flush=True)

    run_config_yaml = None
    try:
        run_config_yaml = yaml.dump(run.run_config or {})
    except Exception:
        pass

    return {
        "run_id": run.run_id,
        "job_name": run.job_name,
        "status": run.status.value if hasattr(run.status, "value") else str(run.status),
        "start_time": getattr(stats, "start_time", None),
        "end_time": getattr(stats, "end_time", None),
        "run_config_yaml": run_config_yaml,
        "tags": dict(run.tags or {}),
        "steps": steps,
        "step_edges": step_edges,
        "materializations": mats,
        "steps_succeeded": getattr(stats, "steps_succeeded", None),
        "steps_failed": getattr(stats, "steps_failed", None),
    }


def mode_run_logs(instance, args: dict) -> dict:
    import logging

    run_id = args["run_id"]
    cursor = args.get("cursor")
    limit = args.get("limit") or 200

    conn = instance.get_records_for_run(run_id, cursor=cursor, limit=limit)
    events = []
    for rec in conn.records:
        entry = rec.event_log_entry
        de = entry.dagster_event
        # entry.level is a plain logging int constant (10/20/30/...), not
        # already a name -- confirmed live (every event came back with
        # level: null until this conversion was added). GraphQL's `level`
        # field returns the name (DEBUG/INFO/...), so convert the same way
        # here for the frontend's existing level-based styling to work.
        level_name = entry.level if isinstance(entry.level, str) else (
            logging.getLevelName(entry.level) if entry.level is not None else None
        )
        events.append({
            "type_name": _event_type_label(de.event_type_value if de else None),
            "message": entry.user_message or (de.message if de else None),
            "level": level_name,
            "timestamp": entry.timestamp,
            "step_key": entry.step_key,
        })
    return {
        "events": events,
        "cursor": str(conn.cursor) if conn.cursor is not None else None,
        "has_more": bool(conn.has_more),
    }


def mode_run_status(instance, args: dict) -> dict:
    run = instance.get_run_by_id(args["run_id"])
    if run is None:
        return {"status": "UNKNOWN", "message": "Run not found"}
    return {"status": run.status.value if hasattr(run.status, "value") else str(run.status)}


def mode_terminate(instance, args: dict) -> dict:
    run_id = args["run_id"]
    run = instance.get_run_by_id(run_id)
    if run is None:
        return {"success": False, "message": "Run not found"}
    try:
        ok = instance.run_launcher.terminate(run_id)
    except Exception as e:
        return {"success": False, "message": str(e)}
    if not ok:
        return {"success": False, "message": "Termination failed"}
    updated = instance.get_run_by_id(run_id)
    status = updated.status.value if updated and hasattr(updated.status, "value") else "CANCELING"
    return {"success": True, "status": status}


def mode_tag_keys(instance, args: dict) -> dict:
    # No direct "distinct tag keys" API -- scan tags off a reasonably
    # large recent window instead (matches the GraphQL path's own
    # practical scope: dropdown population, not exhaustive history).
    records = instance.get_run_records(limit=args.get("scan_limit") or 500)
    keys: set[str] = set()
    for r in records:
        keys.update((r.dagster_run.tags or {}).keys())
    return {"tag_keys": sorted(k for k in keys if k)}


def mode_tag_values(instance, args: dict) -> dict:
    key = args["key"]
    records = instance.get_run_records(limit=args.get("scan_limit") or 500)
    values: set[str] = set()
    for r in records:
        v = (r.dagster_run.tags or {}).get(key)
        if v:
            values.add(v)
    return {"values": sorted(values)}


def mode_job_names(instance, args: dict) -> dict:
    # Distinct job_name across recent runs -- cheap, no repository/
    # workspace load needed (unlike the GraphQL path, which enumerated
    # the whole workspace; this project's own run history already names
    # every job that's ever actually been launched, which is what the
    # filter dropdown needs).
    records = instance.get_run_records(limit=args.get("scan_limit") or 500)
    names: set[str] = set()
    for r in records:
        n = r.dagster_run.job_name
        if n and not n.startswith("__"):
            names.add(n)
    return {"job_names": sorted(names)}


MODES = {
    "list_runs": mode_list_runs,
    "run_detail": mode_run_detail,
    "run_logs": mode_run_logs,
    "run_status": mode_run_status,
    "terminate": mode_terminate,
    "tag_keys": mode_tag_keys,
    "tag_values": mode_tag_values,
    "job_names": mode_job_names,
}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: query_local_runs.py <dagster_home> <mode> [json_args]"}))
        sys.exit(1)

    dagster_home = sys.argv[1]
    mode = sys.argv[2]
    args = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else {}

    if mode not in MODES:
        print(json.dumps({"error": f"Unknown mode '{mode}'"}))
        sys.exit(1)

    try:
        from dagster import DagsterInstance
    except Exception as e:
        print(json.dumps({"error": f"Could not import dagster: {e}"}))
        sys.exit(1)

    try:
        instance = DagsterInstance.from_config(dagster_home)
    except Exception as e:
        print(json.dumps({"error": f"Failed to open instance at {dagster_home}: {e}"}))
        sys.exit(1)

    try:
        result = MODES[mode](instance, args)
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(1)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
