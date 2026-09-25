"""Regression tests for Genie's deterministic post-plan schema checks
(_required_fields / _type_mismatches / _unknown_fields).

Each case here reproduces a REAL incident hit live this session with the
`sql_transform` community component, using its actual schema.json shape
(trimmed to the fields that matter for the test). These functions are the
last line of defense against an LLM-produced pick whose config silently
breaks a component at apply/execution time instead of at plan time.
"""

from app.services.genie_service import (
    _required_fields,
    _type_mismatches,
    _unknown_fields,
)

# A trimmed but structurally real sql_transform schema.json, as served by
# https://raw.githubusercontent.com/.../assets/transforms/sql_transform/schema.json
SQL_TRANSFORM_SCHEMA = {
    "attributes": {
        "asset_name": {"type": "string", "required": True},
        "connection_url_env_var": {"type": "string", "required": True},
        "destination_table": {"type": "string", "required": False},
        "sql": {"type": "string", "required": True},
        "template_vars": {"type": "object", "required": False},
        "return_dataframe": {"type": "boolean", "required": False, "default": False},
        "if_exists": {"type": "string", "required": False, "default": "replace"},
        "upstream_asset_keys": {
            "type": "array",
            "items": {"type": "string"},
            "required": False,
        },
        "group_name": {"type": "string", "required": False},
    }
}


class TestRequiredFields:
    def test_returns_only_fields_marked_required_true(self):
        assert set(_required_fields(SQL_TRANSFORM_SCHEMA)) == {
            "asset_name",
            "connection_url_env_var",
            "sql",
        }

    def test_empty_schema_returns_empty_list(self):
        assert _required_fields({}) == []

    def test_missing_attributes_key_returns_empty_list(self):
        assert _required_fields({"type": "object"}) == []


class TestTypeMismatches:
    def test_bare_string_upstream_asset_keys_is_flagged(self):
        # The real sql_transform incident: Genie (or a hand-edit) wrote
        # upstream_asset_keys as a plain string instead of a one-item
        # list, which installed cleanly (the field isn't required) but
        # crashed the component at apply/materialize time.
        config = {
            "asset_name": "fct_ticket_revenue_by_game",
            "upstream_asset_keys": "marts/fct_ticket_revenue",
        }
        mismatches = _type_mismatches(SQL_TRANSFORM_SCHEMA, config)
        assert len(mismatches) == 1
        assert "upstream_asset_keys" in mismatches[0]
        assert "array" in mismatches[0]

    def test_correctly_typed_array_produces_no_mismatch(self):
        config = {
            "asset_name": "fct_ticket_revenue_by_game",
            "upstream_asset_keys": ["marts/fct_ticket_revenue"],
        }
        assert _type_mismatches(SQL_TRANSFORM_SCHEMA, config) == []

    def test_boolean_into_numeric_field_is_flagged(self):
        # isinstance(True, int) is True in Python -- a bool must be
        # explicitly excluded from the numeric check or a YAML `true`/
        # `false` landing in a numeric field silently passes as "valid".
        schema = {"attributes": {"retries": {"type": "integer", "required": False}}}
        mismatches = _type_mismatches(schema, {"retries": True})
        assert len(mismatches) == 1
        assert "boolean" in mismatches[0]

    def test_correct_integer_is_not_flagged_even_though_bool_is_an_int_subclass(self):
        schema = {"attributes": {"retries": {"type": "integer", "required": False}}}
        assert _type_mismatches(schema, {"retries": 3}) == []

    def test_none_on_an_optional_field_is_not_a_type_error(self):
        # An explicit null for an unset optional field is legitimate --
        # only a field that HAS a value of the wrong type is a mismatch.
        assert _type_mismatches(SQL_TRANSFORM_SCHEMA, {"destination_table": None}) == []

    def test_field_not_in_schema_is_skipped_not_flagged(self):
        # Unknown-field detection is _unknown_fields' job, not this
        # function's -- an extra key here should be silently ignored.
        assert _type_mismatches(SQL_TRANSFORM_SCHEMA, {"made_up_field": 123}) == []

    def test_unrecognized_schema_type_is_skipped(self):
        schema = {"attributes": {"weird": {"type": "some-custom-vocab", "required": False}}}
        assert _type_mismatches(schema, {"weird": object()}) == []

    def test_multiple_mismatches_are_all_reported(self):
        config = {
            "upstream_asset_keys": "not-a-list",
            "return_dataframe": "yes",
        }
        mismatches = _type_mismatches(SQL_TRANSFORM_SCHEMA, config)
        assert len(mismatches) == 2


class TestUnknownFields:
    def test_wrong_field_names_are_flagged(self):
        # The real, more damaging incident: Genie wrote the SQL under
        # `query` and the destination under `output_table` -- neither
        # exists on sql_transform's real schema (it's `sql` /
        # `destination_table`). /install-via-cli's merge only recognizes
        # a narrow alias_map, so these were silently dropped and the
        # CLI-installed stub's own unrelated example values shipped
        # instead of the pick's real, task-correct ones.
        config = {
            "asset_name": "fct_ticket_revenue_by_game",
            "query": "SELECT 1",
            "output_table": "marts.fct_ticket_revenue_by_game",
        }
        unknown = _unknown_fields(SQL_TRANSFORM_SCHEMA, config)
        assert set(unknown) == {"query", "output_table"}

    def test_correctly_named_fields_produce_no_unknowns(self):
        config = {
            "asset_name": "fct_ticket_revenue_by_game",
            "sql": "SELECT 1",
            "destination_table": "marts.fct_ticket_revenue_by_game",
            "connection_url_env_var": "DUCKDB_SQLALCHEMY_URL",
        }
        assert _unknown_fields(SQL_TRANSFORM_SCHEMA, config) == []

    def test_empty_config_produces_no_unknowns(self):
        assert _unknown_fields(SQL_TRANSFORM_SCHEMA, {}) == []
