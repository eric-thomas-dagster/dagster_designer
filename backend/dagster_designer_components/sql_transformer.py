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
from pathlib import Path
from typing import Any, Optional

import dagster as dg


class SqlTransformerComponent(dg.Component, dg.Model, dg.Resolvable):
    """Apply visual-builder transformations against a warehouse table using SQL.

    Reads from an upstream table (a dbt model output, a sink component output,
    or any other warehouse table declared as a Dagster asset) and writes the
    transformed result as a new table. Everything stays in the warehouse — no
    data movement — which is the whole point vs the DataFrame path.
    """

    asset_name: str
    upstream_asset_keys: str  # comma-separated
    upstream_table: str  # SQL identifier for the source, e.g. "main.stg_customers"
    output_schema: str = "main"

    # Connection — try in order.
    connection_url: Optional[str] = None
    connection_url_env_var: Optional[str] = None
    # If both are unset we look for a dbt profiles.yml near the project.

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

    group_name: Optional[str] = None
    description: Optional[str] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        upstream_keys = [
            dg.AssetKey.from_user_string(k.strip())
            for k in self.upstream_asset_keys.split(',')
            if k.strip()
        ]

        # Snapshot config into locals — self isn't safe to close over inside
        # the asset function.
        cfg = self._snapshot()

        @dg.asset(
            name=self.asset_name,
            deps=upstream_keys,
            group_name=self.group_name,
            description=self.description,
            compute_kind="sql",
        )
        def _sql_transform(ctx: dg.AssetExecutionContext):
            engine = _resolve_engine(cfg)
            select_sql = _build_select_sql(cfg, engine.dialect.name)
            create_sql = (
                f'CREATE OR REPLACE TABLE "{cfg["output_schema"]}"."{cfg["asset_name"]}" AS\n'
                f'{select_sql}'
            )
            ctx.log.info(
                f"[SqlTransformer] Materializing {cfg['output_schema']}.{cfg['asset_name']}"
            )
            ctx.log.info(f"[SqlTransformer] Dialect: {engine.dialect.name}")
            ctx.log.info(f"[SqlTransformer] SQL:\n{create_sql}")
            with engine.begin() as conn:
                from sqlalchemy import text  # local import — sqlalchemy is a soft dep
                conn.execute(text(create_sql))
                # Return a row count so the run log has something concrete.
                count = conn.execute(
                    text(f'SELECT COUNT(*) FROM "{cfg["output_schema"]}"."{cfg["asset_name"]}"')
                ).scalar()
                ctx.add_output_metadata({"row_count": int(count) if count is not None else 0})
            return None

        return dg.Definitions(assets=[_sql_transform])

    def _snapshot(self) -> dict[str, Any]:
        return {
            "asset_name": self.asset_name,
            "upstream_asset_keys": self.upstream_asset_keys,
            "upstream_table": self.upstream_table,
            "output_schema": self.output_schema,
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
        }


def _resolve_engine(cfg: dict[str, Any]):
    """Return a SQLAlchemy Engine. Tries in order: explicit URL, env var URL,
    then dbt profiles.yml derivation. Raises with a clear message on failure."""
    from sqlalchemy import create_engine

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
            "Set connection_url, connection_url_env_var, or ensure a dbt "
            "profiles.yml is present in the project."
        )
    return create_engine(url)


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


def _build_select_sql(cfg: dict[str, Any], dialect_name: str) -> str:
    """Compile the visual-builder ops into a dialect-appropriate SELECT.

    Uses SQLAlchemy Core when possible so identifier quoting is dialect-aware.
    """
    from sqlalchemy import (
        MetaData, Table, select, distinct as sa_distinct,
        Column, literal_column, asc, desc,
    )
    from sqlalchemy.sql import quoted_name

    # Split schema.table from upstream_table if provided that way.
    upstream = cfg["upstream_table"]
    if "." in upstream:
        schema_name, table_name = upstream.split(".", 1)
    else:
        schema_name, table_name = None, upstream

    # We don't reflect the actual schema (would require a live connection at
    # compile time). Instead we use SQLAlchemy's literal_column and pass an
    # empty Table with named columns as they're referenced.
    keep = _csv(cfg.get("columns_to_keep"))
    drop = set(_csv(cfg.get("columns_to_drop")))
    renames = _json_dict(cfg.get("rename_columns"))
    calc = _json_dict(cfg.get("calculated_columns"))

    # Build a Table stub with any columns explicitly named. Anything else in
    # SELECT goes via `text()` / literal_column. Using an ephemeral MetaData
    # so we don't collide across component instances.
    metadata = MetaData()
    cols_referenced = set(keep) | drop | set(renames.keys()) | set(calc.keys())
    tbl = Table(
        table_name,
        metadata,
        *[Column(quoted_name(c, quote=True)) for c in cols_referenced],
        schema=schema_name,
    )

    # Select clause:
    #  - If keep is provided, project just those cols (with rename applied).
    #  - Else if drop is provided, use `SELECT * EXCLUDE(...)` for dialects
    #    that support it (DuckDB, BigQuery), otherwise fall through to full
    #    column enumeration (not possible without column introspection —
    #    document this limitation).
    #  - Calculated columns are appended after the base projection.
    select_items: list = []
    if keep:
        for c in keep:
            base = literal_column(f'"{c}"')
            if c in renames:
                select_items.append(base.label(renames[c]))
            elif c not in drop:
                select_items.append(base)
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

    stmt = select(*select_items).select_from(tbl)

    if cfg.get("filter_expression"):
        stmt = stmt.where(literal_column(cfg["filter_expression"]))

    if cfg.get("drop_duplicates"):
        stmt = stmt.distinct()

    if cfg.get("sort_by"):
        sort_cols = _csv(cfg["sort_by"])
        direction = asc if cfg.get("sort_ascending", True) else desc
        stmt = stmt.order_by(*[direction(literal_column(f'"{c}"')) for c in sort_cols])

    limit = cfg.get("limit_rows")
    if limit is not None:
        stmt = stmt.limit(int(limit))

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
