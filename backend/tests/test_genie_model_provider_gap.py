"""Regression tests for _model_provider_gap -- the deterministic backstop
that anticipates the single most-repeated config gap in the whole-pipeline
component family (agentic_pipeline & co.): every op (llm_call, synthesize,
route's router + specialists, debate's proposers + arbitrator, ...)
declares its own `model` + `api_key_env_var`, and the LLM has to remember
to TODO-placeholder AND ask about every one of them, not just the first.
See PICK A MODEL/PROVIDER ONCE, APPLY EVERYWHERE in the SYSTEM_PROMPT.
"""

from app.services.genie_service import GeniePick, _model_provider_gap


def _pick(component_type: str, config: dict, action: str = "add") -> GeniePick:
    return GeniePick(
        component_type=component_type,
        asset_name="support_ticket_triage",
        upstream_asset_names=[],
        config=config,
        reason="test",
        action=action,
    )


class TestModelProviderGap:
    def test_missing_model_and_key_var_on_a_step_is_a_gap(self):
        pick = _pick("agentic_pipeline", {"steps": [{"id": "s1", "op": "llm_call"}]})
        assert _model_provider_gap([pick]) is True

    def test_todo_placeholdered_model_is_a_gap(self):
        pick = _pick(
            "agentic_pipeline",
            {"steps": [{"id": "s1", "op": "llm_call", "model": "TODO: pick a model", "api_key_env_var": "TODO_API_KEY"}]},
        )
        assert _model_provider_gap([pick]) is True

    def test_fully_configured_step_is_not_a_gap(self):
        pick = _pick(
            "agentic_pipeline",
            {"steps": [{"id": "s1", "op": "llm_call", "model": "gpt-4o-mini", "api_key_env_var": "OPENAI_API_KEY"}]},
        )
        assert _model_provider_gap([pick]) is False

    def test_gap_nested_inside_route_specialists(self):
        # route's specialists/router are their own nested dicts, each
        # with their own model/api_key_env_var -- the real shape this
        # check exists for, not just a flat top-level field.
        pick = _pick(
            "agentic_pipeline",
            {
                "steps": [
                    {
                        "id": "routed",
                        "op": "route",
                        "router": {"model": "gpt-4o-mini", "api_key_env_var": "OPENAI_API_KEY"},
                        "specialists": [
                            {"name": "technical", "model": "gpt-4o", "api_key_env_var": "OPENAI_API_KEY"},
                            {"name": "general", "model": "TODO: pick a model"},
                        ],
                    }
                ]
            },
        )
        assert _model_provider_gap([pick]) is True

    def test_fully_configured_route_with_specialists_is_not_a_gap(self):
        pick = _pick(
            "agentic_pipeline",
            {
                "steps": [
                    {
                        "id": "routed",
                        "op": "route",
                        "router": {"model": "gpt-4o-mini", "api_key_env_var": "OPENAI_API_KEY"},
                        "specialists": [
                            {"name": "technical", "model": "gpt-4o", "api_key_env_var": "OPENAI_API_KEY"},
                            {"name": "general", "model": "gpt-4o-mini", "api_key_env_var": "OPENAI_API_KEY"},
                        ],
                    }
                ]
            },
        )
        assert _model_provider_gap([pick]) is False

    def test_unrelated_component_with_a_model_field_is_ignored(self):
        # Only the whole-pipeline family is scoped in -- a plain "model"
        # key on some other component's config is not this check's concern.
        pick = _pick("some_other_component", {"model": "gpt-4o-mini"})
        assert _model_provider_gap([pick]) is False

    def test_remove_action_pick_is_ignored(self):
        # A remove pick's config isn't real config to validate.
        pick = _pick("agentic_pipeline", {"steps": [{"model": None}]}, action="remove")
        assert _model_provider_gap([pick]) is False

    def test_empty_picks_list_is_not_a_gap(self):
        assert _model_provider_gap([]) is False
