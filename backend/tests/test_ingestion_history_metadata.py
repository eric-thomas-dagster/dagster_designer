"""Regression test for record_event's `metadata` field -- added so real
Dagster metadata (cost_usd, latency_ms, router_reasoning, ...) captured
from a project's local instance (see scripts/extract_run_metadata.py and
the DAGSTER_HOME pinning in projects.py's materialize_assets) actually
round-trips through the JSONL event log instead of being silently
dropped, same failure class as the earlier /install-via-cli and
/templates/manifest field-drop bugs this session found.
"""

from pathlib import Path

from app.services.ingestion_history import read_events, record_event


class TestRecordEventMetadata:
    def test_metadata_round_trips_through_the_log(self, tmp_path: Path):
        metadata = [
            {"label": "classify_urgency__cost_usd", "value": 0.0012, "type": "FloatMetadataValue"},
            {"label": "classify_urgency__router_reasoning", "value": "picked billing", "type": "TextMetadataValue"},
        ]
        record_event(
            tmp_path,
            event_type="materialize",
            asset_key="triage_pipeline_classify_urgency",
            status="success",
            metadata=metadata,
        )
        events = read_events(tmp_path)
        assert len(events) == 1
        assert events[0]["metadata"] == metadata

    def test_no_metadata_key_when_none_given(self, tmp_path: Path):
        # Every OTHER event in this log predates the metadata field -- make
        # sure an event with none doesn't grow a spurious "metadata": null
        # (or similar) that a reader might mistake for "we checked and
        # there's nothing", vs. "this event never carried metadata at all".
        record_event(tmp_path, event_type="preview", asset_key="some_asset", status="success")
        events = read_events(tmp_path)
        assert "metadata" not in events[0]

    def test_empty_metadata_list_is_also_omitted(self, tmp_path: Path):
        record_event(
            tmp_path, event_type="materialize", asset_key="some_asset", status="success", metadata=[],
        )
        events = read_events(tmp_path)
        assert "metadata" not in events[0]
