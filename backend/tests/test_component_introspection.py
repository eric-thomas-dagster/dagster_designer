"""Reading field descriptions and UI hints from the component class instead of from a hand-maintained schema.json.

`dg utils inspect-component --defs-yaml-json-schema` drops the description of every field with a default and ignores class-level
metadata. scripts/inspect_component.py reads both off the Pydantic model, and _get_component_schema_via_dg merges them in, so a
component works fully with no schema.json at all.
"""
import asyncio
import json
import subprocess
import sys
import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest

from app.api import components as components_module
from app.api.components import _apply_introspected_fields, _get_component_schema_via_dg
from app.models.project import Project
from app.services.project_service import project_service

BACKEND_DIR = Path(__file__).resolve().parent.parent

PROBE_MODULE = textwrap.dedent('''
    from typing import Literal, Optional

    from pydantic import BaseModel, ConfigDict, Field


    class Probe(BaseModel):
        model_config = ConfigDict(json_schema_extra={"x-dagster-io": {"outputs": {"type": "dataframe"}}, "internal": 1})

        asset_name: str = Field(description="required, no default")
        mode: Literal["fast", "thorough"] = Field(default="fast", description="has a default")
        note: Optional[str] = Field(default=None, description="optional")
        model_id: str = Field(alias="model", default="gpt-4o", description="aliased in YAML")
        body: str = Field(
            default="",
            description="with hints",
            json_schema_extra={"ui:widget": "textarea", "x-dagster-visible-when": {"field": "mode", "values": ["thorough"]}, "unrelated": 5},
        )
        bare: int = 3


    class NotPydantic:
        pass
''')


def _run_script(tmp_path, component_type):
    (tmp_path / "introprobe.py").write_text(PROBE_MODULE)
    result = subprocess.run(
        [sys.executable, "-m", "scripts.inspect_component", component_type],
        cwd=BACKEND_DIR, capture_output=True, text=True, env={"PYTHONPATH": str(tmp_path), "PATH": "/usr/bin:/bin"},
    )
    return json.loads(result.stdout.strip().splitlines()[-1])


# --- the script ---------------------------------------------------------------------------------------------------------

def test_descriptions_are_kept_for_fields_with_and_without_defaults(tmp_path):
    info = _run_script(tmp_path, "introprobe.Probe")
    assert info["success"] is True
    descriptions = {name: f["description"] for name, f in info["fields"].items()}
    assert descriptions["asset_name"] == "required, no default"
    assert descriptions["mode"] == "has a default"
    assert descriptions["note"] == "optional"
    assert descriptions["bare"] is None


def test_the_yaml_key_is_the_alias_when_there_is_one(tmp_path):
    info = _run_script(tmp_path, "introprobe.Probe")
    assert "model" in info["fields"] and "model_id" not in info["fields"]
    assert info["fields"]["model"]["description"] == "aliased in YAML"


def test_only_ui_hints_are_carried_over(tmp_path):
    info = _run_script(tmp_path, "introprobe.Probe")
    assert info["fields"]["body"]["extras"] == {
        "ui:widget": "textarea",
        "x-dagster-visible-when": {"field": "mode", "values": ["thorough"]},
    }
    assert info["class_extras"] == {"x-dagster-io": {"outputs": {"type": "dataframe"}}}


def test_a_class_that_is_not_a_model_has_no_fields_but_succeeds(tmp_path):
    info = _run_script(tmp_path, "introprobe.NotPydantic")
    assert info == {"success": True, "fields": {}, "class_extras": {}}


@pytest.mark.parametrize("component_type", ["introprobe.Missing", "no_such_module.Thing", "nodots"])
def test_unreadable_components_report_failure_instead_of_crashing(tmp_path, component_type):
    assert _run_script(tmp_path, component_type)["success"] is False


def test_works_on_a_real_dagster_component_class(tmp_path):
    (tmp_path / "realcomp.py").write_text(textwrap.dedent('''
        import dagster as dg
        from pydantic import Field

        class RealComponent(dg.Component, dg.Model, dg.Resolvable):
            name: str = Field(default="x", description="a defaulted field on a real component")

            def build_defs(self, context):
                return dg.Definitions()
    '''))
    info = _run_script(tmp_path, "realcomp.RealComponent")
    assert info["fields"]["name"]["description"] == "a defaulted field on a real component"


# --- merging ------------------------------------------------------------------------------------------------------------

def _info(**fields):
    return {"success": True, "fields": fields, "class_extras": {}}


def test_fills_missing_descriptions_and_hints_without_overwriting_dg():
    schema = {"properties": {
        "a": {"type": "string", "default": "x"},
        "b": {"type": "string", "description": "from dg", "ui:widget": "dg-widget"},
    }}
    _apply_introspected_fields(schema, _info(
        a={"description": "from class", "extras": {"ui:widget": "textarea"}},
        b={"description": "from class", "extras": {"ui:widget": "class-widget", "x-new": 1}},
    ))
    assert schema["properties"]["a"] == {"type": "string", "default": "x", "description": "from class", "ui:widget": "textarea"}
    assert schema["properties"]["b"]["description"] == "from dg"
    assert schema["properties"]["b"]["ui:widget"] == "dg-widget"
    assert schema["properties"]["b"]["x-new"] == 1


def test_class_level_hints_go_to_the_top_of_the_schema_without_replacing_existing_ones():
    schema = {"properties": {}, "x-dagster-io": {"existing": True}}
    _apply_introspected_fields(schema, {"success": True, "fields": {}, "class_extras": {"x-dagster-io": {"new": 1}, "x-other": 2}})
    assert schema["x-dagster-io"] == {"existing": True}
    assert schema["x-other"] == 2


@pytest.mark.parametrize("info", [None, {}, {"success": False, "error": "boom"}])
def test_nothing_changes_when_introspection_failed(info):
    schema = {"properties": {"a": {"type": "string"}}}
    _apply_introspected_fields(schema, info)
    assert schema == {"properties": {"a": {"type": "string"}}}


def test_unknown_fields_and_non_dict_properties_are_ignored():
    schema = {"properties": {"a": "not a dict"}}
    _apply_introspected_fields(schema, _info(a={"description": "x", "extras": {}}, ghost={"description": "y", "extras": {}}))
    assert schema == {"properties": {"a": "not a dict"}}


# --- end to end through _get_component_schema_via_dg ----------------------------------------------------------------------

@pytest.fixture(autouse=True)
def clear_cache():
    components_module._dg_component_schema_cache.clear()
    yield
    components_module._dg_component_schema_cache.clear()


def _project(tmp_path, monkeypatch):
    monkeypatch.setattr(project_service, "projects_dir", tmp_path)
    project_dir = tmp_path / "project_demo"
    for exe in ("dg", "python"):
        (project_dir / ".venv" / "bin").mkdir(parents=True, exist_ok=True)
        (project_dir / ".venv" / "bin" / exe).write_text("#!/bin/sh\n")
    return Project(id="p1", name="Demo", directory_name="project_demo"), project_dir


class _Result:
    def __init__(self, payload):
        self.returncode, self.stdout, self.stderr = 0, json.dumps(payload), ""


def _fake_run(introspection):
    dg = {"properties": {"attributes": {"properties": {
        "asset_name": {"type": "string", "description": "dg kept this one"},
        "resources": {"type": "string", "default": "a,b"},
    }, "required": ["asset_name"]}}}

    def run(cmd, **kwargs):
        return _Result(introspection if "scripts.inspect_component" in cmd else dg)

    return run


COMPONENT = "demo.components.thing.ThingComponent"


def test_descriptions_appear_with_no_schema_json_at_all(tmp_path, monkeypatch):
    project, _ = _project(tmp_path, monkeypatch)
    info = {"success": True, "fields": {"resources": {"description": "from the class", "extras": {"ui:widget": "textarea"}}},
            "class_extras": {"x-dagster-io": {"outputs": {"type": "dataframe"}}}}
    with patch("app.api.components.subprocess.run", side_effect=_fake_run(info)):
        schema = asyncio.run(_get_component_schema_via_dg(project, COMPONENT)).schema
    assert schema["properties"]["resources"]["description"] == "from the class"
    assert schema["properties"]["resources"]["ui:widget"] == "textarea"
    assert schema["properties"]["asset_name"]["description"] == "dg kept this one"
    assert schema["x-dagster-io"] == {"outputs": {"type": "dataframe"}}


def test_the_class_wins_over_a_stale_schema_json_and_schema_json_still_fills_the_rest(tmp_path, monkeypatch):
    project, project_dir = _project(tmp_path, monkeypatch)
    component_dir = project_dir / "src" / "demo" / "components" / "thing"
    component_dir.mkdir(parents=True)
    (component_dir / "schema.json").write_text(json.dumps({"attributes": {
        "resources": {"description": "STALE hand-copied text"},
        "asset_name": {"description": "irrelevant"},
    }}))
    (project_dir / "pyproject.toml").write_text('[tool.dg.project]\nroot_module = "demo"\n')
    info = {"success": True, "fields": {"resources": {"description": "from the class", "extras": {}}}, "class_extras": {}}
    with patch("app.api.components.subprocess.run", side_effect=_fake_run(info)):
        schema = asyncio.run(_get_component_schema_via_dg(project, COMPONENT)).schema
    assert schema["properties"]["resources"]["description"] == "from the class"


def test_a_failed_introspection_falls_back_to_schema_json_exactly_as_before(tmp_path, monkeypatch):
    project, project_dir = _project(tmp_path, monkeypatch)
    component_dir = project_dir / "src" / "demo" / "components" / "thing"
    component_dir.mkdir(parents=True)
    (component_dir / "schema.json").write_text(json.dumps({"attributes": {"resources": {"description": "from schema.json"}}}))
    (project_dir / "pyproject.toml").write_text('[tool.dg.project]\nroot_module = "demo"\n')
    with patch("app.api.components.subprocess.run", side_effect=_fake_run({"success": False, "error": "ImportError"})):
        schema = asyncio.run(_get_component_schema_via_dg(project, COMPONENT)).schema
    assert schema["properties"]["resources"]["description"] == "from schema.json"
