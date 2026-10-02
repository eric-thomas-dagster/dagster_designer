"""Regression tests for _friendly_provider_error -- confirmed live, a raw
provider error response (e.g. Anthropic's 400 "credit balance is too low"
wrapped in {"type":"error","error":{"type":...,"message":...}}) reached the
user as an opaque, unfiltered JSON dump. This turns known error classes
(billing, invalid API key) into a specific, actionable message instead.
"""
from app.services.genie_service import _friendly_provider_error


class TestFriendlyProviderError:
    def test_anthropic_insufficient_credits(self):
        # The exact payload reported live.
        body = (
            '{"type":"error","error":{"type":"invalid_request_error",'
            '"message":"Your credit balance is too low to access the '
            'Anthropic API. Please go to Plans & Billing to upgrade or '
            'purchase credits."},"request_id":"req_011Cfe9BUWCStyGGeqtNAjJL"}'
        )
        msg = _friendly_provider_error("Anthropic", 400, body)
        assert "out of credits" in msg
        assert "console.anthropic.com" in msg

    def test_openai_insufficient_quota(self):
        body = '{"error": {"message": "You exceeded your current quota", "type": "insufficient_quota", "code": "insufficient_quota"}}'
        msg = _friendly_provider_error("OpenAI", 429, body)
        assert "out of credits" in msg
        assert "platform.openai.com" in msg

    def test_invalid_api_key(self):
        body = '{"error": {"message": "Incorrect API key provided", "type": "invalid_request_error", "code": "invalid_api_key"}}'
        msg = _friendly_provider_error("OpenAI", 401, body)
        assert "invalid" in msg.lower()
        assert "Settings" in msg

    def test_anthropic_authentication_error_type(self):
        body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
        msg = _friendly_provider_error("Anthropic", 401, body)
        assert "invalid" in msg.lower()
        assert "Settings" in msg

    def test_unrecognized_error_falls_back_to_extracted_message(self):
        # Still better than the raw wrapper -- just the message, with no
        # special-cased copy since it's not a billing/auth error.
        body = '{"error": {"message": "Something else went wrong", "type": "some_other_error"}}'
        msg = _friendly_provider_error("OpenAI", 500, body)
        assert msg == "OpenAI error 500: Something else went wrong"

    def test_non_json_body_falls_back_to_raw_text(self):
        msg = _friendly_provider_error("Anthropic", 500, "not json at all")
        assert msg == "Anthropic error 500: not json at all"

    def test_long_non_json_body_is_truncated(self):
        body = "x" * 1000
        msg = _friendly_provider_error("Anthropic", 500, body)
        assert len(msg) < 500
