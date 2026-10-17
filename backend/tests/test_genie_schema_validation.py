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


class TestSanitizePickConfigs:
    """The LLM repair pass once 'repaired' an invented `regex` field into `source` (an object-typed field) holding a
    regex string; that value fails the component's validation, so the whole plan was applied and then undone."""

    def _run(self, config, schema):
        import asyncio
        from unittest.mock import patch

        from app.services import genie_service as g

        pick = g.GeniePick(component_type="extract", asset_name="out", upstream_asset_names=[], config=config, action="add", reason="r")

        async def fake_fetch(url, client=None):
            return schema

        with patch.object(g, "_fetch_schema", fake_fetch):
            notes = asyncio.run(g._sanitize_pick_configs([pick], {"extract": {"schema_url": "http://x/schema.json"}}))
        return pick, notes

    SCHEMA = {"attributes": {"source": {"type": "object"}, "source_column": {"type": "string"}, "index": {"type": "integer"}}}

    def test_wrong_typed_field_is_dropped_and_reported(self):
        pick, notes = self._run({"source_column": "email", "source": "@(.+)$"}, self.SCHEMA)
        assert pick.config == {"source_column": "email"}
        assert len(notes) == 1 and "source" in notes[0] and "out" in notes[0]

    def test_valid_config_is_untouched(self):
        pick, notes = self._run({"source_column": "email", "index": 1}, self.SCHEMA)
        assert pick.config == {"source_column": "email", "index": 1} and notes == []

    def test_unknown_names_are_left_for_the_alias_step(self):
        pick, notes = self._run({"nonsense": "x"}, self.SCHEMA)
        assert pick.config == {"nonsense": "x"} and notes == []


class TestSanitizeJsonStringFields:
    SCHEMA = {"attributes": {"split_ops": {"type": "string", "description": 'JSON list of split ops: [{"column": "a"}]'},
                             "note": {"type": "string", "description": "free text"}}}

    def _run(self, config):
        return TestSanitizePickConfigs()._run(config, self.SCHEMA)

    def test_a_structure_for_a_json_text_field_is_serialized_not_dropped(self):
        import json
        ops = [{"column": "email", "delimiter": "@", "into": "local,domain"}]
        pick, notes = self._run({"split_ops": ops})
        assert json.loads(pick.config["split_ops"]) == ops and any("Converted split_ops" in n for n in notes)

    def test_a_json_field_that_is_not_json_is_dropped(self):
        pick, notes = self._run({"split_ops": "email@local_part,domain", "note": "x"})
        assert pick.config == {"note": "x"} and "split_ops" in notes[0]

    def test_valid_json_in_a_json_field_is_kept(self):
        good = '[{"column": "email", "delimiter": "@", "into": "local,domain"}]'
        pick, notes = self._run({"split_ops": good})
        assert pick.config == {"split_ops": good} and notes == []


class TestNormalizeJsonOps:
    DESC = 'JSON list of split ops: [{"column": "full_name", "delimiter": " ", "into": "first_name,last_name"}].'

    def test_list_where_the_example_shows_a_string_is_joined(self):
        import json
        from app.services.genie_service import _normalize_json_ops
        out = _normalize_json_ops(self.DESC, json.dumps([{"column": "email", "delimiter": "@", "into": ["local_part", "domain"]}]))
        assert json.loads(out)[0]["into"] == "local_part,domain"

    def test_already_correct_and_unrelated_values_are_untouched(self):
        import json
        from app.services.genie_service import _normalize_json_ops
        good = json.dumps([{"column": "email", "into": "a,b"}])
        assert _normalize_json_ops(self.DESC, good) == good
        other = json.dumps([{"column": "email", "keep": ["x", "y"]}])      # `keep` isn't a string-valued key in the example
        assert _normalize_json_ops(self.DESC, other) == other
        assert _normalize_json_ops(self.DESC, "not json") == "not json"


class TestNormalizePipelineConfig:
    ATTRS = {"outputs": {"type": "object"}, "steps": {"type": "array"}}

    def _pick(self, config):
        from app.services.genie_service import GeniePick
        return GeniePick(component_type="agentic_pipeline", asset_name="pr", upstream_asset_names=[], config=config, action="add", reason="r")

    def test_outputs_list_is_wrapped_not_dropped(self):
        from app.services.genie_service import _normalize_pipeline_config
        p = self._pick({"outputs": ["a", "b"]})
        _normalize_pipeline_config(p, self.ATTRS)
        assert p.config["outputs"] == {"assets": ["a", "b"]}

    def test_correct_outputs_are_left_alone(self):
        from app.services.genie_service import _normalize_pipeline_config
        p = self._pick({"outputs": {"assets": ["a"]}})
        assert _normalize_pipeline_config(p, self.ATTRS) == [] and p.config["outputs"] == {"assets": ["a"]}

    def test_invented_github_tool_name_is_replaced_only_for_the_github_server(self):
        from app.services.genie_service import _normalize_pipeline_config
        gh = {"id": "f", "op": "mcp_call", "mcp_tool_name": "get_pull_request_diff",
              "server": {"name": "github", "type": "stdio", "command": ["npx", "-y", "@modelcontextprotocol/server-github"]}}
        other = {"id": "g", "op": "mcp_call", "mcp_tool_name": "get_pull_request_diff",
                 "server": {"name": "x", "type": "stdio", "command": ["npx", "some-other-server"]}}
        p = self._pick({"steps": [gh, other]})
        notes = _normalize_pipeline_config(p, self.ATTRS)
        assert gh["mcp_tool_name"] == "get_pull_request_files" and other["mcp_tool_name"] == "get_pull_request_diff"
        assert len(notes) == 1 and "get_pull_request_files" in notes[0]
