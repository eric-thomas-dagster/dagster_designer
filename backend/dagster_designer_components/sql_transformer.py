"""SqlTransformerComponent — in-warehouse counterpart to DataFrameTransformerComponent.

Driven by the same visual-builder config shape as the DataFrame version:
columns_to_keep / drop / rename, filter_expression, sort_by, drop_duplicates,
limit_rows, and simple SQL-safe calculated columns. Uses SQLAlchemy Core to
build queries so a single expression compiles to the right dialect for every
adapter SQLAlchemy knows about (Postgres, Snowflake, BigQuery, DuckDB,
Redshift, MSSQL, Oracle, and community dialects for MotherDuck/Databricks/…).

Connection resolution — first strategy that succeeds wins:
  1. Explicit `connection_url` (SQLAlchemy URL) — highest precedence.
  2. `connection_url_env_var` — read at execute time so credentials aren't
     baked into defs.yaml.
  3. `dbt profile fallback` — when the project has a `profiles.yml` and no
     other connection is configured, derive the URL the same way dbt does.
     Currently handles the common `duckdb` adapter (Jaffle Shop). Other
     adapters raise a clear error asking the user to set connection_url.
"""

from __future__ import annotations

import json
import os
import string as _string_module
from pathlib import Path
from typing import Any, Optional

# Regex character class matching Python's string.punctuation exactly (same
# set the DataFrame backend's str.translate call strips) -- built
# programmatically rather than hand-escaped, since a literal containing a
# backtick, single quote, backslash, and both bracket characters is exactly
# the kind of string that's easy to get subtly wrong by hand. `]` goes
# first, `-` goes last, `\` is regex-escaped as `\\` -- the three
# characters that have positional/escaping rules inside a `[...]` class;
# everything else in string.punctuation is literal there, including a bare
# `[` and `^` (only special as the very first character, which it isn't
# here).
_SQL_PUNCTUATION_CLASS = (
    "[]"
    + "".join(c for c in _string_module.punctuation if c not in ("]", "-", "\\"))
    + "\\\\-]"
)

import dagster as dg


class SqlTransformerComponent(dg.Component, dg.Model, dg.Resolvable):
    """Apply visual-builder transformations against a warehouse table using SQL.

    Two source shapes, mutually exclusive -- set exactly one:
      1. `upstream_table` (+ optionally `upstream_asset_keys` for real Dagster
         lineage): reads a dbt model output, a sink component output, or any
         other warehouse table already declared as a Dagster asset.
      2. `source_sql`: a raw SQL query defining the source relation directly
         against a resource/connection (no existing Dagster asset needed --
         same "start from a resource or a bare connection string" pattern as
         context_engineering_pipeline's `source: {kind: warehouse_query}`).
         Becomes a root asset with no upstream Dagster dependency.

    Either way, everything stays in the warehouse -- no data movement --
    which is the whole point vs the DataFrame path.
    """

    asset_name: str
    upstream_asset_keys: Optional[str] = None  # comma-separated
    upstream_table: Optional[str] = None  # SQL identifier for the source, e.g. "main.stg_customers"
    source_sql: Optional[str] = None  # raw query defining the source relation, instead of upstream_table
    output_schema: str = "main"

    # Connection — try in order:
    #   1. Dagster resource_key (highest precedence — proper Dagster pattern,
    #      inherits deployment-specific credentials from resources.py; works
    #      with SnowflakeResource, DuckDBResource, custom SQLAlchemy engines,
    #      or any object exposing get_sqlalchemy_engine() / get_connection()).
    #   2. Explicit connection_url (e.g. postgresql+psycopg2://user:pw@host/db).
    #   3. Environment variable holding the URL (secret-friendly).
    #   4. dbt profiles.yml derivation — walks up the filesystem to find one.
    resource_key: Optional[str] = None
    connection_url: Optional[str] = None
    connection_url_env_var: Optional[str] = None

    # Visual-builder ops (same names/semantics as DataFrameTransformerComponent
    # so the frontend save flow doesn't need to know which backend it's
    # writing).
    columns_to_keep: Optional[str] = None  # comma-separated
    columns_to_drop: Optional[str] = None  # comma-separated
    rename_columns: Optional[str] = None   # JSON dict: {"old": "new"}
    filter_expression: Optional[str] = None  # a SQL WHERE clause
    sort_by: Optional[str] = None  # comma-separated
    sort_ascending: bool = True
    drop_duplicates: bool = False
    limit_rows: Optional[int] = None
    calculated_columns: Optional[str] = None  # JSON dict: {"new_col": "SQL expr"}
    # JSON list: [{"column", "find", "replace"}]  — REPLACE(col, find, replace).
    replace_ops: Optional[str] = None
    # JSON list: [{"column", "delimiter", "into"}] — dialect-specific split.
    # We emit SPLIT_PART for the common adapters; some dialects need custom
    # handling and will fall back to a per-index expression per new column.
    split_ops: Optional[str] = None
    # JSON list: [{"kind", "orderBy", "partitionBy", "orderAsc", "into"}]
    # kind ∈ {rank, dense_rank, row_number}. Compiles to a window function.
    window_ops: Optional[str] = None
    # JSON list: [{"column", "operator", "value", "into", "partitionBy"}]
    # Emits COUNT(CASE WHEN … END) OVER (PARTITION BY …) so the count is
    # scoped per-partition (or global when no partition).
    count_match_ops: Optional[str] = None
    # JSON list: [{"branches":[{column,operator,value,then}], "else", "into"}]
    # Compiles to CASE WHEN cond1 THEN t1 WHEN cond2 THEN t2 ELSE e END.
    case_when_ops: Optional[str] = None
    # JSON list: [{"columns" (csv), "separator", "into"}] — CONCAT with sep.
    concat_ops: Optional[str] = None
    # JSON list: [{"column", "part", "into"}] — EXTRACT(part FROM col).
    date_extract_ops: Optional[str] = None
    # JSON list: [{"column", "start" (1-based), "length"|null, "into"}].
    substring_ops: Optional[str] = None
    # JSON list: [{"column", "op": round|floor|ceil|abs, "digits", "into"}].
    numeric_ops: Optional[str] = None
    # JSON: {"n" | "fraction", "random"} — TABLESAMPLE on supported dialects.
    sample_config: Optional[str] = None
    # JSON list: [{"column", "boundaries" (csv), "labels" (csv), "into"}]
    bin_ops: Optional[str] = None
    # JSON: {"subsetCols" (csv), "keep": first|last}
    dedupe_subset: Optional[str] = None
    # JSON list: [{"column", "partitionBy", "orderBy", "orderAsc", "into"}]
    cumsum_ops: Optional[str] = None
    # JSON list: [{"column", "direction": ffill|bfill, "partitionBy", "orderBy"}]
    fill_direction_ops: Optional[str] = None
    # comma-separated columns to GROUP BY. When set, the SELECT list becomes
    # ONLY the group_by columns + agg_functions expressions -- every other
    # column-projection option (columns_to_keep/drop, calculated_columns,
    # etc.) is ignored for this query, same as pandas' groupby().agg()
    # collapsing every non-grouped/non-aggregated column.
    group_by: Optional[str] = None
    # JSON dict: {"column": "function"}. function in
    # {sum, count, count_distinct, avg, mean, min, max, std, stddev}.
    # Output column is named "<function>_<column>" (e.g. "sum_amount"),
    # matching the same convention the DataFrame backend's pandas
    # groupby().agg() produces.
    agg_functions: Optional[str] = None
    # Drop rows where any of columns_to_keep (or, if unset, every column
    # referenced elsewhere in this query) is NULL. Full "drop row if ANY
    # column across the whole table is null" isn't expressible without
    # reflecting the table's full schema (which this component deliberately
    # avoids -- see module docstring); this is the honest subset that's
    # actually knowable at compile time.
    drop_na: bool = False
    # JSON list: [{"column", "operation"}]. operation in
    # {upper, lower, title, trim}. Applied in place (same column name),
    # matching the DataFrame backend's str.upper()/.lower()/.title()/.strip().
    string_operations: Optional[str] = None

    group_name: Optional[str] = None
    description: Optional[str] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        if bool(self.upstream_table) == bool(self.source_sql):
            raise ValueError(
                "SqlTransformerComponent: set exactly one of `upstream_table` "
                "(reads an existing Dagster asset's table) or `source_sql` "
                "(a raw query against a resource/connection, no existing "
                "asset needed)."
            )

        upstream_keys = [
            dg.AssetKey.from_user_string(k.strip())
            for k in (self.upstream_asset_keys or '').split(',')
            if k.strip()
        ]

        # Snapshot config into locals — self isn't safe to close over inside
        # the asset function.
        cfg = self._snapshot()

        # Declare required_resource_keys ONLY when the user has explicitly
        # set resource_key — otherwise Dagster errors "resource key X required
        # but not provided" at build time. When unset we fall back to
        # connection_url / env var / dbt profile.
        asset_kwargs: dict[str, Any] = dict(
            name=self.asset_name,
            deps=upstream_keys,
            group_name=self.group_name,
            description=self.description,
            compute_kind="sql",
        )
        if self.resource_key:
            asset_kwargs["required_resource_keys"] = {self.resource_key}

        @dg.asset(**asset_kwargs)
        # NB: parameter MUST be named `context` — Dagster treats any other
        # first-arg name as an upstream asset dep. Type annotation is left
        # blank because Dagster's decorator inspection rejects
        # `dg.AssetExecutionContext` (module-attribute form) — only the
        # bare class name or no annotation are accepted.
        def _sql_transform(context):
            engine = _resolve_engine(cfg, context)
            select_sql = _build_select_sql(cfg, engine.dialect.name)
            create_sql = (
                f'CREATE OR REPLACE TABLE "{cfg["output_schema"]}"."{cfg["asset_name"]}" AS\n'
                f'{select_sql}'
            )
            context.log.info(
                f"[SqlTransformer] Materializing {cfg['output_schema']}.{cfg['asset_name']}"
            )
            context.log.info(f"[SqlTransformer] Dialect: {engine.dialect.name}")
            context.log.info(f"[SqlTransformer] SQL:\n{create_sql}")
            with engine.begin() as conn:
                from sqlalchemy import text  # local import — sqlalchemy is a soft dep
                conn.execute(text(create_sql))
                # Return a row count so the run log has something concrete.
                count = conn.execute(
                    text(f'SELECT COUNT(*) FROM "{cfg["output_schema"]}"."{cfg["asset_name"]}"')
                ).scalar()
                context.add_output_metadata({"row_count": int(count) if count is not None else 0})
            return None

        return dg.Definitions(assets=[_sql_transform])

    def _snapshot(self) -> dict[str, Any]:
        return {
            "asset_name": self.asset_name,
            "upstream_asset_keys": self.upstream_asset_keys,
            "upstream_table": self.upstream_table,
            "source_sql": self.source_sql,
            "output_schema": self.output_schema,
            "resource_key": self.resource_key,
            "connection_url": self.connection_url,
            "connection_url_env_var": self.connection_url_env_var,
            "columns_to_keep": self.columns_to_keep,
            "columns_to_drop": self.columns_to_drop,
            "rename_columns": self.rename_columns,
            "filter_expression": self.filter_expression,
            "sort_by": self.sort_by,
            "sort_ascending": self.sort_ascending,
            "drop_duplicates": self.drop_duplicates,
            "limit_rows": self.limit_rows,
            "calculated_columns": self.calculated_columns,
            "replace_ops": self.replace_ops,
            "split_ops": self.split_ops,
            "window_ops": self.window_ops,
            "count_match_ops": self.count_match_ops,
            "case_when_ops": self.case_when_ops,
            "concat_ops": self.concat_ops,
            "date_extract_ops": self.date_extract_ops,
            "substring_ops": self.substring_ops,
            "numeric_ops": self.numeric_ops,
            "sample_config": self.sample_config,
            "bin_ops": self.bin_ops,
            "dedupe_subset": self.dedupe_subset,
            "cumsum_ops": self.cumsum_ops,
            "fill_direction_ops": self.fill_direction_ops,
            "group_by": self.group_by,
            "agg_functions": self.agg_functions,
            "drop_na": self.drop_na,
            "string_operations": self.string_operations,
        }


def _resolve_engine(cfg: dict[str, Any], context=None):
    """Return a SQLAlchemy Engine. Tries in order:
      1. Dagster resource (context.resources.<resource_key>) — proper Dagster
         pattern; duck-typed against SnowflakeResource, DuckDBResource, any
         object with get_sqlalchemy_engine() / get_connection(), or the shape
         of a connection config.
      2. Explicit `connection_url` (SQLAlchemy URL).
      3. `connection_url_env_var` — read at execute time.
      4. dbt profiles.yml derivation.
    Raises with a clear message on failure."""
    from sqlalchemy import create_engine

    resource_key = cfg.get("resource_key")
    if resource_key and context is not None:
        try:
            resource = getattr(context.resources, resource_key)
        except AttributeError:
            raise RuntimeError(
                f"resource_key '{resource_key}' is set on the SqlTransformer, "
                f"but no such resource is available on context.resources. "
                f"Add it to the project's Definitions (resources.py) or clear "
                f"resource_key to fall back to connection_url."
            )
        engine = _engine_from_resource(resource)
        if engine is not None:
            return engine
        raise RuntimeError(
            f"Could not build a SQLAlchemy Engine from resource '{resource_key}' "
            f"(type={type(resource).__name__}). The resource must expose one of: "
            f"get_sqlalchemy_engine(), get_connection() returning a connection, "
            f"or a SqlAlchemy-URL-compatible attribute set "
            f"(account/user/password for Snowflake; host/port/user/password/database "
            f"for Postgres; database for DuckDB)."
        )

    url = cfg.get("connection_url")
    if not url and cfg.get("connection_url_env_var"):
        url = os.environ.get(cfg["connection_url_env_var"])
        if not url:
            raise RuntimeError(
                f"connection_url_env_var '{cfg['connection_url_env_var']}' is not set. "
                f"Configure the environment variable or set connection_url directly."
            )
    if not url:
        url = _derive_url_from_dbt_profile()
    if not url:
        raise RuntimeError(
            "SqlTransformerComponent could not resolve a database connection. "
            "Set resource_key, connection_url, connection_url_env_var, or ensure a "
            "dbt profiles.yml is present in the project."
        )
    return create_engine(url)


def _engine_from_resource(resource: Any):
    """Duck-type a Dagster resource into a SQLAlchemy Engine.

    Order matters — try richest interfaces first so we don't reconstruct URLs
    when the resource already knows how to hand out an engine.
    """
    from sqlalchemy import create_engine

    # 1. Prefer any explicit engine accessor the resource exposes.
    for meth in ("get_sqlalchemy_engine", "sqlalchemy_engine", "get_engine"):
        fn = getattr(resource, meth, None)
        if callable(fn):
            try:
                eng = fn()
                if eng is not None:
                    return eng
            except Exception:
                pass  # fall through and try other strategies

    # 2. Snowflake-shaped resource → snowflake:// URL.
    account = getattr(resource, "account", None)
    if account:
        user = getattr(resource, "user", "") or ""
        password = getattr(resource, "password", "") or ""
        database = getattr(resource, "database", "") or ""
        schema = getattr(resource, "schema_", None) or getattr(resource, "schema", "") or ""
        warehouse = getattr(resource, "warehouse", "") or ""
        role = getattr(resource, "role", "") or ""
        url = f"snowflake://{user}:{password}@{account}/{database}"
        if schema:
            url += f"/{schema}"
        params = []
        if warehouse:
            params.append(f"warehouse={warehouse}")
        if role:
            params.append(f"role={role}")
        if params:
            url += "?" + "&".join(params)
        return create_engine(url)

    # 3. Postgres-shaped resource → postgresql+psycopg2:// URL.
    host = getattr(resource, "host", None)
    if host and getattr(resource, "database", None):
        user = getattr(resource, "user", "") or getattr(resource, "username", "") or ""
        password = getattr(resource, "password", "") or ""
        port = getattr(resource, "port", 5432) or 5432
        db = getattr(resource, "database", "") or getattr(resource, "dbname", "") or ""
        return create_engine(f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{db}")

    # 4. DuckDB-shaped resource → duckdb:/// URL.
    database = getattr(resource, "database", None)
    if database and not host:
        return create_engine(f"duckdb:///{database}")

    return None


def _derive_url_from_dbt_profile() -> Optional[str]:
    """Look for a dbt profiles.yml near cwd and translate its target into a
    SQLAlchemy URL. Only handles adapters that are trivially mappable today
    — expand this dict as new dialects are needed."""
    import yaml

    cwd = Path(os.getcwd())
    profiles_yaml = None
    for root in [cwd, *cwd.parents[:3]]:
        for p in root.glob("**/profiles.yml"):
            if any(part in {".venv", "node_modules", "__pycache__", ".dbt"} for part in p.parts):
                continue
            profiles_yaml = p
            break
        if profiles_yaml:
            break
    if not profiles_yaml:
        return None

    try:
        parsed = yaml.safe_load(profiles_yaml.read_text()) or {}
    except Exception:
        return None

    # profiles.yml top-level: profile_name → {target: 'dev', outputs: {dev: {...}}}
    # Take the first profile's active target.
    for _profile_name, profile in parsed.items():
        if not isinstance(profile, dict):
            continue
        target = profile.get('target', 'dev')
        outputs = profile.get('outputs') or {}
        out = outputs.get(target) or (next(iter(outputs.values()), None) if outputs else None)
        if not isinstance(out, dict):
            continue
        adapter = (out.get('type') or '').lower()

        if adapter == 'duckdb':
            path = out.get('path') or ':memory:'
            # dbt-duckdb resolves `path` relative to CWD (the directory dbt
            # was invoked from), not to the profiles.yml file. In a Dagster
            # asset execution CWD is the project's launch dir, which is the
            # same place dbt runs from — so this matches.
            if path == ':memory:':
                return "duckdb:///:memory:"
            resolved = Path(path)
            if not resolved.is_absolute():
                resolved = (Path(os.getcwd()) / path).resolve()
            # Fallback: some setups use profile-dir-relative paths. Try that
            # if the CWD-relative one doesn't exist.
            if not resolved.exists():
                alt = (profiles_yaml.parent / path).resolve()
                if alt.exists():
                    resolved = alt
            return f"duckdb:///{resolved}"

        if adapter == 'postgres':
            user = out.get('user', '')
            pwd = out.get('password', '')
            host = out.get('host', 'localhost')
            port = out.get('port', 5432)
            db = out.get('dbname', out.get('database', ''))
            return f"postgresql+psycopg2://{user}:{pwd}@{host}:{port}/{db}"

        if adapter == 'snowflake':
            user = out.get('user', '')
            pwd = out.get('password', '')
            account = out.get('account', '')
            warehouse = out.get('warehouse', '')
            db = out.get('database', '')
            schema = out.get('schema', '')
            return (
                f"snowflake://{user}:{pwd}@{account}/{db}/{schema}"
                f"?warehouse={warehouse}"
            )

        # Unknown adapter — bail with None so the caller can raise a clear error.
        return None

    return None


def _from_clause(cfg: dict[str, Any]):
    """Build the FROM target: either the named upstream table (existing
    Dagster asset) or a raw source_sql query wrapped as a subquery (no
    existing asset -- reads straight from a resource/connection). Every
    column reference elsewhere in this module is a bare quoted
    literal_column, never tbl.c.<name>, so this only has to compile
    correctly as a FROM target -- it doesn't need real typed columns."""
    from sqlalchemy import MetaData, Table, text

    if cfg.get("source_sql"):
        return text(f"({cfg['source_sql']}) AS __source")

    upstream = cfg["upstream_table"]
    if "." in upstream:
        schema_name, table_name = upstream.split(".", 1)
    else:
        schema_name, table_name = None, upstream
    return Table(table_name, MetaData(), schema=schema_name)


def _build_select_sql(cfg: dict[str, Any], dialect_name: str) -> str:
    """Compile the visual-builder ops into a dialect-appropriate SELECT.

    Uses SQLAlchemy Core when possible so identifier quoting is dialect-aware.
    """
    from sqlalchemy import select, distinct as sa_distinct, literal_column, asc, desc
    from sqlalchemy.sql.elements import Label

    # We don't reflect the actual schema (would require a live connection at
    # compile time). Instead we use SQLAlchemy's literal_column throughout
    # and only need SOMETHING that compiles correctly as a FROM target --
    # never actual Column objects off of it (every column reference below is
    # a bare quoted literal_column, not tbl.c.<name>).
    keep = _csv(cfg.get("columns_to_keep"))
    drop = set(_csv(cfg.get("columns_to_drop")))
    renames = _json_dict(cfg.get("rename_columns"))
    calc = _json_dict(cfg.get("calculated_columns"))
    group_by_cols = _csv(cfg.get("group_by"))
    agg_functions = _json_dict(cfg.get("agg_functions"))

    # group_by takes over the whole SELECT list -- every non-grouped,
    # non-aggregated column has to disappear (same as pandas'
    # groupby().agg()), which makes it fundamentally incompatible with the
    # per-row projection ops below (calculated columns, string ops, window
    # functions, ...). Handled as its own simple, separate path rather than
    # threading a group_by flag through 300 lines of per-row logic.
    if group_by_cols:
        return _build_group_by_sql(cfg, group_by_cols, agg_functions, dialect_name)

    tbl = _from_clause(cfg)
    cols_referenced = set(keep) | drop | set(renames.keys()) | set(calc.keys())

    # Select clause:
    #  - If keep is provided, project just those cols (with rename applied).
    #  - Else if drop is provided, use `SELECT * EXCLUDE(...)` for dialects
    #    that support it (DuckDB, BigQuery), otherwise fall through to full
    #    column enumeration (not possible without column introspection —
    #    document this limitation).
    #  - Calculated columns are appended after the base projection.
    #
    # projected_index tracks output-column-name -> its position in
    # select_items, but ONLY for the base `keep` projection (the one case
    # where every output column name is known upfront). "In place" ops
    # below (string_operations, replace_ops) use it to overwrite that
    # column's entry instead of appending a second column with the same
    # name -- appending would compile to valid-looking but wrong/ambiguous
    # SQL (e.g. two columns both named "name"). Without an explicit `keep`
    # list (a bare SELECT *), there's no known position to overwrite, so
    # those ops fall back to appending an extra column -- the same
    # documented "needs column introspection" limitation columns_to_drop
    # already has on non-EXCLUDE dialects.
    select_items: list = []
    projected_index: dict[str, int] = {}
    if keep:
        for c in keep:
            base = literal_column(f'"{c}"')
            if c in renames:
                select_items.append(base.label(renames[c]))
                projected_index[renames[c]] = len(select_items) - 1
            elif c not in drop:
                select_items.append(base)
                projected_index[c] = len(select_items) - 1
    elif drop:
        supports_exclude = dialect_name in {'duckdb', 'bigquery'}
        if supports_exclude:
            excluded = ", ".join(f'"{c}"' for c in drop)
            select_items.append(literal_column(f'* EXCLUDE ({excluded})'))
        else:
            # Without column introspection we can't emit an explicit list. Warn
            # via a SQL comment (harmless) and just pass `*` — the drop won't
            # take effect until we add reflection. Documented limitation.
            select_items.append(literal_column("/* columns_to_drop needs reflection on this dialect */ *"))
    else:
        select_items.append(literal_column("*"))

    for new_name, expr in calc.items():
        select_items.append(literal_column(f'({expr})').label(new_name))

    # Replace ops → REPLACE(col, find, replace) applied to the column in place
    # via a labeled SELECT expression. Multiple replaces on the same column
    # chain: REPLACE(REPLACE(col, a, b), c, d).
    replace_ops = _json_list(cfg.get("replace_ops"))
    if replace_ops:
        # Group by column so we can chain replaces.
        by_col: dict[str, list[dict]] = {}
        for op in replace_ops:
            col = op.get("column")
            if not col or not op.get("find"):
                continue
            by_col.setdefault(col, []).append(op)
        for col, ops in by_col.items():
            expr = f'"{col}"'
            for op in ops:
                find = str(op.get("find", "")).replace("'", "''")
                repl = str(op.get("replace", "")).replace("'", "''")
                expr = f"REPLACE({expr}, '{find}', '{repl}')"
            labeled = literal_column(expr).label(col)
            if col in projected_index:
                select_items[projected_index[col]] = labeled
            else:
                select_items.append(labeled)

    # Split ops → SPLIT_PART(col, delimiter, N) for each target column. Works
    # on Postgres, DuckDB, Snowflake, Redshift. BigQuery uses SPLIT() but
    # returns an array — a per-dialect branch can be added later.
    split_ops = _json_list(cfg.get("split_ops"))
    if split_ops:
        for op in split_ops:
            col = op.get("column")
            delim = op.get("delimiter")
            into = op.get("into") or ""
            if not col or not delim or not into:
                continue
            targets = [t.strip() for t in into.split(",") if t.strip()]
            escaped_delim = str(delim).replace("'", "''")
            if dialect_name == 'bigquery':
                for idx, t in enumerate(targets):
                    select_items.append(
                        literal_column(f"SPLIT(\"{col}\", '{escaped_delim}')[SAFE_OFFSET({idx})]").label(t)
                    )
            else:
                for idx, t in enumerate(targets, start=1):
                    select_items.append(
                        literal_column(f"SPLIT_PART(\"{col}\", '{escaped_delim}', {idx})").label(t)
                    )

    # Case-When ops → CASE WHEN c1 THEN t1 WHEN c2 THEN t2 ELSE e END AS into
    case_when_ops = _json_list(cfg.get("case_when_ops"))
    if case_when_ops:
        for op in case_when_ops:
            into = op.get("into")
            branches = op.get("branches") or []
            if not into or not branches:
                continue
            parts = []
            for b in branches:
                col = b.get("column")
                bv = b.get("value")
                then = b.get("then")
                if not col or bv is None:
                    continue
                v_str = str(bv).replace("'", "''")
                then_str = str(then).replace("'", "''")
                cond = {
                    "equals": f'"{col}" = \'{v_str}\'',
                    "not_equals": f'"{col}" <> \'{v_str}\'',
                    "greater_than": f'"{col}" > {v_str}',
                    "less_than": f'"{col}" < {v_str}',
                    "contains": f'"{col}" LIKE \'%{v_str}%\'',
                }.get(str(b.get("operator", "equals")), f'"{col}" = \'{v_str}\'')
                parts.append(f"WHEN {cond} THEN '{then_str}'")
            else_val = str(op.get("else", "")).replace("'", "''")
            expr = f"CASE {' '.join(parts)} ELSE '{else_val}' END"
            select_items.append(literal_column(expr).label(into))

    # Concat ops → col1 || sep || col2 || sep || col3 …
    concat_ops = _json_list(cfg.get("concat_ops"))
    if concat_ops:
        for op in concat_ops:
            cols = str(op.get("columns", "")).split(",")
            cols = [c.strip() for c in cols if c.strip()]
            into = op.get("into")
            sep = str(op.get("separator", "")).replace("'", "''")
            if not cols or not into:
                continue
            # CAST each column to VARCHAR so numeric/date types don't fail on ||.
            wrapped = [f'CAST("{c}" AS VARCHAR)' for c in cols]
            expr = wrapped[0]
            for w in wrapped[1:]:
                expr = f"{expr} || '{sep}' || {w}"
            select_items.append(literal_column(expr).label(into))

    # Substring ops → SUBSTRING(col FROM start FOR length) — SQL standard;
    # DuckDB, Postgres, Snowflake, BigQuery all accept this form. A negative
    # start means "N characters from the end" (Python/pandas slice
    # convention, e.g. start=-3 = the last 3 characters onward, matching
    # s[-3:]) -- SQL's own SUBSTRING has no such concept, so a negative
    # start compiles to a LENGTH()-relative position instead of a literal
    # one. Added for "extract the last N characters" suggestions, which a
    # plain positive start can't express since the value's length varies
    # per row.
    substring_ops = _json_list(cfg.get("substring_ops"))
    if substring_ops:
        for op in substring_ops:
            col = op.get("column")
            into = op.get("into")
            start = int(op.get("start", 1))
            length = op.get("length")
            if not col or not into:
                continue
            start_expr = f'(LENGTH("{col}") + {start} + 1)' if start < 0 else str(start)
            if length is None or length == "":
                expr = f'SUBSTRING("{col}" FROM {start_expr})'
            else:
                expr = f'SUBSTRING("{col}" FROM {start_expr} FOR {int(length)})'
            select_items.append(literal_column(expr).label(into))

    # Numeric ops → ROUND / FLOOR / CEIL / ABS
    numeric_ops = _json_list(cfg.get("numeric_ops"))
    if numeric_ops:
        for op in numeric_ops:
            col = op.get("column")
            into = op.get("into")
            kind = str(op.get("op", "round")).lower()
            digits = int(op.get("digits", 0))
            if not col or not into:
                continue
            if kind == "floor":
                expr = f'FLOOR("{col}")'
            elif kind == "ceil":
                expr = f'CEIL("{col}")'
            elif kind == "abs":
                expr = f'ABS("{col}")'
            else:
                expr = f'ROUND("{col}", {digits})'
            select_items.append(literal_column(expr).label(into))

    # String ops → UPPER / LOWER / TRIM / a portable title-case emulation.
    # Applied "in place" (same column name) same as the DataFrame backend's
    # .str.upper()/.lower()/.title()/.strip() -- chains onto whatever this
    # column's expression already is (e.g. after a replace_op) via
    # projected_index, same overwrite-not-append behavior as replace_ops.
    # No "*" (all string columns) wildcard here, unlike the DataFrame
    # backend's own string_operations -- that mode needs to know every
    # object-dtype column name, which requires a live connection to
    # introspect the schema. This component deliberately never opens one at
    # compile time (see module docstring), so every column has to be named
    # explicitly.
    string_operations = _json_list(cfg.get("string_operations"))
    if string_operations:
        for op in string_operations:
            col = op.get("column")
            operation = str(op.get("operation", "upper")).lower()
            if not col or col == "*":
                continue
            # Chain onto the column's current expression (e.g. a prior
            # replace_op on the same column) rather than always re-reading
            # the raw column, so ops apply in combination, not in isolation.
            # Label.element strips the "AS alias" wrapper -- compiling a
            # Label directly would embed "AS alias" inside the UPPER(...)/
            # etc. call below, which isn't valid SQL as a function argument.
            if col in projected_index:
                current_item = select_items[projected_index[col]]
                target = current_item.element if isinstance(current_item, Label) else current_item
                current_sql = str(target.compile(compile_kwargs={"literal_binds": True}))
            else:
                current_sql = f'"{col}"'
            if operation == "lower":
                expr = f'LOWER({current_sql})'
            elif operation == "trim":
                expr = f'TRIM({current_sql})'
            elif operation == "title":
                # INITCAP is Postgres/Snowflake/Redshift; not standard SQL.
                # DuckDB and BigQuery also implement it. MySQL/MSSQL/Oracle
                # don't -- those will error at runtime, same documented
                # dialect-gap pattern as columns_to_drop's EXCLUDE(...) above.
                expr = f'INITCAP({current_sql})'
            elif operation == "remove_punctuation":
                # REGEXP_REPLACE's own arg count/flags are genuinely
                # dialect-specific (same documented-gap class as INITCAP):
                # Postgres needs a 'g' flag as a 4th arg for a global
                # replace; Snowflake/DuckDB/BigQuery replace every match by
                # default with just 3 args.
                _punct_sql = _SQL_PUNCTUATION_CLASS.replace("'", "''")
                if dialect_name == "postgresql":
                    expr = f"REGEXP_REPLACE({current_sql}, '{_punct_sql}', '', 'g')"
                else:
                    expr = f"REGEXP_REPLACE({current_sql}, '{_punct_sql}', '')"
            else:
                expr = f'UPPER({current_sql})'
            labeled = literal_column(expr).label(col)
            if col in projected_index:
                select_items[projected_index[col]] = labeled
            else:
                select_items.append(labeled)

    # Date Extract ops → EXTRACT(part FROM col)
    date_extract_ops = _json_list(cfg.get("date_extract_ops"))
    if date_extract_ops:
        for op in date_extract_ops:
            col = op.get("column")
            part = str(op.get("part", "year")).lower()
            into = op.get("into")
            if not col or not into:
                continue
            # DAYOFWEEK isn't standard EXTRACT — most dialects use DOW.
            part_sql = {
                "year": "YEAR",
                "month": "MONTH",
                "day": "DAY",
                "dayofweek": "DOW",
                "hour": "HOUR",
            }.get(part, "YEAR")
            select_items.append(literal_column(f'EXTRACT({part_sql} FROM "{col}")').label(into))

    # Bin / Bucket → CASE WHEN col <= b1 THEN L0 WHEN col <= b2 THEN L1 … END
    bin_ops = _json_list(cfg.get("bin_ops"))
    if bin_ops:
        for op in bin_ops:
            col = op.get("column")
            into = op.get("into")
            bounds_str = op.get("boundaries", "")
            labels_str = op.get("labels", "")
            if not col or not into or not bounds_str:
                continue
            try:
                bounds = [float(x.strip()) for x in bounds_str.split(",") if x.strip()]
            except ValueError:
                continue
            labels = [x.strip() for x in labels_str.split(",") if x.strip()]
            branches = []
            for i, b in enumerate(bounds):
                lbl = (labels[i] if i < len(labels) else (
                    f"<={b}" if i == 0 else f"{bounds[i-1]}-{b}"
                )).replace("'", "''")
                branches.append(f"WHEN \"{col}\" <= {b} THEN '{lbl}'")
            # Overflow bucket
            overflow_lbl = (labels[len(bounds)] if len(labels) > len(bounds) else f">{bounds[-1]}").replace("'", "''")
            expr = f"CASE {' '.join(branches)} ELSE '{overflow_lbl}' END"
            select_items.append(literal_column(expr).label(into))

    # Cumulative sum → SUM(col) OVER (PARTITION BY ... ORDER BY ...)
    cumsum_ops = _json_list(cfg.get("cumsum_ops"))
    if cumsum_ops:
        for op in cumsum_ops:
            col = op.get("column")
            into = op.get("into")
            order_by = op.get("orderBy") or op.get("order_by")
            partition_by = op.get("partitionBy") or op.get("partition_by") or ""
            order_asc = bool(op.get("orderAsc", op.get("order_asc", True)))
            if not col or not into or not order_by:
                continue
            over_parts = []
            if partition_by:
                parts = [f'"{p.strip()}"' for p in partition_by.split(",") if p.strip()]
                if parts:
                    over_parts.append("PARTITION BY " + ", ".join(parts))
            over_parts.append(f'ORDER BY "{order_by}" {"ASC" if order_asc else "DESC"}')
            expr = f'SUM("{col}") OVER ({" ".join(over_parts)})'
            select_items.append(literal_column(expr).label(into))

    # Count-matching ops → COUNT(CASE WHEN cond THEN 1 END) OVER (PARTITION BY ...)
    count_match_ops = _json_list(cfg.get("count_match_ops"))
    if count_match_ops:
        for op in count_match_ops:
            col = op.get("column")
            operator = str(op.get("operator", "equals"))
            val = op.get("value")
            into = op.get("into")
            if not col or not into or val is None or str(val).strip() == "":
                continue
            partition_by = op.get("partitionBy") or op.get("partition_by") or ""
            # Build the CASE condition. Values are quoted as strings; numeric
            # comparisons work because most warehouses coerce.
            v_str = str(val).replace("'", "''")
            cond = {
                "equals": f'"{col}" = \'{v_str}\'',
                "not_equals": f'"{col}" <> \'{v_str}\'',
                "greater_than": f'"{col}" > {v_str}',
                "less_than": f'"{col}" < {v_str}',
                "contains": f'"{col}" LIKE \'%{v_str}%\'',
            }.get(operator, f'"{col}" = \'{v_str}\'')
            expr = f"COUNT(CASE WHEN {cond} THEN 1 END) OVER"
            over_parts = []
            if partition_by:
                parts = [f'"{p.strip()}"' for p in partition_by.split(",") if p.strip()]
                if parts:
                    over_parts.append("PARTITION BY " + ", ".join(parts))
            over = " (" + " ".join(over_parts) + ")" if over_parts else " ()"
            select_items.append(literal_column(expr + over).label(into))

    # Window ops → RANK/DENSE_RANK/ROW_NUMBER OVER (PARTITION BY... ORDER BY...)
    window_ops = _json_list(cfg.get("window_ops"))
    if window_ops:
        for op in window_ops:
            kind = str(op.get("kind", "rank")).lower()
            order_by = op.get("orderBy") or op.get("order_by")
            into = op.get("into")
            if not order_by or not into:
                continue
            partition_by = op.get("partitionBy") or op.get("partition_by") or ""
            order_asc = bool(op.get("orderAsc", op.get("order_asc", True)))
            func_name = {
                "rank": "RANK",
                "dense_rank": "DENSE_RANK",
                "row_number": "ROW_NUMBER",
            }.get(kind, "RANK")
            over_parts = []
            if partition_by:
                parts = [f'"{p.strip()}"' for p in partition_by.split(",") if p.strip()]
                if parts:
                    over_parts.append("PARTITION BY " + ", ".join(parts))
            over_parts.append(f'ORDER BY "{order_by}" {"ASC" if order_asc else "DESC"}')
            over = " ".join(over_parts)
            select_items.append(literal_column(f"{func_name}() OVER ({over})").label(into))

    stmt = select(*select_items).select_from(tbl)

    if cfg.get("filter_expression"):
        stmt = stmt.where(literal_column(cfg["filter_expression"]))

    if cfg.get("drop_na"):
        # Only the columns we actually know about at compile time (keep
        # list, or whatever else got referenced) -- true "any column in the
        # whole table" isn't expressible without schema reflection, which
        # this component deliberately avoids (see module docstring).
        na_check_cols = keep or sorted(cols_referenced)
        for c in na_check_cols:
            stmt = stmt.where(literal_column(f'"{c}"').isnot(None))

    if cfg.get("drop_duplicates"):
        stmt = stmt.distinct()

    if cfg.get("sort_by"):
        sort_cols = _csv(cfg["sort_by"])
        direction = asc if cfg.get("sort_ascending", True) else desc
        stmt = stmt.order_by(*[direction(literal_column(f'"{c}"')) for c in sort_cols])

    # Sample — apply before LIMIT. We use ORDER BY RANDOM() + LIMIT as a
    # dialect-portable form (BigQuery/Snowflake/Postgres/DuckDB all support
    # some flavor of RAND/RANDOM). TABLESAMPLE would be faster but semantics
    # vary too widely across dialects.
    sample = None
    sample_cfg = cfg.get("sample_config")
    if sample_cfg:
        try:
            sample = json.loads(sample_cfg) if isinstance(sample_cfg, str) else sample_cfg
        except Exception:
            sample = None
    if sample:
        n = sample.get("n")
        fraction = sample.get("fraction")
        random_sample = bool(sample.get("random", True))
        if random_sample:
            # Every mainstream warehouse has RANDOM() / RAND() — try RANDOM
            # first (portable); dialects that don't support it will error at
            # runtime and the user can switch to top-N sample.
            stmt = stmt.order_by(literal_column("RANDOM()"))
        if n:
            stmt = stmt.limit(int(n))
        elif fraction:
            # Turn fraction into rows via a fake COUNT-based LIMIT — we don't
            # know row count at compile time. Fallback: use TABLESAMPLE-ish
            # form. For now, emit a comment and skip; user can pin N instead.
            pass  # deliberately noop — visual builder should encourage N

    limit = cfg.get("limit_rows")
    if limit is not None:
        stmt = stmt.limit(int(limit))

    return _compile_stmt(stmt)


_AGG_FUNC_SQL = {
    "sum": "SUM",
    "count": "COUNT",
    "avg": "AVG",
    "mean": "AVG",
    "min": "MIN",
    "max": "MAX",
    "std": "STDDEV",
    "stddev": "STDDEV",
}


def _build_group_by_sql(
    cfg: dict[str, Any], group_by_cols: list[str], agg_functions: dict[str, str],
    dialect_name: str,
) -> str:
    """group_by + agg_functions -> a real GROUP BY query. Kept separate from
    _build_select_sql's per-row projection ops (calculated columns, string
    ops, window functions, ...) since none of those are meaningful once rows
    have been collapsed by grouping -- mixing them in would produce invalid
    SQL (an ungrouped column in the SELECT list) rather than the pandas
    groupby().agg() shape the DataFrame backend already emits (every
    non-grouped column disappears, replaced by the aggregations)."""
    from sqlalchemy import select, literal_column, asc, desc

    agg_source_cols = set(agg_functions.keys())
    cols_referenced = set(group_by_cols) | agg_source_cols
    tbl = _from_clause(cfg)

    select_items: list = [literal_column(f'"{c}"') for c in group_by_cols]
    for col, func in agg_functions.items():
        func_lower = str(func).lower()
        if func_lower == "count_distinct":
            expr = f'COUNT(DISTINCT "{col}")'
        else:
            sql_func = _AGG_FUNC_SQL.get(func_lower, func_lower.upper())
            expr = f'{sql_func}("{col}")'
        select_items.append(literal_column(expr).label(f"{func_lower}_{col}"))

    stmt = select(*select_items).select_from(tbl)

    if cfg.get("filter_expression"):
        stmt = stmt.where(literal_column(cfg["filter_expression"]))

    if cfg.get("drop_na"):
        for c in sorted(cols_referenced):
            stmt = stmt.where(literal_column(f'"{c}"').isnot(None))

    stmt = stmt.group_by(*[literal_column(f'"{c}"') for c in group_by_cols])

    if cfg.get("sort_by"):
        sort_cols = _csv(cfg["sort_by"])
        direction = asc if cfg.get("sort_ascending", True) else desc
        stmt = stmt.order_by(*[direction(literal_column(f'"{c}"')) for c in sort_cols])

    limit = cfg.get("limit_rows")
    if limit is not None:
        stmt = stmt.limit(int(limit))

    return _compile_stmt(stmt)


def _compile_stmt(stmt) -> str:
    # Compile with the correct dialect so quoting/keywords come out right.
    from sqlalchemy.dialects import (
        postgresql, sqlite, mysql, mssql, oracle,
    )
    dialect_map: dict[str, Any] = {
        'postgresql': postgresql.dialect(),
        'sqlite': sqlite.dialect(),
        'mysql': mysql.dialect(),
        'mssql': mssql.dialect(),
        'oracle': oracle.dialect(),
    }
    try:
        # DuckDB and Snowflake have their own dialects registered when their
        # packages are installed. `create_engine` puts the right one on the
        # engine; we pass literal_string_binds so params are inlined.
        return str(stmt.compile(compile_kwargs={"literal_binds": True}))
    except Exception:
        # Fallback to Postgres-style if compile fails for this stmt shape.
        return str(stmt.compile(dialect=dialect_map['postgresql'], compile_kwargs={"literal_binds": True}))


def _csv(s: Optional[str]) -> list[str]:
    if not s:
        return []
    return [c.strip() for c in s.split(',') if c.strip()]


def _json_dict(s: Optional[str]) -> dict:
    if not s:
        return {}
    try:
        parsed = json.loads(s)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _json_list(s: Optional[str]) -> list:
    if not s:
        return []
    try:
        parsed = json.loads(s)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []
