"""Regression tests for _parse_clarifying_question -- the structured
"Genie is asking you something" field that replaced the earlier ❓-prefixed
notes convention so the frontend can render it as an actual chat question
(with optional multiple-choice suggestions) instead of a note buried next
to a JSON blob.
"""

from app.services.genie_service import GenieClarifyingQuestion, _parse_clarifying_question


class TestParseClarifyingQuestion:
    def test_parses_a_question_with_options(self):
        parsed = {
            "picks": [],
            "clarifying_question": {
                "question": "Where are support tickets coming from?",
                "options": ["An existing asset", "A file", "A URL/API"],
            },
        }
        result = _parse_clarifying_question(parsed)
        assert result == GenieClarifyingQuestion(
            question="Where are support tickets coming from?",
            options=["An existing asset", "A file", "A URL/API"],
        )

    def test_parses_a_question_with_no_options(self):
        parsed = {"clarifying_question": {"question": "What should the destination table be called?"}}
        result = _parse_clarifying_question(parsed)
        assert result is not None
        assert result.question == "What should the destination table be called?"
        assert result.options is None

    def test_null_clarifying_question_returns_none(self):
        assert _parse_clarifying_question({"clarifying_question": None}) is None

    def test_missing_clarifying_question_key_returns_none(self):
        assert _parse_clarifying_question({"picks": []}) is None

    def test_question_missing_the_question_text_returns_none(self):
        # Malformed -- no usable question text, shouldn't crash or produce
        # a blank question.
        assert _parse_clarifying_question({"clarifying_question": {"options": ["a", "b"]}}) is None

    def test_empty_options_list_is_normalized_to_none(self):
        parsed = {"clarifying_question": {"question": "Which one?", "options": []}}
        result = _parse_clarifying_question(parsed)
        assert result is not None
        assert result.options is None

    def test_non_string_options_are_filtered_not_crashing(self):
        parsed = {"clarifying_question": {"question": "Which one?", "options": ["a", None, 3, "b"]}}
        result = _parse_clarifying_question(parsed)
        assert result is not None
        assert result.options == ["a", "3", "b"]

    def test_options_not_a_list_is_ignored(self):
        parsed = {"clarifying_question": {"question": "Which one?", "options": "not a list"}}
        result = _parse_clarifying_question(parsed)
        assert result is not None
        assert result.options is None
