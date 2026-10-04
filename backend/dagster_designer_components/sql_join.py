"""SqlJoinComponent — join two warehouse tables via CTAS, no data movement.

The warehouse-native counterpart to the community `dataframe_join`
component. Designer's Join builder routes here automatically when BOTH
sides of a join are already warehouse-backed (a dbt model, or an asset
produced by SqlTransformerComponent/SqlJoinComponent itself) and share a
connection -- see `_resolve_warehouse_source` / `create_join_asset` in
backend/app/api/assets.py. Everything else (a DataFrame source on either
side, or two warehouse sides on different connections) still goes through
dataframe_join.

Unlike SqlTransformerComponent, this builds raw SQL strings instead of
SQLAlchemy Core expressions -- it needs a uniform way to run that SQL
against either a real SQLAlchemy Engine OR a raw DBAPI2 connection (e.g.
dagster_duckdb's DuckDBResource, which exposes only .get_connection(), not
.get_engine()/.get_sqlalchemy_engine() -- confirmed by introspecting the
installed class), and SQLAlchemy Core's dialect-aware compilation isn't
available without a real SQLAlchemy engine to compile against. A `dialect`
field stands in for that (same convention the community warehouse_join
component already uses) rather than trying to detect it from a connection
that might not be a SQLAlchemy connection at all.
"""

import os
from typing import Any, Optional, Union

import dagster as dg


_JOIN_KEYWORDS = {
    "inner": "INNER JOIN",
    "left": "LEFT JOIN",
    "right": "RIGHT JOIN",
    "outer": "FULL OUTER JOIN",
    "full": "FULL OUTER JOIN",
    "cross": "CROSS JOIN",
}


class SqlJoinComponent(dg.Component, dg.Model, dg.Resolvable):
    """Join two warehouse tables via CTAS. Column projection (rename,
    keep_only_columns, and same-name-conflict suffixing) is computed from
    the caller-supplied `left_columns`/`right_columns` at defs.yaml-write
    time, the same real column lists the Join builder's preview already
    fetched -- so no live schema reflection is needed at execution time.
    """

    asset_name: str
    left_table: str  # SQL identifier, e.g. "main.customers"
    right_table: str
    left_asset_keys: Optional[str] = None  # comma-separated, for Dagster deps
    right_asset_keys: Optional[str] = None
    output_schema: str = "main"
    dialect: str = "duckdb"

    resource_key: Optional[str] = None
    connection_url: Optional[str] = None
    connection_url_env_var: Optional[str] = None

    how: str = "inner"  # inner | left | right | outer | cross
    on_columns: Optional[str] = None  # comma-separated, same name both sides
    left_on: Optional[str] = None     # comma-separated, used with right_on
    right_on: Optional[str] = None

    # Real, unrenamed column lists for each side -- required to build an
    # unambiguous projection (which columns conflict, what to suffix).
    left_columns: Optional[str] = None
    right_columns: Optional[str] = None

    suffixes: Optional[str] = None  # comma-separated pair, default "_x,_y"
    # JSON dict: {"old": "new"}. Typed to also accept a bare dict because dg's
    # component YAML resolution Jinja-renders every string attribute
    # (dagster/components/resolved/context.py's NativeTemplate), which
    # returns a native Python object instead of str whenever the rendered
    # text is itself a valid Python literal -- true of any JSON dict string.
    # Confirmed live on the sibling SqlTransformerComponent.
    rename_columns: Optional[Union[str, dict]] = None
    keep_only_columns: Optional[str] = None   # comma-separated, POST-rename names

    group_name: Optional[str] = None
    description: Optional[str] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        cfg = self._snapshot()

        left_keys = [dg.AssetKey.from_user_string(k.strip())
                     for k in (self.left_asset_keys or "").split(",") if k.strip()]
        right_keys = [dg.AssetKey.from_user_string(k.strip())
                      for k in (self.right_asset_keys or "").split(",") if k.strip()]

        asset_kwargs: dict[str, Any] = dict(
            name=self.asset_name,
            deps=left_keys + right_keys,
            group_name=self.group_name,
            description=self.description,
            compute_kind="sql",
        )
        if self.resource_key:
            asset_kwargs["required_resource_keys"] = {self.resource_key}

        @dg.asset(**asset_kwargs)
        def _sql_join(context):
            select_sql = _build_join_select_sql(cfg)
            output_table = f'"{cfg["output_schema"]}"."{cfg["asset_name"]}"'
            create_sql = f"CREATE OR REPLACE TABLE {output_table} AS\n{select_sql}"
            context.log.info(f"[SqlJoin] Materializing {cfg['output_schema']}.{cfg['asset_name']}")
            context.log.info(f"[SqlJoin] SQL:\n{create_sql}")
            with _open_sql_session(cfg, context) as sql_session:
                sql_session.execute(create_sql)
                row_count = int(sql_session.scalar(f"SELECT COUNT(*) FROM {output_table}") or 0)
            context.add_output_metadata({
                "row_count": row_count,
                "sql": dg.MetadataValue.md(f"```sql\n{create_sql}\n```"),
            })
            return None

        return dg.Definitions(assets=[_sql_join])

    def _snapshot(self) -> dict[str, Any]:
        return {
            "asset_name": self.asset_name,
            "left_table": self.left_table,
            "right_table": self.right_table,
            "output_schema": self.output_schema,
            "dialect": self.dialect,
            "resource_key": self.resource_key,
            "connection_url": self.connection_url,
            "connection_url_env_var": self.connection_url_env_var,
            "how": self.how,
            "on_columns": self.on_columns,
            "left_on": self.left_on,
            "right_on": self.right_on,
            "left_columns": self.left_columns,
            "right_columns": self.right_columns,
            "suffixes": self.suffixes,
            "rename_columns": self.rename_columns,
            "keep_only_columns": self.keep_only_columns,
        }


def _csv(s: Optional[str]) -> list[str]:
    return [p.strip() for p in (s or "").split(",") if p.strip()]


def _json_dict(s: Optional[Union[str, dict]]) -> dict:
    if not s:
        return {}
    # Already-resolved by dg's Jinja NativeTemplate coercion -- see the
    # Union[str, dict] field comment on rename_columns above.
    if isinstance(s, dict):
        return s
    import json
    parsed = json.loads(s)
    return parsed if isinstance(parsed, dict) else {}


def _build_join_select_sql(cfg: dict[str, Any]) -> str:
    how = (cfg["how"] or "inner").lower()
    if how not in _JOIN_KEYWORDS:
        raise ValueError(f"how={how!r} not supported. Use one of {sorted(_JOIN_KEYWORDS)}.")

    on_cols = _csv(cfg.get("on_columns"))
    left_on = _csv(cfg.get("left_on")) or on_cols
    right_on = _csv(cfg.get("right_on")) or on_cols
    if how != "cross" and not (left_on and right_on and len(left_on) == len(right_on)):
        raise ValueError("Set on_columns, or both left_on and right_on with matching length.")

    left_cols = _csv(cfg.get("left_columns"))
    right_cols = _csv(cfg.get("right_columns"))
    if not left_cols or not right_cols:
        raise ValueError("left_columns and right_columns are required to build an unambiguous projection.")

    suffixes = _csv(cfg.get("suffixes")) or ["_x", "_y"]
    rename = _json_dict(cfg.get("rename_columns"))
    keep = _csv(cfg.get("keep_only_columns"))
    on_key_set = set(on_cols)
    shared_non_key = {c for c in left_cols if c in right_cols and c not in on_key_set}

    select_items: list[str] = []
    for c in left_cols:
        out_name = f"{c}{suffixes[0]}" if c in shared_non_key else c
        out_name = rename.get(out_name, out_name)
        if keep and out_name not in keep:
            continue
        select_items.append(f'_l."{c}" AS "{out_name}"')
    for c in right_cols:
        if c in on_key_set:
            continue  # shown once already, from the left side
        out_name = f"{c}{suffixes[1]}" if c in shared_non_key else c
        out_name = rename.get(out_name, out_name)
        if keep and out_name not in keep:
            continue
        select_items.append(f'_r."{c}" AS "{out_name}"')

    if not select_items:
        raise ValueError("keep_only_columns excluded every projected column.")

    if how == "cross":
        from_clause = f'FROM {cfg["left_table"]} AS _l CROSS JOIN {cfg["right_table"]} AS _r'
    else:
        on_clause = " AND ".join(f'_l."{l}" = _r."{r}"' for l, r in zip(left_on, right_on))
        from_clause = f'FROM {cfg["left_table"]} AS _l {_JOIN_KEYWORDS[how]} {cfg["right_table"]} AS _r ON {on_clause}'

    return f"SELECT {', '.join(select_items)}\n{from_clause}"


class _SqlSession:
    """Uniform execute/scalar interface over either a SQLAlchemy Connection
    (already inside a transaction) or a native DBAPI2 connection (e.g. the
    duckdb.DuckDBPyConnection yielded by DuckDBResource.get_connection())."""

    def __init__(self, conn: Any, is_sqlalchemy: bool):
        self._conn = conn
        self._is_sqlalchemy = is_sqlalchemy

    def execute(self, sql: str) -> None:
        if self._is_sqlalchemy:
            self._conn.exec_driver_sql(sql)
        else:
            self._conn.execute(sql)

    def scalar(self, sql: str) -> Any:
        if self._is_sqlalchemy:
            return self._conn.exec_driver_sql(sql).scalar()
        return self._conn.execute(sql).fetchone()[0]


import contextlib


@contextlib.contextmanager
def _open_sql_session(cfg: dict[str, Any], context=None):
    """Resolution order: a registered Dagster resource (resource_key) via
    .get_connection() (the common real case -- dagster_duckdb's
    DuckDBResource) or .get_engine()/.get_sqlalchemy_engine() (a resource
    that exposes a SQLAlchemy engine directly); then a bare connection_url
    / connection_url_env_var via a self-created SQLAlchemy engine, disposed
    here since nothing else could own its lifecycle."""
    import sqlalchemy

    resource_key = cfg.get("resource_key")
    if resource_key:
        if context is None:
            raise ValueError(f"resource_key={resource_key!r} set but no execution context available.")
        resource = getattr(context.resources, resource_key)
        if hasattr(resource, "get_connection"):
            with resource.get_connection() as raw_conn:
                yield _SqlSession(raw_conn, is_sqlalchemy=False)
            return
        for meth in ("get_engine", "get_sqlalchemy_engine"):
            fn = getattr(resource, meth, None)
            if callable(fn):
                with fn().begin() as conn:
                    yield _SqlSession(conn, is_sqlalchemy=True)
                return
        raise ValueError(
            f"resource {resource_key!r} must expose .get_connection() or .get_engine(); "
            f"got {type(resource).__name__}"
        )

    url = cfg.get("connection_url")
    if not url and cfg.get("connection_url_env_var"):
        url = os.environ.get(cfg["connection_url_env_var"])
        if not url:
            raise EnvironmentError(f"Env var {cfg['connection_url_env_var']!r} is not set")
    if not url:
        # Both join sides commonly resolve with no resource_key at all --
        # e.g. two dbt models, the most common real warehouse-native case
        # (jaffle shop) -- so fall back to the same dbt profiles.yml
        # derivation SqlTransformerComponent uses, rather than requiring
        # the user to configure a connection twice.
        try:
            from .sql_transformer import _derive_url_from_dbt_profile
        except ImportError:
            from sql_transformer import _derive_url_from_dbt_profile
        url = _derive_url_from_dbt_profile()
    if not url:
        raise ValueError(
            "Set 'resource_key', 'connection_url', or 'connection_url_env_var', or ensure "
            "a dbt profiles.yml is present in the project."
        )
    engine = sqlalchemy.create_engine(url)
    try:
        with engine.begin() as conn:
            yield _SqlSession(conn, is_sqlalchemy=True)
    finally:
        engine.dispose()
