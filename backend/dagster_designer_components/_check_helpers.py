"""Shared helpers for AssetCheckComponent and EnhancedAssetCheckComponent.

Two families of data an asset check can pull real signal from without any
per-check configuration burden:

  1. The Dagster instance's own event log -- every asset already has a
     materialization timestamp, and IO managers that log metadata (row
     count, table schema, ...) make that queryable too. Works for ANY
     asset regardless of storage backend.
  2. The project's warehouse, queried directly -- for the common
     dbt-duckdb case (this app's dominant project shape) via the `duckdb`
     driver directly, since it's already a transitive dependency of
     dbt-duckdb and needs no extra install. SqlAlchemy + a dialect driver
     (e.g. duckdb-engine, psycopg2, snowflake-sqlalchemy) is only pulled
     in for non-DuckDB adapters, and isn't installed in every project by
     default -- checks against those adapters fail with a clear message
     telling the user what to add, rather than an opaque import error.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional

import dagster as dg


def latest_materialization_metadata(context: dg.AssetCheckExecutionContext, asset_key: dg.AssetKey) -> dict[str, Any]:
    """Metadata dict logged on the asset's most recent materialization,
    unwrapped from MetadataValue to raw Python values. Empty dict if the
    asset has never been materialized."""
    result = context.instance.fetch_materializations(asset_key, limit=1)
    if not result.records:
        return {}
    materialization = result.records[0].asset_materialization
    if materialization is None:
        return {}
    return {k: v.value for k, v in (materialization.metadata or {}).items()}


def latest_materialization_timestamp(context: dg.AssetCheckExecutionContext, asset_key: dg.AssetKey) -> Optional[float]:
    """Unix timestamp of the asset's most recent materialization, or None
    if it's never been materialized."""
    result = context.instance.fetch_materializations(asset_key, limit=1)
    if not result.records:
        return None
    return result.records[0].timestamp


def asset_key_from_string(asset_name: str) -> dg.AssetKey:
    """Split a slash-joined asset key string into a proper multi-segment
    AssetKey. Passing the raw string straight to dg.AssetKey(...) or to
    @asset_check's `asset=` param treats it as ONE path segment
    (AssetKey(['models/stg_customers'])), not the real
    AssetKey(['models', 'stg_customers']) dbt assets actually have (see
    ResourceTypePrefixTranslator) -- a check built that way silently
    never attaches to the asset it's supposed to be checking."""
    return dg.AssetKey([seg for seg in asset_name.split("/") if seg])


def table_for_asset_key(asset_key: str, schema: str = "main") -> str:
    """Map a Dagster asset key to a queryable `schema.table` identifier.

    This project's dbt translator (ResourceTypePrefixTranslator) prefixes
    asset keys with their dbt resource type (models/sources/seeds/...),
    so the actual table name is the LAST segment -- e.g. asset key
    "models/stg_customers" -> table "stg_customers". Matches
    SqlTransformerComponent's own `output_schema` default of "main"
    (dbt-duckdb's default schema)."""
    name = asset_key.replace("/", ".").split(".")[-1]
    return f"{schema}.{name}"


# ---------------------------------------------------------------------------
# Warehouse connection + query execution. All check handlers go through
# run_query()/scalar()/one_row() with `?` positional placeholders so the
# duckdb-vs-sqlalchemy split lives in exactly one place.
# ---------------------------------------------------------------------------

def _find_dbt_profiles_yaml() -> Optional[Path]:
    cwd = Path(os.getcwd())
    for root in [cwd, *cwd.parents[:3]]:
        for p in root.glob("**/profiles.yml"):
            if any(part in {".venv", "node_modules", "__pycache__", ".dbt"} for part in p.parts):
                continue
            return p
    return None


def _resolve_connection() -> tuple[str, Any]:
    """Returns ('duckdb', <db path str>) or ('sqlalchemy', <Engine>).

    DuckDB is resolved directly (no sqlalchemy dependency needed -- just
    the `duckdb` package, already required by dbt-duckdb). Anything else
    found in profiles.yml, or no profiles.yml at all, falls back to
    SqlTransformerComponent's own connection resolution (Dagster
    resource / connection_url / connection_url_env_var), which DOES
    require sqlalchemy + a dialect driver to be installed."""
    import yaml

    profiles_yaml = _find_dbt_profiles_yaml()
    if profiles_yaml:
        try:
            parsed = yaml.safe_load(profiles_yaml.read_text()) or {}
        except Exception:
            parsed = {}
        for _name, profile in parsed.items():
            if not isinstance(profile, dict):
                continue
            target = profile.get("target", "dev")
            outputs = profile.get("outputs") or {}
            out = outputs.get(target) or (next(iter(outputs.values()), None) if outputs else None)
            if not isinstance(out, dict):
                continue
            if (out.get("type") or "").lower() == "duckdb":
                path = out.get("path") or ":memory:"
                if path == ":memory:":
                    return ("duckdb", ":memory:")
                resolved = Path(path)
                if not resolved.is_absolute():
                    resolved = (Path(os.getcwd()) / path).resolve()
                if not resolved.exists():
                    alt = (profiles_yaml.parent / path).resolve()
                    if alt.exists():
                        resolved = alt
                return ("duckdb", str(resolved))
            break  # non-duckdb adapter in profiles.yml -- fall through below

    from .sql_transformer import _resolve_engine
    return ("sqlalchemy", _resolve_engine({}, None))


def run_query(sql: str, params: Optional[list] = None) -> list[tuple]:
    """Execute `sql` (with `?` positional placeholders) and return all
    rows. Retries a locked DuckDB file a few times before giving up --
    read-only connects fail immediately (no built-in wait) if another
    process, e.g. a run that just finished materializing, still has the
    file open."""
    params = params or []
    kind, target = _resolve_connection()

    if kind == "duckdb":
        import duckdb
        last_err: Optional[Exception] = None
        for attempt in range(5):
            try:
                con = duckdb.connect(target, read_only=(target != ":memory:"))
                try:
                    return con.execute(sql, params).fetchall()
                finally:
                    con.close()
            except duckdb.Error as e:
                last_err = e
                time.sleep(0.4 * (attempt + 1))
        raise RuntimeError(f"Could not open DuckDB database at {target} (still locked after retries): {last_err}")

    from sqlalchemy import text
    pnames = [f"p{i}" for i in range(len(params))]
    rendered = sql
    for pname in pnames:
        rendered = rendered.replace("?", f":{pname}", 1)
    bind = dict(zip(pnames, params))
    with target.connect() as conn:
        return [tuple(row) for row in conn.execute(text(rendered), bind)]


def scalar(sql: str, params: Optional[list] = None) -> Any:
    rows = run_query(sql, params)
    return rows[0][0] if rows else None


def one_row(sql: str, params: Optional[list] = None) -> tuple:
    rows = run_query(sql, params)
    if not rows:
        raise RuntimeError("Query returned no rows")
    return rows[0]


def query_df(sql: str):
    """Same query execution, returned as a pandas DataFrame -- for the
    custom-Python check kind, which hands the user a DataFrame."""
    import pandas as pd
    kind, target = _resolve_connection()
    if kind == "duckdb":
        import duckdb
        last_err: Optional[Exception] = None
        for attempt in range(5):
            try:
                con = duckdb.connect(target, read_only=(target != ":memory:"))
                try:
                    return con.execute(sql).df()
                finally:
                    con.close()
            except duckdb.Error as e:
                last_err = e
                time.sleep(0.4 * (attempt + 1))
        raise RuntimeError(f"Could not open DuckDB database at {target} (still locked after retries): {last_err}")
    return pd.read_sql(sql, target)


def columns_for_table(schema: str, table: str) -> dict[str, str]:
    """{column_name: data_type} via the ANSI-standard information_schema
    view -- works across DuckDB/Postgres/Snowflake without needing
    sqlalchemy's dialect-specific inspection."""
    rows = run_query(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_schema = ? AND table_name = ?",
        [schema, table],
    )
    return {name: dtype for name, dtype in rows}


# ---------------------------------------------------------------------------
# Rolling local state -- for checks that compare the current run's computed
# value against the check's OWN history (row-count z-score, mean shift,
# distribution drift, ...). There's no external metrics store here, so we
# keep a small per-check JSON file of past computed values and grow it each
# run. Real history, not synthetic -- it just needs a few runs to "warm up"
# before there's enough data to judge an anomaly against, same as any
# baseline-relative check would.
# ---------------------------------------------------------------------------

def _state_dir() -> Path:
    # Walk up from cwd (Dagster sets cwd to the project root when loading
    # defs) looking for a pyproject.toml, same convention
    # _derive_url_from_dbt_profile in sql_transformer.py uses for finding
    # the project root reliably regardless of where load actually starts.
    cwd = Path(os.getcwd())
    root = cwd
    for candidate in [cwd, *cwd.parents[:4]]:
        if (candidate / "pyproject.toml").exists():
            root = candidate
            break
    d = root / ".designer_check_state"
    d.mkdir(exist_ok=True)
    return d


def read_check_history(check_name: str) -> list[float]:
    path = _state_dir() / f"{check_name}.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        return [float(v) for v in data.get("history", [])]
    except (json.JSONDecodeError, TypeError, ValueError, OSError):
        return []


def append_check_history(check_name: str, value: float, max_len: int = 200) -> list[float]:
    """Append `value` to the check's history and persist it. Returns the
    history as it was BEFORE this value was appended, so callers can
    compare the new point against prior history without it skewing its
    own baseline."""
    path = _state_dir() / f"{check_name}.json"
    prior = read_check_history(check_name)
    updated = (prior + [value])[-max_len:]
    try:
        path.write_text(json.dumps({"history": updated}))
    except OSError:
        pass
    return prior


def read_check_sample(check_name: str) -> list[float]:
    """A stored baseline SAMPLE (raw values, not aggregates) for
    distribution-shaped comparisons like distribution_drift. Separate
    file from the scalar history above since it holds many more values
    per entry."""
    path = _state_dir() / f"{check_name}.sample.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        return [float(v) for v in data.get("sample", [])]
    except (json.JSONDecodeError, TypeError, ValueError, OSError):
        return []


def write_check_sample(check_name: str, sample: list[float], max_len: int = 2000) -> None:
    path = _state_dir() / f"{check_name}.sample.json"
    try:
        path.write_text(json.dumps({"sample": sample[:max_len]}))
    except OSError:
        pass


def zscore(value: float, history: list[float]) -> Optional[float]:
    """Z-score of `value` against `history` (population stddev). None if
    there isn't enough history yet (need >= 2 points for a meaningful
    stddev) or history is degenerate (zero variance)."""
    n = len(history)
    if n < 2:
        return None
    mean = sum(history) / n
    variance = sum((x - mean) ** 2 for x in history) / n
    stddev = variance ** 0.5
    if stddev == 0:
        return None
    return (value - mean) / stddev


def ks_statistic(sample_a: list[float], sample_b: list[float]) -> Optional[float]:
    """Two-sample Kolmogorov-Smirnov statistic (max distance between
    empirical CDFs) computed in pure Python -- no scipy dependency, since
    we can't assume it's installed in every project's venv. Standard
    definition: max over all values x of |F_a(x) - F_b(x)|, which only
    needs to be evaluated at the union of both samples' values."""
    if not sample_a or not sample_b:
        return None
    a = sorted(sample_a)
    b = sorted(sample_b)
    na, nb = len(a), len(b)

    def cdf_at(sorted_vals: list[float], n: int, x: float) -> float:
        import bisect
        return bisect.bisect_right(sorted_vals, x) / n

    max_diff = 0.0
    for x in sorted(set(a) | set(b)):
        diff = abs(cdf_at(a, na, x) - cdf_at(b, nb, x))
        if diff > max_diff:
            max_diff = diff
    return max_diff


def ks_pvalue(d: float, na: int, nb: int) -> float:
    """Asymptotic p-value for a two-sample KS statistic `d` (Marsaglia/
    Kolmogorov approximation) -- the standard closed-form used when scipy
    isn't available. Effective sample size n_e = na*nb/(na+nb);
    lambda = (sqrt(n_e) + 0.12 + 0.11/sqrt(n_e)) * d; p ≈ 2 * sum_{k=1..100}
    (-1)^(k-1) * exp(-2 k^2 lambda^2), clamped to [0, 1]."""
    if na == 0 or nb == 0:
        return 1.0
    n_e = na * nb / (na + nb)
    lam = (n_e ** 0.5 + 0.12 + 0.11 / (n_e ** 0.5)) * d
    if lam < 0.2:
        return 1.0
    total = 0.0
    for k in range(1, 101):
        term = (-1) ** (k - 1) * (2.718281828459045 ** (-2 * (k ** 2) * (lam ** 2)))
        total += term
    p = max(0.0, min(1.0, 2 * total))
    return p
