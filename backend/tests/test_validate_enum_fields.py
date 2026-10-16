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
