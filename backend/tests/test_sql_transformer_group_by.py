"""Regression tests for SqlTransformerComponent's SQL generation.

group_by/agg_functions, drop_na, and string_operations were previously
either unsupported (group_by/agg_functions, drop_na -- assets.py silently
dropped them when routing a transform to the SQL backend) or newly added
alongside a real bug found while testing it: string_operations/replace_ops
appended a second, duplicately-named output column instead of overwriting
the base projection's entry for the same column when used together with
columns_to_keep, which compiles to ambiguous/wrong SQL rather than erroring
loudly.
"""

from dagster_designer_components.sql_transformer import _build_select_sql


def test_group_by_and_aggregations_compile_to_real_group_by():
    cfg = {
        "upstream_table": "main.support_tickets",
        "group_by": "customer_id,status",
        "agg_functions": '{"amount": "sum", "id": "count", "customer_id": "count_distinct"}',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert 'GROUP BY "customer_id", "status"' in sql
    assert 'SUM("amount") AS sum_amount' in sql
    assert 'COUNT("id") AS count_id' in sql
    assert 'COUNT(DISTINCT "customer_id") AS count_distinct_customer_id' in sql


def test_group_by_ignores_per_row_projection_options():
    # columns_to_keep/calculated_columns are meaningless once group_by
    # collapses rows -- the group_by path must not try to honor them.
    cfg = {
        "upstream_table": "main.events",
        "columns_to_keep": "irrelevant_column",
        "group_by": "region",
        "agg_functions": '{"revenue": "sum"}',
    }
    sql = _build_select_sql(cfg, "duckdb")
    assert "irrelevant_column" not in sql
    assert 'SELECT "region", SUM("revenue") AS sum_revenue' in sql


def test_drop_na_adds_is_not_null_for_known_columns():
    cfg = {
        "upstream_table": "main.support_tickets",
        "columns_to_keep": "id,name",
        "drop_na": True,
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert '"id" IS NOT NULL' in sql
    assert '"name" IS NOT NULL' in sql


def test_string_operations_chain_without_duplicating_the_column():
    # The bug: applying upper() then trim() to a column that's also in
    # columns_to_keep used to append TWO extra "name" columns on top of the
    # base projection's own "name" entry -- three columns all named "name".
    cfg = {
        "upstream_table": "main.support_tickets",
        "columns_to_keep": "id,name",
        "string_operations": '[{"column": "name", "operation": "upper"}, {"column": "name", "operation": "trim"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert sql.count('"name"') <= 2  # the TRIM(UPPER("name")) arg, plus nothing else naming it raw
    assert 'TRIM(UPPER("name")) AS name' in sql
    assert sql.count(" AS name") == 1


def test_string_operations_chain_with_prior_replace_op():
    cfg = {
        "upstream_table": "main.support_tickets",
        "columns_to_keep": "id,name",
        "replace_ops": '[{"column": "name", "find": "Mr.", "replace": ""}]',
        "string_operations": '[{"column": "name", "operation": "trim"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert "TRIM(REPLACE(\"name\", 'Mr.', '')) AS name" in sql
    assert sql.count(" AS name") == 1


def test_rename_still_works_alongside_string_operations_on_another_column():
    cfg = {
        "upstream_table": "main.support_tickets",
        "columns_to_keep": "id,name,email",
        "rename_columns": '{"email": "contact_email"}',
        "string_operations": '[{"column": "name", "operation": "upper"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert '"email" AS contact_email' in sql
    assert 'UPPER("name") AS name' in sql


def test_source_sql_reads_from_a_resource_or_connection_without_an_upstream_asset():
    # No upstream_table/upstream_asset_keys at all -- this is the "start a
    # transform from a resource or a bare SQLAlchemy connection string"
    # entry point, not an existing Dagster asset.
    cfg = {
        "source_sql": "SELECT id, name, amount FROM raw_orders WHERE region = 'US'",
        "columns_to_keep": "id,amount",
        "filter_expression": '"amount" > 0',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert "FROM (SELECT id, name, amount FROM raw_orders WHERE region = 'US') AS __source" in sql
    assert 'WHERE "amount" > 0' in sql


def test_source_sql_works_with_group_by_too():
    cfg = {
        "source_sql": "SELECT customer_id, revenue FROM raw_orders",
        "group_by": "customer_id",
        "agg_functions": '{"revenue": "sum"}',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert "FROM (SELECT customer_id, revenue FROM raw_orders) AS __source" in sql
    assert 'GROUP BY "customer_id"' in sql


def test_string_operations_without_columns_to_keep_falls_back_to_appending():
    # Documented limitation: without an explicit keep list, there's no known
    # position to overwrite, so this appends an extra column on top of
    # SELECT * rather than truly replacing it in place.
    cfg = {
        "upstream_table": "main.events",
        "string_operations": '[{"column": "name", "operation": "upper"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert "SELECT *, " in sql
    assert 'UPPER("name") AS name' in sql


def test_remove_punctuation_uses_dialect_specific_regexp_replace_args():
    cfg = {
        "upstream_table": "main.customers",
        "columns_to_keep": "id,name",
        "string_operations": '[{"column": "name", "operation": "remove_punctuation"}]',
    }
    pg_sql = _build_select_sql(cfg, "postgresql")
    assert "REGEXP_REPLACE(\"name\", '" in pg_sql
    assert pg_sql.rstrip().endswith("'g') AS name") or ", 'g') AS name" in pg_sql
    duckdb_sql = _build_select_sql(cfg, "duckdb")
    assert "REGEXP_REPLACE(\"name\", '" in duckdb_sql
    assert ", 'g')" not in duckdb_sql  # no trailing global-match flag outside Postgres


def test_remove_punctuation_wildcard_column_is_skipped_not_crashed():
    # SQL mode can't auto-detect string columns without a live connection
    # (this component deliberately never opens one at compile time) --
    # "*" is silently skipped rather than producing broken SQL.
    cfg = {
        "upstream_table": "main.customers",
        "columns_to_keep": "id",
        "string_operations": '[{"column": "*", "operation": "remove_punctuation"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert "REGEXP_REPLACE" not in sql


def test_substring_ops_negative_start_means_from_the_end():
    # start=-3 means "the last 3 characters onward" (Python/pandas slice
    # convention), computed relative to LENGTH() since SQL's own SUBSTRING
    # has no such concept -- verified against a real DuckDB execution
    # (not just structural) while building this: "CHI-202425-001" with
    # start=-3 correctly returns "001".
    cfg = {
        "upstream_table": "main.t",
        "columns_to_keep": "id",
        "substring_ops": '[{"column": "code", "start": -3, "into": "last3"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert 'SUBSTRING("code" FROM (LENGTH("code") + -3 + 1)) AS last3' in sql


def test_substring_ops_negative_start_with_length():
    cfg = {
        "upstream_table": "main.t",
        "columns_to_keep": "id",
        "substring_ops": '[{"column": "code", "start": -5, "length": 3, "into": "mid"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert 'SUBSTRING("code" FROM (LENGTH("code") + -5 + 1) FOR 3) AS mid' in sql


def test_substring_ops_positive_start_unaffected_by_negative_handling():
    cfg = {
        "upstream_table": "main.t",
        "columns_to_keep": "id",
        "substring_ops": '[{"column": "code", "start": 1, "length": 3, "into": "prefix"}]',
    }
    sql = _build_select_sql(cfg, "postgresql")
    assert 'SUBSTRING("code" FROM 1 FOR 3) AS prefix' in sql
