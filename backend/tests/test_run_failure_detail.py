from types import SimpleNamespace as NS

from scripts.query_local_runs import failure_detail


def _de(event_type, error):
    return NS(event_type_value=event_type, event_specific_data=NS(error=error))


def test_the_root_cause_of_a_failed_step_is_surfaced():
    cause = NS(message="ModuleNotFoundError: No module named 'mcp'\n", cause=None)
    outer = NS(message="dagster._core.errors.DagsterExecutionStepExecutionError: Error occurred while executing op \"p\":\n\n", cause=cause)
    out = failure_detail(_de("STEP_FAILURE", outer))
    assert "No module named 'mcp'" in out


def test_other_events_and_missing_errors_add_nothing():
    assert failure_detail(_de("STEP_START", NS(message="x", cause=None))) == ""
    assert failure_detail(_de("STEP_FAILURE", None)) == ""
    assert failure_detail(None) == ""


def test_repeated_messages_and_long_chains_are_trimmed():
    e = NS(message="boom", cause=NS(message="boom", cause=NS(message="x" * 2000, cause=None)))
    out = failure_detail(_de("RUN_FAILURE", e))
    assert out.startswith("boom <- xxx") and len(out) <= 800
