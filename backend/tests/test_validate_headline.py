"""The validation dialog's red headline must be ONE short line; the full text
belongs in details.validation_error (shown as the formatted Error Details block).
The cached path of POST /validate used to return the whole multi-line stack as
the headline, so it printed twice and buried the AI-fix card."""
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api import projects as projects_api
from app.main import app
from app.services import asset_introspection_service as ais

LONG = (
    "Loading location foo failed:\n\ndagster.components.core.component_tree.ComponentTreeException: Error while loading\n"
    "    ├── dataframe_transformer\n    │   └── src/mod/defs/dataframe_transformer/defs.yaml (error)\n"
    "pydantic_core._pydantic_core.ValidationError: 1 validation error\nfill_na_value\n  Input should be a valid string\n"
)


def test_headline_helper():
    h = projects_api._validation_headline
    assert h(LONG) == projects_api._VALIDATION_HEADLINE            # multi-line -> generic one-liner
    assert h("x" * 500) == projects_api._VALIDATION_HEADLINE       # too long -> generic
    assert h("Validation timed out after 180 seconds") == "Validation timed out after 180 seconds"  # short & specific: kept
    assert h(None) == h("") == projects_api._VALIDATION_HEADLINE


def test_failing_components_extraction():
    got = projects_api._extract_failing_components(LONG.splitlines() + ["File 'src/m/defs/orders/defs.yaml', line 1", "yaml/defs/__init__/defs.yaml"])
    assert "dataframe_transformer" in got and "orders" in got and "__init__" not in got
    assert len(got) == len(set(got))


def test_cached_validate_returns_the_same_shape_as_a_fresh_one(tmp_path, monkeypatch):
    proj = tmp_path / "p"
    (proj / ".venv/bin").mkdir(parents=True)
    (proj / ".venv/bin/dg").write_text("")
    monkeypatch.setattr(projects_api.project_service, "get_project", lambda pid: SimpleNamespace(id=pid))
    monkeypatch.setattr(projects_api.project_service, "_get_project_dir", lambda p: proj)
    ais.record_last_run_result("cv1", False, LONG)
    r = TestClient(app).post("/api/v1/projects/cv1/validate").json()
    assert r["valid"] is False
    assert r["error"] == projects_api._VALIDATION_HEADLINE and "\n" not in r["error"]
    assert r["details"]["validation_error"] == LONG                 # full text still available, once, below
    assert "dataframe_transformer" in r["failing_components"]
    ais._last_run_result.pop("cv1", None)
