"""Regression tests for the set_asset_field_overrides endpoint -- validates
against the project's own graph.nodes before writing (same dangling-target
crash risk as add_custom_lineage), then flushes via
_write_post_processing_defs_yaml. Uses an isolated tmp_path project (never
the real app's project_service singleton / on-disk projects) to avoid any
risk of touching real project state.
"""

import pytest
import yaml

from app.api.projects import set_asset_field_overrides, AssetFieldOverridesRequest
from app.services.project_service import ProjectService, project_service as real_project_service
from app.models.project import Project
from app.models.graph import GraphNode


@pytest.fixture()
def service(tmp_path, monkeypatch):
    svc = ProjectService()
    monkeypatch.setattr(svc, "projects_dir", tmp_path)
    # The route handler imports the module-level singleton directly, so
    # patch its storage location for the duration of each test rather than
    # the real app projects directory.
    monkeypatch.setattr(real_project_service, "projects_dir", tmp_path)
    return svc


def _make_project_with_asset_nodes(tmp_path, asset_keys):
    directory_name = "my_proj"
    project_dir = tmp_path / directory_name
    defs_dir = project_dir / "src" / directory_name / "defs"
    defs_dir.mkdir(parents=True)
    nodes = [
        GraphNode(id=key, type="asset", data={"asset_key": key}, position={"x": 0, "y": 0}, node_kind="asset")
        for key in asset_keys
    ]
    project = Project(id="proj1", name="My Proj", directory_name=directory_name)
    project.graph.nodes = nodes
    real_project_service._save_project(project)
    return project, defs_dir


@pytest.mark.asyncio
async def test_rejects_an_unknown_asset_key(service, tmp_path):
    project, _ = _make_project_with_asset_nodes(tmp_path, ["asset_a"])

    with pytest.raises(Exception) as exc_info:
        await set_asset_field_overrides(project.id, "does_not_exist", AssetFieldOverridesRequest(group_name="g"))
    assert "not found in this project" in str(exc_info.value.detail)


@pytest.mark.asyncio
async def test_sets_overrides_for_a_known_asset(service, tmp_path):
    project, defs_dir = _make_project_with_asset_nodes(tmp_path, ["asset_a"])

    await set_asset_field_overrides(
        project.id, "asset_a",
        AssetFieldOverridesRequest(group_name="analytics", owners=["team:x@y.com"], tags={"tier": "prod"}),
    )

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_a", "attributes": {
            "group_name": "analytics", "owners": ["team:x@y.com"], "tags": {"tier": "prod"},
        }}
    ]


@pytest.mark.asyncio
async def test_all_empty_fields_clears_an_existing_override(service, tmp_path):
    project, defs_dir = _make_project_with_asset_nodes(tmp_path, ["asset_a"])
    await set_asset_field_overrides(project.id, "asset_a", AssetFieldOverridesRequest(group_name="analytics"))
    assert (defs_dir / "defs.yaml").exists()

    await set_asset_field_overrides(project.id, "asset_a", AssetFieldOverridesRequest())

    assert not (defs_dir / "defs.yaml").exists()
