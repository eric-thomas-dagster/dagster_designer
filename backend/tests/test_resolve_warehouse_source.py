"""Regression tests for _resolve_warehouse_source -- the detection
create_join_asset uses to decide whether a Join should route to the
warehouse-native SqlJoinComponent or fall back to dataframe_join.
"""

import yaml
from pathlib import Path

from app.api.assets import _resolve_warehouse_source


def test_dbt_model_asset_key_resolves_without_a_resource_key():
    result = _resolve_warehouse_source(Path("/nonexistent"), "models/stg_customers")
    assert result == ("main.stg_customers", None)


def test_sql_transformer_output_resolves_its_table_and_resource_key(tmp_path):
    defs_dir = tmp_path / "defs" / "my_sql_transform"
    defs_dir.mkdir(parents=True)
    (defs_dir / "defs.yaml").write_text(yaml.dump({
        "type": "my_project.dagster_designer_components.SqlTransformerComponent",
        "attributes": {"asset_name": "my_sql_transform", "output_schema": "main", "resource_key": "duckdb_resource"},
    }))
    assert _resolve_warehouse_source(tmp_path, "my_sql_transform") == ("main.my_sql_transform", "duckdb_resource")


def test_dataframe_component_output_is_not_warehouse_native(tmp_path):
    defs_dir = tmp_path / "defs" / "my_df_asset"
    defs_dir.mkdir(parents=True)
    (defs_dir / "defs.yaml").write_text(yaml.dump({
        "type": "my_project.components.dataframe_transformer.DataFrameTransformerComponent",
        "attributes": {"asset_name": "my_df_asset"},
    }))
    assert _resolve_warehouse_source(tmp_path, "my_df_asset") is None


def test_nonexistent_asset_returns_none(tmp_path):
    assert _resolve_warehouse_source(tmp_path, "does_not_exist") is None
