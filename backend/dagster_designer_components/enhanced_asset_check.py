"""EnhancedAssetCheckComponent -- real implementations for the check kinds
Dagster Designer's Monitors "Add monitor" wizard writes.

YAML shape (written by projects.py's add_monitor endpoint):

    type: dagster_designer_components.EnhancedAssetCheckComponent
    attributes:
      name: <check name>
      asset: <target asset key, e.g. "models/orders">
      kind: row_count | freshness | null_ratio | uniqueness | accepted_values
          | accepted_range | not_null | custom | distribution_drift
          | regex_match | schema_change | referential_integrity
          | duplicate_count | stddev_check | mean_shift | quantile_check
          | zero_count | sum_check | min_max_check | anomaly_detection
      severity: error | warn | info
      params: {...}   # kind-specific, see each _check_* function below
      description: optional
      db_schema: optional, default "main" -- dbt-duckdb's default schema,
          used to resolve `asset` to a queryable "schema.table" identifier
      schedule / alerts: written by the wizard for humans to read and (for
          now) hand-wire -- this component focuses on making the check
          ITSELF real; it does not generate the schedule/sensor that
          would auto-run it or the Slack/email delivery. Attach a
          ScheduleComponent / route through your own alerting for that.

Connection: DuckDB is queried directly (see _check_helpers.run_query) --
no extra dependency since `duckdb` already ships with dbt-duckdb. Other
warehouses fall back to SqlTransformerComponent's SQLAlchemy-based
resolution, which needs sqlalchemy + a dialect driver installed.
"""

import re
from typing import Any, Callable, Optional

import dagster as dg

from ._check_helpers import (
    append_check_history,
    asset_key_from_string,
    columns_for_table,
    ks_pvalue,
    ks_statistic,
    latest_materialization_timestamp,
    one_row,
    query_df,
    read_check_sample,
    run_query,
    scalar,
    table_for_asset_key,
    write_check_sample,
    zscore,
)

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_ident(name: str, what: str) -> str:
    if not name or not _IDENT_RE.match(name):
        raise ValueError(f"{what} {name!r} isn't a safe SQL identifier (letters/digits/underscore only).")
    return name


def _severity(s: str) -> dg.AssetCheckSeverity:
    # AssetCheckSeverity only has WARN/ERROR (no INFO tier in Dagster) --
    # map our 3-way wizard severity down to that, treating 'info' as the
    # least-severe available option rather than dropping it.
    return dg.AssetCheckSeverity.ERROR if (s or "error").lower() == "error" else dg.AssetCheckSeverity.WARN


class EnhancedAssetCheckComponent(dg.Component, dg.Model, dg.Resolvable):
    """Real, general-purpose data-quality checks -- the implementation
    behind Monitors' 'enhanced_check' path."""

    name: str
    asset: str
    kind: str
    severity: str = "error"
    params: dict = {}
    description: Optional[str] = None
    # Named db_schema (not `schema`) to avoid shadowing Model's own
    # `.schema` attribute -- Pydantic warns loudly if a field does that.
    db_schema: str = "main"
    # Written by the wizard, not yet acted on by this component --
    # attach real scheduling/alerting separately (see module docstring).
    schedule: Optional[dict] = None
    alerts: Optional[dict] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        check_name = self.name
        asset_key_str = self.asset
        kind = self.kind
        params = self.params or {}
        description = self.description
        severity = _severity(self.severity)
        schema = self.db_schema or "main"

        handler = _KIND_HANDLERS.get(kind)
        # asset_check's `asset=` param treats a plain string as ONE path
        # segment -- a slash-joined asset key like "models/stg_customers"
        # would become AssetKey(['models/stg_customers']), not the real
        # multi-segment AssetKey(['models', 'stg_customers']) dbt assets
        # actually have (see ResourceTypePrefixTranslator), so the check
        # would silently attach to nothing. Split it ourselves.
        target_asset_key = asset_key_from_string(asset_key_str)

        @dg.asset_check(
            asset=target_asset_key,
            name=check_name,
            description=description or f"{kind} check for {asset_key_str}",
        )
        def check_fn(context: dg.AssetCheckExecutionContext):
            if handler is None:
                return dg.AssetCheckResult(
                    passed=False,
                    severity=severity,
                    description=(
                        f"No implementation registered for check kind '{kind}'. "
                        f"Add one to _KIND_HANDLERS in "
                        f"dagster_designer_components/enhanced_asset_check.py."
                    ),
                )
            try:
                return handler(context, check_name, asset_key_str, schema, params, severity)
            except Exception as e:
                return dg.AssetCheckResult(
                    passed=False,
                    severity=severity,
                    description=f"Check '{check_name}' errored while evaluating: {e}",
                )

        return dg.Definitions(asset_checks=[check_fn])


CheckHandler = Callable[[dg.AssetCheckExecutionContext, str, str, str, dict, dg.AssetCheckSeverity], dg.AssetCheckResult]


def _check_freshness(context, check_name, asset_key_str, schema, params, severity):
    import time
    max_age_seconds = params.get("max_age_seconds")
    if max_age_seconds is None:
        raise ValueError("freshness requires params.max_age_seconds")
    ts = latest_materialization_timestamp(context, asset_key_from_string(asset_key_str))
    if ts is None:
        return dg.AssetCheckResult(passed=False, severity=severity, description=f"{asset_key_str} has never been materialized.")
    age = time.time() - ts
    return dg.AssetCheckResult(
        passed=age <= max_age_seconds,
        severity=severity,
        description=f"{asset_key_str} was last materialized {age:.0f}s ago (max {max_age_seconds}s).",
        metadata={"age_seconds": age, "max_age_seconds": max_age_seconds},
    )


def _check_row_count(context, check_name, asset_key_str, schema, params, severity):
    table = table_for_asset_key(asset_key_str, schema)
    row_count = int(scalar(f"SELECT COUNT(*) FROM {table}"))

    reasons = []
    passed = True
    min_rc, max_rc = params.get("min_row_count"), params.get("max_row_count")
    if min_rc is not None and row_count < min_rc:
        passed = False; reasons.append(f"below min {min_rc}")
    if max_rc is not None and row_count > max_rc:
        passed = False; reasons.append(f"above max {max_rc}")

    z_threshold = params.get("z_score_threshold")
    z = None
    if z_threshold is not None:
        prior_history = append_check_history(f"{check_name}__row_count", row_count)
        z = zscore(row_count, prior_history)
        if z is not None and abs(z) > z_threshold:
            passed = False; reasons.append(f"z-score {z:.2f} exceeds threshold {z_threshold} ({len(prior_history)} prior runs)")
    elif min_rc is None and max_rc is None:
        raise ValueError("row_count needs at least one of min_row_count, max_row_count, z_score_threshold")

    return dg.AssetCheckResult(
        passed=passed,
        severity=severity,
        description=f"{asset_key_str} has {row_count} rows." + (f" Failing: {', '.join(reasons)}." if reasons else ""),
        metadata={"row_count": row_count, **({"z_score": z} if z is not None else {})},
    )


def _check_null_ratio(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    max_ratio = params.get("max_null_ratio")
    if max_ratio is None:
        raise ValueError("null_ratio needs params.max_null_ratio")
    table = table_for_asset_key(asset_key_str, schema)
    total, nulls = one_row(f"SELECT COUNT(*) AS total, SUM(CASE WHEN {column} IS NULL THEN 1 ELSE 0 END) AS nulls FROM {table}")
    total, nulls = int(total), int(nulls or 0)
    ratio = (nulls / total) if total else 0.0
    return dg.AssetCheckResult(
        passed=ratio <= max_ratio,
        severity=severity,
        description=f"{asset_key_str}.{column} is {ratio:.1%} null ({nulls}/{total}), threshold {max_ratio:.1%}.",
        metadata={"null_ratio": ratio, "null_count": nulls, "total": total},
    )


def _check_uniqueness(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    table = table_for_asset_key(asset_key_str, schema)
    total, distinct_count = one_row(f"SELECT COUNT(*) AS total, COUNT(DISTINCT {column}) AS distinct_count FROM {table}")
    dupes = int(total) - int(distinct_count)
    return dg.AssetCheckResult(
        passed=dupes == 0,
        severity=severity,
        description=f"{asset_key_str}.{column}: {dupes} duplicate value(s) across {total} rows.",
        metadata={"duplicate_count": dupes, "total": int(total)},
    )


def _check_not_null(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    table = table_for_asset_key(asset_key_str, schema)
    null_count = int(scalar(f"SELECT COUNT(*) FROM {table} WHERE {column} IS NULL"))
    return dg.AssetCheckResult(
        passed=null_count == 0,
        severity=severity,
        description=f"{asset_key_str}.{column}: {null_count} null row(s).",
        metadata={"null_count": null_count},
    )


def _check_accepted_values(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    values = params.get("values") or []
    if not values:
        raise ValueError("accepted_values needs params.values")
    table = table_for_asset_key(asset_key_str, schema)
    placeholders = ", ".join("?" for _ in values)
    sql = f"SELECT COUNT(*) FROM {table} WHERE {column} IS NOT NULL AND {column} NOT IN ({placeholders})"
    bad_count = int(scalar(sql, list(values)))
    return dg.AssetCheckResult(
        passed=bad_count == 0,
        severity=severity,
        description=f"{asset_key_str}.{column}: {bad_count} row(s) outside accepted values {values}.",
        metadata={"violation_count": bad_count},
    )


def _check_accepted_range(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    min_value, max_value = params.get("min_value"), params.get("max_value")
    if min_value is None and max_value is None:
        raise ValueError("accepted_range needs min_value and/or max_value")
    table = table_for_asset_key(asset_key_str, schema)
    clauses, bind = [], []
    if min_value is not None:
        clauses.append(f"{column} < ?"); bind.append(min_value)
    if max_value is not None:
        clauses.append(f"{column} > ?"); bind.append(max_value)
    bad_count = int(scalar(f"SELECT COUNT(*) FROM {table} WHERE {' OR '.join(clauses)}", bind))
    return dg.AssetCheckResult(
        passed=bad_count == 0,
        severity=severity,
        description=f"{asset_key_str}.{column}: {bad_count} row(s) outside [{min_value}, {max_value}].",
        metadata={"violation_count": bad_count},
    )


def _check_regex_match(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    pattern = params.get("pattern")
    if not pattern:
        raise ValueError("regex_match needs params.pattern")
    compiled = re.compile(pattern)
    table = table_for_asset_key(asset_key_str, schema)
    rows = run_query(f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL LIMIT 100000")
    values = [r[0] for r in rows]
    bad = [v for v in values if not compiled.match(str(v))]
    return dg.AssetCheckResult(
        passed=len(bad) == 0,
        severity=severity,
        description=(
            f"{asset_key_str}.{column}: {len(bad)}/{len(values)} sampled value(s) don't match /{pattern}/"
            f"{' (capped at 100000 rows)' if len(values) == 100000 else ''}."
        ),
        metadata={"violation_count": len(bad), "sampled": len(values)},
    )


def _check_referential_integrity(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    to_asset = params.get("to_asset")
    to_column = _safe_ident(params.get("to_column", ""), "to_column")
    if not to_asset:
        raise ValueError("referential_integrity needs params.to_asset")
    table = table_for_asset_key(asset_key_str, schema)
    to_table = table_for_asset_key(to_asset, schema)
    sql = (
        f"SELECT COUNT(*) FROM {table} t LEFT JOIN {to_table} r "
        f"ON t.{column} = r.{to_column} "
        f"WHERE t.{column} IS NOT NULL AND r.{to_column} IS NULL"
    )
    orphans = int(scalar(sql))
    return dg.AssetCheckResult(
        passed=orphans == 0,
        severity=severity,
        description=f"{asset_key_str}.{column}: {orphans} value(s) not found in {to_asset}.{to_column}.",
        metadata={"orphan_count": orphans},
    )


def _check_duplicate_count(context, check_name, asset_key_str, schema, params, severity):
    columns = params.get("columns") or []
    if not columns:
        raise ValueError("duplicate_count needs params.columns")
    cols = [_safe_ident(c, "column") for c in columns]
    max_duplicates = params.get("max_duplicates", 0)
    table = table_for_asset_key(asset_key_str, schema)
    group_by = ", ".join(cols)
    sql = f"SELECT COUNT(*) FROM (SELECT {group_by} FROM {table} GROUP BY {group_by} HAVING COUNT(*) > 1) dupes"
    dup_groups = int(scalar(sql))
    return dg.AssetCheckResult(
        passed=dup_groups <= max_duplicates,
        severity=severity,
        description=f"{asset_key_str}: {dup_groups} duplicate-key group(s) on ({group_by}), threshold {max_duplicates}.",
        metadata={"duplicate_key_groups": dup_groups},
    )


def _check_zero_count(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    max_zeros = params.get("max_zeros", 0)
    table = table_for_asset_key(asset_key_str, schema)
    zero_count = int(scalar(f"SELECT COUNT(*) FROM {table} WHERE {column} = 0 OR {column} IS NULL"))
    return dg.AssetCheckResult(
        passed=zero_count <= max_zeros,
        severity=severity,
        description=f"{asset_key_str}.{column}: {zero_count} zero/null row(s), threshold {max_zeros}.",
        metadata={"zero_count": zero_count},
    )


def _check_sum_check(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    min_sum, max_sum = params.get("min_sum"), params.get("max_sum")
    if min_sum is None and max_sum is None:
        raise ValueError("sum_check needs min_sum and/or max_sum")
    table = table_for_asset_key(asset_key_str, schema)
    total = scalar(f"SELECT SUM({column}) FROM {table}")
    total = float(total) if total is not None else 0.0
    passed = True
    if min_sum is not None and total < min_sum: passed = False
    if max_sum is not None and total > max_sum: passed = False
    return dg.AssetCheckResult(
        passed=passed,
        severity=severity,
        description=f"{asset_key_str}: SUM({column}) = {total} (bounds [{min_sum}, {max_sum}]).",
        metadata={"sum": total},
    )


def _check_min_max_check(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    min_of_min, max_of_max = params.get("min_of_min"), params.get("max_of_max")
    table = table_for_asset_key(asset_key_str, schema)
    lo, hi = one_row(f"SELECT MIN({column}), MAX({column}) FROM {table}")
    lo, hi = (float(lo) if lo is not None else None), (float(hi) if hi is not None else None)
    passed = True
    if min_of_min is not None and (lo is None or lo < min_of_min): passed = False
    if max_of_max is not None and (hi is None or hi > max_of_max): passed = False
    return dg.AssetCheckResult(
        passed=passed,
        severity=severity,
        description=f"{asset_key_str}.{column}: min={lo}, max={hi} (allowed min>={min_of_min}, max<={max_of_max}).",
        metadata={"min": lo, "max": hi},
    )


def _check_stddev_check(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    max_stddev = params.get("max_stddev")
    if max_stddev is None:
        raise ValueError("stddev_check needs params.max_stddev")
    table = table_for_asset_key(asset_key_str, schema)
    stddev = scalar(f"SELECT STDDEV({column}) FROM {table}")
    stddev = float(stddev) if stddev is not None else 0.0
    return dg.AssetCheckResult(
        passed=stddev <= max_stddev,
        severity=severity,
        description=f"{asset_key_str}.{column}: stddev={stddev:.4f} (max {max_stddev}).",
        metadata={"stddev": stddev},
    )


def _check_quantile_check(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    quantile = params.get("quantile", 0.95)
    max_value = params.get("max_value")
    if max_value is None:
        raise ValueError("quantile_check needs params.max_value")
    table = table_for_asset_key(asset_key_str, schema)
    value = scalar(f"SELECT PERCENTILE_CONT({quantile}) WITHIN GROUP (ORDER BY {column}) FROM {table}")
    value = float(value) if value is not None else 0.0
    return dg.AssetCheckResult(
        passed=value <= max_value,
        severity=severity,
        description=f"{asset_key_str}.{column}: p{int(quantile*100)}={value:.4f} (max {max_value}).",
        metadata={"quantile_value": value, "quantile": quantile},
    )


def _check_mean_shift(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    max_delta_pct = params.get("max_delta_pct")
    if max_delta_pct is None:
        raise ValueError("mean_shift needs params.max_delta_pct")
    table = table_for_asset_key(asset_key_str, schema)
    current_mean = scalar(f"SELECT AVG({column}) FROM {table}")
    current_mean = float(current_mean) if current_mean is not None else 0.0

    prior_history = append_check_history(f"{check_name}__mean", current_mean)
    if not prior_history:
        return dg.AssetCheckResult(
            passed=True, severity=severity,
            description=f"{asset_key_str}.{column}: baseline mean {current_mean:.4f} recorded (first run, nothing to compare against yet).",
            metadata={"mean": current_mean},
        )
    baseline = sum(prior_history) / len(prior_history)
    delta_pct = abs(current_mean - baseline) / abs(baseline) * 100 if baseline else (0.0 if current_mean == 0 else float("inf"))
    return dg.AssetCheckResult(
        passed=delta_pct <= max_delta_pct,
        severity=severity,
        description=f"{asset_key_str}.{column}: mean {current_mean:.4f} vs baseline {baseline:.4f} ({delta_pct:.1f}% shift, max {max_delta_pct}%, {len(prior_history)} prior runs).",
        metadata={"mean": current_mean, "baseline_mean": baseline, "delta_pct": delta_pct},
    )


def _check_anomaly_detection(context, check_name, asset_key_str, schema, params, severity):
    metric = params.get("metric", "row_count")
    method = params.get("method", "zscore")
    threshold = params.get("threshold", 3.0)
    if metric != "row_count":
        raise ValueError(f"anomaly_detection only supports metric='row_count' today (got {metric!r}) -- use mean_shift/stddev_check for column-level metrics.")
    if method != "zscore":
        raise ValueError(f"anomaly_detection only supports method='zscore' today (got {method!r}).")
    table = table_for_asset_key(asset_key_str, schema)
    value = float(scalar(f"SELECT COUNT(*) FROM {table}"))
    prior_history = append_check_history(f"{check_name}__anomaly_{metric}", value)
    z = zscore(value, prior_history)
    if z is None:
        return dg.AssetCheckResult(
            passed=True, severity=severity,
            description=f"{asset_key_str}: {metric}={value:.0f} recorded ({len(prior_history)} prior run(s) -- need >= 2 to compute a z-score).",
            metadata={metric: value},
        )
    return dg.AssetCheckResult(
        passed=abs(z) <= threshold,
        severity=severity,
        description=f"{asset_key_str}: {metric}={value:.0f}, z-score={z:.2f} (threshold {threshold}, {len(prior_history)} prior runs).",
        metadata={metric: value, "z_score": z},
    )


def _check_distribution_drift(context, check_name, asset_key_str, schema, params, severity):
    column = _safe_ident(params.get("column", ""), "column")
    p_threshold = params.get("p_threshold", 0.05)
    table = table_for_asset_key(asset_key_str, schema)
    rows = run_query(f"SELECT {column} FROM {table} WHERE {column} IS NOT NULL LIMIT 2000")
    current_sample = [float(r[0]) for r in rows]

    state_key = f"{check_name}__drift_{column}"
    baseline = read_check_sample(state_key)
    if not baseline:
        write_check_sample(state_key, current_sample)
        return dg.AssetCheckResult(
            passed=True, severity=severity,
            description=f"{asset_key_str}.{column}: baseline sample recorded ({len(current_sample)} values, first run -- nothing to compare against yet).",
            metadata={"sample_size": len(current_sample)},
        )
    d = ks_statistic(current_sample, baseline)
    if d is None:
        return dg.AssetCheckResult(passed=True, severity=severity, description="Not enough data to compare distributions.")
    p = ks_pvalue(d, len(current_sample), len(baseline))
    # A refreshed baseline over time keeps this comparing against a
    # recent reference rather than one frozen forever, without needing a
    # separate window counter -- each check that PASSES nudges the
    # baseline toward the current sample.
    if p >= p_threshold:
        write_check_sample(state_key, current_sample)
    return dg.AssetCheckResult(
        passed=p >= p_threshold,
        severity=severity,
        description=f"{asset_key_str}.{column}: KS D={d:.4f}, p={p:.4f} (threshold {p_threshold}) vs a {len(baseline)}-value baseline.",
        metadata={"ks_statistic": d, "p_value": p, "baseline_size": len(baseline), "sample_size": len(current_sample)},
    )


def _check_schema_change(context, check_name, asset_key_str, schema, params, severity):
    table = table_for_asset_key(asset_key_str, schema)
    table_name = table.split(".")[-1]
    live_columns = columns_for_table(schema, table_name)

    from ._check_helpers import _state_dir
    import json
    state_path = _state_dir() / f"{check_name}__schema.json"
    prior = {}
    if state_path.exists():
        try:
            prior = json.loads(state_path.read_text())
        except (json.JSONDecodeError, OSError):
            prior = {}

    fail_on = set(params.get("fail_on") or ["column_added", "column_removed", "type_changed"])
    added = sorted(set(live_columns) - set(prior))
    removed = sorted(set(prior) - set(live_columns))
    changed = sorted(c for c in (set(live_columns) & set(prior)) if live_columns[c] != prior[c])

    try:
        state_path.write_text(json.dumps(live_columns))
    except OSError:
        pass

    if not prior:
        return dg.AssetCheckResult(
            passed=True, severity=severity,
            description=f"{asset_key_str}: schema snapshot recorded ({len(live_columns)} columns, first run).",
            metadata={"columns": sorted(live_columns)},
        )

    violations = []
    if added and "column_added" in fail_on: violations.append(f"added: {added}")
    if removed and "column_removed" in fail_on: violations.append(f"removed: {removed}")
    if changed and "type_changed" in fail_on: violations.append(f"type changed: {changed}")

    return dg.AssetCheckResult(
        passed=len(violations) == 0,
        severity=severity,
        description=f"{asset_key_str}: schema vs prior snapshot -- " + ("; ".join(violations) if violations else "no watched changes."),
        metadata={"added": added, "removed": removed, "type_changed": changed},
    )


def _check_custom(context, check_name, asset_key_str, schema, params, severity):
    sql = params.get("sql")
    python_code = params.get("python")
    if not sql and not python_code:
        raise ValueError("custom needs params.sql or params.python")

    if sql:
        # dbt-style {{ ref('name') }} -> the same asset-key-to-table
        # resolution every other check kind uses, so custom SQL composes
        # with the rest of the project the same way a dbt test would.
        rendered = re.sub(
            r"\{\{\s*ref\(['\"]([^'\"]+)['\"]\)\s*\}\}",
            lambda m: table_for_asset_key(m.group(1), schema),
            sql,
        )
        rows = run_query(rendered)
        return dg.AssetCheckResult(
            passed=len(rows) == 0,
            severity=severity,
            description=f"Custom SQL check '{check_name}': {len(rows)} failing row(s).",
            metadata={"failing_rows": len(rows)},
        )

    table = table_for_asset_key(asset_key_str, schema)
    df = query_df(f"SELECT * FROM {table}")
    func_body = "\n".join(f"    {line}" for line in python_code.splitlines())
    namespace: dict[str, Any] = {}
    exec(f"def _custom_check(df):\n{func_body}\n", namespace)
    result = namespace["_custom_check"](df)
    passed = bool(result)
    return dg.AssetCheckResult(
        passed=passed,
        severity=severity,
        description=f"Custom Python check '{check_name}' returned {result!r}.",
    )


_KIND_HANDLERS: dict[str, CheckHandler] = {
    "freshness": _check_freshness,
    "row_count": _check_row_count,
    "null_ratio": _check_null_ratio,
    "uniqueness": _check_uniqueness,
    "not_null": _check_not_null,
    "accepted_values": _check_accepted_values,
    "accepted_range": _check_accepted_range,
    "regex_match": _check_regex_match,
    "referential_integrity": _check_referential_integrity,
    "duplicate_count": _check_duplicate_count,
    "zero_count": _check_zero_count,
    "sum_check": _check_sum_check,
    "min_max_check": _check_min_max_check,
    "stddev_check": _check_stddev_check,
    "quantile_check": _check_quantile_check,
    "mean_shift": _check_mean_shift,
    "anomaly_detection": _check_anomaly_detection,
    "distribution_drift": _check_distribution_drift,
    "schema_change": _check_schema_change,
    "custom": _check_custom,
}
