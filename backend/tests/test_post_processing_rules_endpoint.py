"""Regression tests for the set_post_processing_rules endpoint -- the
project-wide, selector-based mechanism (AssetPostProcessingRule) that can
apply group_name/owners/tags to MANY assets in one rule, unlike
AssetFieldOverrides which only ever targets a single literal asset key.
Uses an isolated tmp_path project, never the real app's project_service
singleton / on-disk projects.
"""

import pytest
import yaml

from app.api.projects import set_post_processing_rules, SetPostProcessingRulesRequest, AssetPostProcessingRuleRequest
from app.services.project_service import ProjectService, project_service as real_project_service
from app.models.project import Project
from app.models.graph import GraphNode


@pytest.fixture()
def service(tmp_path, monkeypatch):
    svc = ProjectService()
    monkeypatch.setattr(svc, "projects_dir", tmp_path)
    monkeypatch.setattr(real_project_service, "projects_dir", tmp_path)
    return svc


def _make_project(tmp_path, asset_keys=()):
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
async def test_sets_a_selector_based_rule(service, tmp_path):
    project, defs_dir = _make_project(tmp_path)

    await set_post_processing_rules(project.id, SetPostProcessingRulesRequest(rules=[
        AssetPostProcessingRuleRequest(target="tag:critical=true", owners=["team:analytics-eng"]),
    ]))

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "tag:critical=true", "attributes": {"owners": ["team:analytics-eng"]}}
    ]


@pytest.mark.asyncio
async def test_replaces_the_whole_rule_list_each_call(service, tmp_path):
    project, defs_dir = _make_project(tmp_path)

    await set_post_processing_rules(project.id, SetPostProcessingRulesRequest(rules=[
        AssetPostProcessingRuleRequest(target="tag:a=true", group_name="g1"),
        AssetPostProcessingRuleRequest(target="tag:b=true", group_name="g2"),
    ]))
    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert len(content["post_processing"]["assets"]) == 2

    # Replace with just one rule -- the other must be GONE, not merged.
    await set_post_processing_rules(project.id, SetPostProcessingRulesRequest(rules=[
        AssetPostProcessingRuleRequest(target="tag:a=true", group_name="g1"),
    ]))
    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "tag:a=true", "attributes": {"group_name": "g1"}}
    ]


@pytest.mark.asyncio
async def test_empty_rules_list_removes_the_file(service, tmp_path):
    project, defs_dir = _make_project(tmp_path)
    await set_post_processing_rules(project.id, SetPostProcessingRulesRequest(rules=[
        AssetPostProcessingRuleRequest(target="tag:a=true", group_name="g1"),
    ]))
    assert (defs_dir / "defs.yaml").exists()

    await set_post_processing_rules(project.id, SetPostProcessingRulesRequest(rules=[]))
    assert not (defs_dir / "defs.yaml").exists()


@pytest.mark.asyncio
async def test_blank_target_rows_are_dropped(service, tmp_path):
    """The list-editor UI can leave a half-filled new row -- a blank
    target shouldn't become a real (and nonsensical) post_processing
    entry."""
    project, defs_dir = _make_project(tmp_path)

    await set_post_processing_rules(project.id, SetPostProcessingRulesRequest(rules=[
        AssetPostProcessingRuleRequest(target="  ", group_name="should_not_appear"),
        AssetPostProcessingRuleRequest(target="tag:a=true", group_name="g1"),
    ]))

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "tag:a=true", "attributes": {"group_name": "g1"}}
    ]
