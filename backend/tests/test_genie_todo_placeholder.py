"""Regression test for the ❓-note backstop in plan().

Real incident: the SYSTEM_PROMPT's "ASK RATHER THAN FABRICATE" rule asks
for two things together (mark an unconfigurable field as an obvious TODO,
AND add a matching ❓ clarifying note) -- confirmed live that the LLM can
follow the first half while dropping the second, shipping a plan with an
unmistakable-looking placeholder but zero signal that anything needs the
user's attention. _has_todo_placeholder is the deterministic check plan()
uses to catch that and synthesize a fallback note itself rather than
relying on prompt wording alone.
"""

from app.services.genie_service import GeniePick, _has_todo_placeholder


def _pick(config: dict) -> GeniePick:
    return GeniePick(
        component_type="agentic_pipeline",
        asset_name="support_ticket_triage",
        upstream_asset_names=[],
        config=config,
        reason="test",
    )


class TestHasTodoPlaceholder:
    def test_detects_todo_nested_inside_a_dict_field(self):
        # The real incident shape: source is a nested object, not a flat
        # string field.
        pick = _pick({
            "source": {"kind": "literal", "text": "TODO: Provide initial text input or upstream asset key"},
        })
        assert _has_todo_placeholder([pick]) is True

    def test_detects_todo_nested_inside_a_list_of_dicts(self):
        pick = _pick({
            "steps": [{"id": "classify_urgency", "system_prompt": "TODO: describe the classification"}],
        })
        assert _has_todo_placeholder([pick]) is True

    def test_clean_plan_with_a_real_upstream_asset_is_not_flagged(self):
        pick = _pick({
            "source": {"kind": "upstream_asset", "asset_key": "zendesk_tickets"},
        })
        assert _has_todo_placeholder([pick]) is False

    def test_a_standard_api_key_env_var_is_not_mistaken_for_a_todo(self):
        # Confirmed live: the LLM once mangled this into "TODO_OPENAI_API_KEY"
        # (a separate bug, fixed by narrowing the SYSTEM_PROMPT rule so it
        # never applies to well-known provider API key env vars in the
        # first place) -- but even a real, correct value here must never
        # be flagged by this check just because it doesn't start with "TODO".
        pick = _pick({"steps": [{"api_key_env_var": "OPENAI_API_KEY"}]})
        assert _has_todo_placeholder([pick]) is False

    def test_empty_picks_list_is_not_flagged(self):
        assert _has_todo_placeholder([]) is False

    def test_word_starting_with_todo_but_not_the_placeholder_convention(self):
        # "TODO" is checked as a literal prefix, not a whole-word match --
        # this is intentional (the SYSTEM_PROMPT convention is always
        # "TODO: ..." or "TODO_...", never a word that merely starts the
        # same way coincidentally in real config), documented here so a
        # future reader doesn't "fix" this into a stricter match that
        # would miss "TODO_<field>"-style placeholders.
        pick = _pick({"note": "TODOs are tracked in the issue tracker"})
        assert _has_todo_placeholder([pick]) is True
