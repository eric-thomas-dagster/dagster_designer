"""Regression tests for the `dg utils inspect-component` description bug.

Confirmed live against a real project (see the progress log in
docs/plans/2026-10-post-processing-and-warehouse-native-inputs.md): `dg
utils inspect-component --defs-yaml-json-schema` drops `description` for
every field that has a `default` value, even though the field's own Python
source (and the community catalog's hand-maintained schema.json) has one.
Required fields (no default) keep their description -- which is why a user
configuring e.g. ChargebeeIngestionComponent saw hints on the first few
fields (asset_name/site/api_key, all required) and nothing on the rest
(resources/destination/..., all optional with defaults).

`_get_component_schema_via_dg` backfills the gap from the component's
installed schema.json, which isn't affected (it's read straight off disk,
never through `dg`'s own schema introspection).
"""
import json
from unittest.mock import patch

import pytest

from app.api import components as components_module
from app.api.components import _find_installed_schema_json, _get_component_schema_via_dg
from app.models.project import Project
from app.services.project_service import project_service


@pytest.fixture(autouse=True)
def clear_dg_schema_cache():
    # `_get_component_schema_via_dg` caches by (project.id, component_type)
    # with a 30s TTL -- several tests below reuse the same project id and
    # component type with different mocked subprocess results, so a stale
    # cache entry would silently mask the very bug being tested for.
    components_module._dg_component_schema_cache.clear()
    yield
    components_module._dg_component_schema_cache.clear()


def _make_project(tmp_path, directory_name="project_test_demo", root_module=None):
    project_dir = tmp_path / directory_name
    project_dir.mkdir(parents=True)
    (project_dir / ".venv" / "bin").mkdir(parents=True)
    (project_dir / ".venv" / "bin" / "dg").write_text("#!/bin/sh\n")

    if root_module:
        (project_dir / "pyproject.toml").write_text(
            f'[tool.dg.project]\nroot_module = "{root_module}"\n'
        )

    project = Project(id="proj1", name="Demo", directory_name=directory_name)
    return project, project_dir


def _write_schema_json(project_dir, module_name, component_id, component_type, attributes):
    component_dir = project_dir / "src" / module_name / "components" / component_id
    component_dir.mkdir(parents=True)
    (component_dir / "schema.json").write_text(json.dumps({
        "component_type": component_type,
        "attributes": attributes,
    }))


@pytest.fixture
def isolated_projects_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(project_service, "projects_dir", tmp_path)
    yield tmp_path


def test_find_installed_schema_json_uses_real_root_module_not_directory_name(isolated_projects_dir):
    """An imported project's real importable module name can differ
    entirely from Designer's own directory_name slug (confirmed live:
    chicago_bulls_analytics vs. directory_name project_91204b8f_bulls) --
    resolution must follow pyproject.toml's root_module, not assume
    src/<directory_name>/."""
    tmp_path = isolated_projects_dir
    project, project_dir = _make_project(tmp_path, directory_name="project_abc_bulls", root_module="chicago_bulls_analytics")
    _write_schema_json(
        project_dir, "chicago_bulls_analytics", "chargebee_ingestion",
        "chicago_bulls_analytics.components.chargebee_ingestion.ChargebeeIngestionComponent",
        {"resources": {"description": "Comma-separated list of resources."}},
    )

    result = _find_installed_schema_json(
        project, "chicago_bulls_analytics.components.chargebee_ingestion.ChargebeeIngestionComponent"
    )
    assert result is not None
    assert result["attributes"]["resources"]["description"] == "Comma-separated list of resources."


def test_find_installed_schema_json_returns_none_when_not_installed(isolated_projects_dir):
    tmp_path = isolated_projects_dir
    project, _ = _make_project(tmp_path)
    result = _find_installed_schema_json(project, "dagster_dbt.DbtProjectComponent")
    assert result is None


def _fake_dg_result(properties: dict, required: list[str]):
    class _Result:
        returncode = 0
        stdout = json.dumps({
            "properties": {
                "attributes": {
                    "properties": properties,
                    "required": required,
                }
            }
        })
        stderr = ""
    return _Result()


def test_backfills_descriptions_dg_dropped_for_defaulted_fields(isolated_projects_dir):
    tmp_path = isolated_projects_dir
    project, project_dir = _make_project(tmp_path, directory_name="project_abc_bulls", root_module="chicago_bulls_analytics")
    component_type = "chicago_bulls_analytics.components.chargebee_ingestion.ChargebeeIngestionComponent"
    _write_schema_json(
        project_dir, "chicago_bulls_analytics", "chargebee_ingestion", component_type,
        {
            "asset_name": {"description": "Name of the asset that will hold the data"},
            "resources": {"description": "Comma-separated list of resources to extract."},
            "destination": {"description": "dlt destination identifier."},
        },
    )

    # Mirrors the real, confirmed `dg` bug: required field (no default)
    # keeps its description; optional fields (with defaults) lose theirs.
    fake_result = _fake_dg_result(
        properties={
            "asset_name": {"type": "string", "description": "Name of the asset that will hold the data"},
            "resources": {"type": "string", "default": "customers,subscriptions,invoices"},
            "destination": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None},
        },
        required=["asset_name"],
    )

    with patch("app.api.components.subprocess.run", return_value=fake_result):
        schema = _get_component_schema_via_dg(project, component_type)

    assert schema is not None
    props = schema.schema["properties"]
    assert props["asset_name"]["description"] == "Name of the asset that will hold the data"
    assert props["resources"]["description"] == "Comma-separated list of resources to extract."
    assert props["destination"]["description"] == "dlt destination identifier."


def test_does_not_overwrite_a_description_dg_actually_provided(isolated_projects_dir):
    tmp_path = isolated_projects_dir
    project, project_dir = _make_project(tmp_path, directory_name="project_abc_bulls", root_module="chicago_bulls_analytics")
    component_type = "chicago_bulls_analytics.components.chargebee_ingestion.ChargebeeIngestionComponent"
    _write_schema_json(
        project_dir, "chicago_bulls_analytics", "chargebee_ingestion", component_type,
        {"resources": {"description": "STALE schema.json description -- should not be used"}},
    )

    fake_result = _fake_dg_result(
        properties={
            "resources": {"type": "string", "default": "x", "description": "live dg description wins"},
        },
        required=[],
    )

    with patch("app.api.components.subprocess.run", return_value=fake_result):
        schema = _get_component_schema_via_dg(project, component_type)

    assert schema.schema["properties"]["resources"]["description"] == "live dg description wins"


def test_backfill_is_a_no_op_when_no_schema_json_installed(isolated_projects_dir):
    """A project's own hand-written component, or a vendored framework
    component (dagster_dbt.*, ...) has no community-catalog schema.json to
    backfill from -- the dg output passes through unchanged rather than
    erroring."""
    tmp_path = isolated_projects_dir
    project, _ = _make_project(tmp_path)
    fake_result = _fake_dg_result(
        properties={"some_field": {"type": "string", "default": "x"}},
        required=[],
    )

    with patch("app.api.components.subprocess.run", return_value=fake_result):
        schema = _get_component_schema_via_dg(project, "dagster_dbt.DbtProjectComponent")

    assert schema is not None
    assert "description" not in schema.schema["properties"]["some_field"]


def test_backfills_enum_and_ui_widget_schema_json_only_carries(isolated_projects_dir):
    """`enum`/`ui:widget` are Designer-catalog UI hints that never exist in
    `dg`'s output at all (not a bug -- a plain `destination: Optional[str]`
    has no Literal/Enum type for `dg` to see), confirmed live: chargebee_
    ingestion's `destination` field rendered as a plain text box instead of
    a picker for exactly this reason, even though the schema.json declares
    the valid choices in prose. Backfill must carry these over too, not
    just description."""
    tmp_path = isolated_projects_dir
    project, project_dir = _make_project(tmp_path, directory_name="project_abc_bulls", root_module="chicago_bulls_analytics")
    component_type = "chicago_bulls_analytics.components.chargebee_ingestion.ChargebeeIngestionComponent"
    _write_schema_json(
        project_dir, "chicago_bulls_analytics", "chargebee_ingestion", component_type,
        {
            "destination": {
                "description": "dlt destination identifier.",
                "enum": ["snowflake", "bigquery", "postgres"],
                "ui:widget": "select",
            },
        },
    )

    fake_result = _fake_dg_result(
        properties={
            "destination": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None},
        },
        required=[],
    )

    with patch("app.api.components.subprocess.run", return_value=fake_result):
        schema = _get_component_schema_via_dg(project, component_type)

    dest = schema.schema["properties"]["destination"]
    assert dest["description"] == "dlt destination identifier."
    assert dest["enum"] == ["snowflake", "bigquery", "postgres"]
    assert dest["ui:widget"] == "select"


def test_backfills_structured_destination_credential_fields(isolated_projects_dir):
    """Same reasoning as the enum test above, for x-dagster-destination-
    fields on destination_credentials_url -- the structured per-field
    credential UI (snowflake: account/username/password/..., postgres:
    host/port/...) that only ever lives in schema.json."""
    tmp_path = isolated_projects_dir
    project, project_dir = _make_project(tmp_path, directory_name="project_abc_bulls", root_module="chicago_bulls_analytics")
    component_type = "chicago_bulls_analytics.components.chargebee_ingestion.ChargebeeIngestionComponent"
    xdf = {
        "trigger_field": "destination",
        "options": {"snowflake": {"fields": [{"name": "account", "required": True}], "template": {"base": "snowflake://{account}"}}},
        "related_env_var_field": "destination_credentials_env_var",
    }
    _write_schema_json(
        project_dir, "chicago_bulls_analytics", "chargebee_ingestion", component_type,
        {"destination_credentials_url": {"x-dagster-destination-fields": xdf}},
    )

    fake_result = _fake_dg_result(
        properties={
            "destination_credentials_url": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": None},
        },
        required=[],
    )

    with patch("app.api.components.subprocess.run", return_value=fake_result):
        schema = _get_component_schema_via_dg(project, component_type)

    assert schema.schema["properties"]["destination_credentials_url"]["x-dagster-destination-fields"] == xdf
