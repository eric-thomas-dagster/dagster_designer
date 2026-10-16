import json

from app.api.templates_registry import validate_component_config

SCHEMA = {"attributes": {"backfill_policy": {
    "type": "string", "required": False, "default": None,
    "enum": ["single_run", "multi_run"], "ui:widget": "select"}}}


def _run(tmp_path, attrs):
    (tmp_path / "schema.json").write_text(json.dumps(SCHEMA))
    return validate_component_config(tmp_path, attrs)


def test_valid_value_kept(tmp_path):
    assert _run(tmp_path, {"backfill_policy": "single_run"}) == ({"backfill_policy": "single_run"}, [])


def test_blank_selection_is_unset_not_empty_string(tmp_path):
    assert _run(tmp_path, {"backfill_policy": ""}) == ({}, [])


def test_value_outside_enum_rejected(tmp_path):
    cleaned, errors = _run(tmp_path, {"backfill_policy": "bogus"})
    assert cleaned == {} and "single_run" in errors[0]


def test_alias_value_is_reshaped_between_singular_and_plural():
    from app.api.templates_registry import coerce_alias_value as c
    assert c('upstream_asset_key', ['generated_orders']) == ('generated_orders', True)
    assert c('upstream_asset_key', 'x') == ('x', True)
    assert c('upstream_asset_key', ['a', 'b'])[1] is False
    assert c('upstream_asset_keys', 'x') == (['x'], True)
    assert c('file_path', 'p') == ('p', True)
