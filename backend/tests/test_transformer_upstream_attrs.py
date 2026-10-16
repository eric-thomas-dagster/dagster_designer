"""The attributes Designer writes for a DataFrame transformer must validate
against the community component's real model. They didn't: Designer wrote
`upstream_asset_keys: "raw_customers"` (a str) but the component's field is a
List[str] (single upstream = `upstream_asset_key`), so the new asset's defs.yaml
failed validation and the whole project stopped loading."""
import importlib.util

import pytest

from app.api.assets import _dataframe_transformer_upstream_attrs as fix


def test_single_upstream_uses_the_singular_key():
    out = fix({"asset_name": "x", "upstream_asset_keys": "raw_customers", "group_by": "last_name"})
    assert out == {"asset_name": "x", "upstream_asset_key": "raw_customers", "group_by": "last_name"}


def test_comma_separated_becomes_a_real_list():
    out = fix({"asset_name": "x", "upstream_asset_keys": "a, b"})
    assert out["upstream_asset_keys"] == ["a", "b"] and "upstream_asset_key" not in out


def test_missing_upstream_is_left_alone():
    assert fix({"asset_name": "x"}) == {"asset_name": "x"}


@pytest.mark.skipif(importlib.util.find_spec("dagster_community_components") is None,
                    reason="community package not installed")
def test_result_validates_against_the_real_component():
    from dagster_community_components import DataFrameTransformerComponent

    attrs = fix({"asset_name": "new_asset", "upstream_asset_keys": "raw_customers",
                 "group_by": "last_name", "agg_functions": '{"city": "count"}'})
    DataFrameTransformerComponent(**attrs)
