"""Regression tests for SqlJoinComponent's SQL generation and connection
resolution -- the warehouse-native counterpart to dataframe_join that
create_join_asset routes to when both sides of a Join are already
warehouse-backed and share a connection (see _resolve_warehouse_source in
app/api/assets.py).

Column projection is computed from caller-supplied left_columns/
right_columns (the real upstream column lists the Join builder's preview
already fetched) rather than live schema reflection, so these tests check
SQL generation directly against known column lists -- same style as
test_sql_transformer_group_by.py.
"""

from dagster_designer_components.sql_join import _build_join_select_sql


def _cfg(**overrides):
    base = {
        "how": "inner",
        "on_columns": "customer_id",
        "left_on": None,
        "right_on": None,
        "left_table": "main.customers",
        "right_table": "main.orders",
        "left_columns": "customer_id,name,status",
        "right_columns": "customer_id,order_id,amount,status",
        "rename_columns": None,
        "keep_only_columns": None,
        "suffixes": None,
    }
    base.update(overrides)
    return base


def test_on_columns_shows_join_key_once_and_suffixes_the_real_conflict():
    sql = _build_join_select_sql(_cfg())
    assert 'SELECT _l."customer_id" AS "customer_id"' in sql
    # "status" exists on both sides and isn't the join key -- must suffix.
    assert '_l."status" AS "status_x"' in sql
    assert '_r."status" AS "status_y"' in sql
    # The join key from the right side must not appear a second time in the
    # SELECT list (only in the ON clause, which is expected).
    select_clause = sql.split("\n")[0]
    assert '_r."customer_id" AS' not in select_clause
    assert 'INNER JOIN main.orders AS _r ON _l."customer_id" = _r."customer_id"' in sql


def test_rename_targets_the_suffixed_name_then_keep_only_columns_filters_by_final_name():
    sql = _build_join_select_sql(_cfg(
        rename_columns='{"status_y": "order_status"}',
        keep_only_columns="customer_id,name,order_status",
    ))
    assert '_r."status" AS "order_status"' in sql
    assert '"status_x"' not in sql  # dropped by keep_only_columns
    assert '"amount"' not in sql
    assert '"order_id"' not in sql


def test_left_on_right_on_with_different_names_keeps_both_key_columns():
    sql = _build_join_select_sql(_cfg(
        on_columns=None,
        left_on="id",
        right_on="cust_id",
        left_columns="id,name",
        right_columns="cust_id,amount",
    ))
    assert '_l."id" AS "id"' in sql
    assert '_r."cust_id" AS "cust_id"' in sql
    assert 'ON _l."id" = _r."cust_id"' in sql


def test_cross_join_needs_no_on_clause():
    sql = _build_join_select_sql(_cfg(how="cross", on_columns=None))
    assert "CROSS JOIN" in sql
    assert " ON " not in sql


def test_keep_only_columns_excluding_every_column_raises():
    import pytest
    with pytest.raises(ValueError, match="excluded every"):
        _build_join_select_sql(_cfg(keep_only_columns="nonexistent_column"))


def test_missing_join_keys_for_non_cross_join_raises():
    import pytest
    with pytest.raises(ValueError, match="on_columns"):
        _build_join_select_sql(_cfg(on_columns=None, left_on=None, right_on=None))
