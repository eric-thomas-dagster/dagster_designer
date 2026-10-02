"""Regression tests for _write_post_processing_defs_yaml -- replaces the old
custom_lineage.json + hand-rolled Python injection into definitions.py with
a native Dagster post_processing block in the project's root defs.yaml.
Verified by hand (see conversation) that `type: dagster.DefsFolderComponent`
+ `post_processing.assets[]` is a real, generic Dagster mechanism that adds
actual asset dependencies regardless of which component produced the
target/source assets -- these tests check the YAML _write_post_processing_defs_yaml
produces, not Dagster's own loader (already covered by manual verification).
"""

import yaml
import pytest

from app.services.project_service import ProjectService
from app.models.project import Project, CustomLineageEdge, AssetFieldOverrides, AssetPostProcessingRule
from app.models.component import ComponentInstance
from app.models.graph import GraphNode


@pytest.fixture()
def service(tmp_path, monkeypatch):
    svc = ProjectService()
    monkeypatch.setattr(svc, "projects_dir", tmp_path)
    return svc


def _make_project(tmp_path, directory_name="my_proj", custom_lineage=None, components=None,
                   asset_field_overrides=None, known_asset_keys=None, asset_post_processing_rules=None):
    """known_asset_keys populates project.graph.nodes (what
    _write_post_processing_defs_yaml now validates every target/source
    against). Defaults to every source/target/override key actually used
    in this call, so existing tests don't need to separately declare
    "yes, these are real assets" -- pass an explicit (smaller or
    different) set to test the dangling-key-drop behavior itself."""
    project_dir = tmp_path / directory_name
    defs_dir = project_dir / "src" / directory_name / "defs"
    defs_dir.mkdir(parents=True)

    custom_lineage = custom_lineage or []
    asset_field_overrides = asset_field_overrides or {}
    if known_asset_keys is None:
        known_asset_keys = set()
        for edge in custom_lineage:
            known_asset_keys.add(edge.source)
            known_asset_keys.add(edge.target)
        for comp in (components or []):
            for edge in comp.attributes.get('edges', []) if isinstance(comp.attributes, dict) else []:
                if isinstance(edge, dict):
                    known_asset_keys.add(edge.get('source'))
                    known_asset_keys.add(edge.get('target'))
        known_asset_keys.update(asset_field_overrides.keys())
        known_asset_keys.discard(None)

    project = Project(
        id="proj1",
        name="My Proj",
        directory_name=directory_name,
        custom_lineage=custom_lineage,
        components=components or [],
        asset_field_overrides=asset_field_overrides,
        asset_post_processing_rules=asset_post_processing_rules or [],
    )
    project.graph.nodes = [
        GraphNode(id=key, type="asset", data={"asset_key": key}, position={"x": 0, "y": 0}, node_kind="asset")
        for key in known_asset_keys
    ]
    return project, defs_dir


def test_writes_post_processing_block_for_a_single_edge(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="asset_b")],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["type"] == "dagster.DefsFolderComponent"
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_b", "attributes": {"deps": ["asset_a"]}}
    ]


def test_every_written_target_uses_the_key_prefix_not_a_bare_string(service, tmp_path):
    """Confirmed directly against a real dg.load_from_defs_folder: a BARE
    string target that doesn't resolve raises DagsterInvalidSubsetError
    and crashes loading of the entire project, but an explicit `key:`
    prefix degrades gracefully to "matches nothing" for the same
    nonexistent key -- with IDENTICAL behavior to a bare string when the
    key DOES exist. So known_asset_keys validation (tested elsewhere in
    this file) is a nice-to-have (avoids littering defs.yaml with no-op
    entries, gives a clear warning) rather than the only thing standing
    between a stale/renamed asset reference and a crashed project. This
    test guards the structural fix itself, independent of whether
    validation happens to catch a given bad entry."""
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="asset_b")],
        asset_field_overrides={"asset_c": AssetFieldOverrides(group_name="g")},
        known_asset_keys={"asset_a", "asset_b", "asset_c"},
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    targets = [entry["target"] for entry in content["post_processing"]["assets"]]
    assert len(targets) == 2
    assert all(t.startswith("key:") for t in targets)


def test_groups_multiple_sources_for_the_same_target(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[
            CustomLineageEdge(source="asset_a", target="asset_c"),
            CustomLineageEdge(source="asset_b", target="asset_c"),
        ],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_c", "attributes": {"deps": ["asset_a", "asset_b"]}}
    ]


def test_merges_dependency_graph_component_edges(service, tmp_path):
    comp = ComponentInstance(
        id="dep_graph",
        component_type="dagster_component_templates.DependencyGraphComponent",
        label="Dep Graph",
        attributes={"edges": [{"source": "x", "target": "y"}]},
    )
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="asset_b")],
        components=[comp],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    targets = {entry["target"]: entry["attributes"]["deps"] for entry in content["post_processing"]["assets"]}
    assert targets == {"key:asset_b": ["asset_a"], "key:y": ["x"]}


def test_skips_self_loops(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[
            CustomLineageEdge(source="asset_a", target="asset_a"),
            CustomLineageEdge(source="asset_a", target="asset_b"),
        ],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_b", "attributes": {"deps": ["asset_a"]}}
    ]


def test_dbt_model_targets_are_skipped_with_a_warning(service, tmp_path, capsys):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[
            CustomLineageEdge(source="asset_a", target="models/stg_customers"),
            CustomLineageEdge(source="asset_a", target="asset_b"),
        ],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_b", "attributes": {"deps": ["asset_a"]}}
    ]
    assert "Cannot add dependencies to dbt models" in capsys.readouterr().out


def test_no_edges_removes_an_existing_defs_yaml(service, tmp_path):
    project, defs_dir = _make_project(tmp_path, custom_lineage=[])
    (defs_dir / "defs.yaml").write_text("type: dagster.DefsFolderComponent\n")

    service._write_post_processing_defs_yaml(project)

    assert not (defs_dir / "defs.yaml").exists()


def test_add_then_remove_an_edge_updates_defs_yaml_each_time(service, tmp_path):
    """Full add -> remove lifecycle, mirroring what add_custom_lineage /
    remove_custom_lineage actually do: mutate project.custom_lineage, then
    call the writer again. Since the writer always rewrites defs.yaml from
    the CURRENT state of project.custom_lineage (not an append/merge onto
    whatever's already on disk), an edit or removal is reflected correctly
    with no special-cased update path needed."""
    project, defs_dir = _make_project(
        tmp_path, custom_lineage=[],
        known_asset_keys={"asset_a", "asset_b", "asset_c"},
    )

    # Add edge 1
    project.custom_lineage.append(CustomLineageEdge(source="asset_a", target="asset_b"))
    service._write_post_processing_defs_yaml(project)
    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_b", "attributes": {"deps": ["asset_a"]}}
    ]

    # Add edge 2 (different target)
    project.custom_lineage.append(CustomLineageEdge(source="asset_a", target="asset_c"))
    service._write_post_processing_defs_yaml(project)
    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    targets = {e["target"] for e in content["post_processing"]["assets"]}
    assert targets == {"key:asset_b", "key:asset_c"}

    # Remove edge 1 -- same filter remove_custom_lineage applies
    project.custom_lineage = [
        e for e in project.custom_lineage
        if not (e.source == "asset_a" and e.target == "asset_b")
    ]
    service._write_post_processing_defs_yaml(project)
    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_c", "attributes": {"deps": ["asset_a"]}}
    ]

    # Remove the last remaining edge -- file should disappear entirely,
    # not linger with an empty post_processing block.
    project.custom_lineage = []
    service._write_post_processing_defs_yaml(project)
    assert not (defs_dir / "defs.yaml").exists()


def test_changing_an_edges_source_is_reflected_on_rewrite(service, tmp_path):
    """'Changing' lineage (re-pointing a target to a different source) is
    remove-old + add-new in the UI, both going through this same writer --
    confirm the rewrite reflects the NEW source, not a stale merge of both."""
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="asset_b")],
        known_asset_keys={"asset_a", "asset_b", "asset_z"},
    )
    service._write_post_processing_defs_yaml(project)

    # "Change" the edge: asset_b now depends on asset_z instead of asset_a.
    project.custom_lineage = [CustomLineageEdge(source="asset_z", target="asset_b")]
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_b", "attributes": {"deps": ["asset_z"]}}
    ]


def test_field_overrides_write_a_post_processing_entry_alone(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        asset_field_overrides={
            "asset_a": AssetFieldOverrides(group_name="analytics", owners=["team:data@x.com"], tags={"tier": "prod"}),
        },
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_a", "attributes": {
            "group_name": "analytics", "owners": ["team:data@x.com"], "tags": {"tier": "prod"},
        }}
    ]


def test_field_overrides_include_description(service, tmp_path):
    """description was added to AssetFieldOverrides for PropertyPanel's
    asset-metadata editor -- confirmed its old non-dbt save path never
    persisted description anywhere real, just mutated the in-memory graph
    node (overwritten on the next introspection regenerate)."""
    project, defs_dir = _make_project(
        tmp_path,
        asset_field_overrides={"asset_a": AssetFieldOverrides(description="A real description.")},
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_a", "attributes": {"description": "A real description."}}
    ]


def test_field_overrides_include_kinds(service, tmp_path):
    """kinds was added for AssetDetailPage's "Definition" editor migration
    -- confirmed directly against a real Dagster load that kinds via
    post_processing REPLACES (not merges) the asset's own kind tags, so
    callers must seed their edit form from the asset's current kinds
    rather than starting blank."""
    project, defs_dir = _make_project(
        tmp_path,
        asset_field_overrides={"asset_a": AssetFieldOverrides(kinds=["snowflake", "dbt"])},
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_a", "attributes": {"kinds": ["snowflake", "dbt"]}}
    ]


def test_deps_and_field_overrides_for_the_same_target_merge_into_one_entry(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="asset_b")],
        asset_field_overrides={"asset_b": AssetFieldOverrides(group_name="analytics")},
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_b", "attributes": {"deps": ["asset_a"], "group_name": "analytics"}}
    ]


def test_drops_an_edge_whose_target_is_not_a_real_asset(service, tmp_path, capsys):
    """Reproduces a real crash found live: stale lineage data (e.g. from an
    earlier pipeline-template install, or an asset that was renamed/
    removed outside add_custom_lineage/delete_component_instance) can
    reference a target that was never a real asset key. Before this
    defensive check existed, writing that straight into post_processing
    crashed loading of the ENTIRE project with DagsterInvalidSubsetError
    the moment this mechanism went from a no-op to actually being applied
    -- confirmed directly against a real project. The writer must drop it
    instead of trusting project.custom_lineage blindly."""
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[
            CustomLineageEdge(source="asset_a", target="does_not_exist"),
            CustomLineageEdge(source="asset_a", target="asset_b"),
        ],
        known_asset_keys={"asset_a", "asset_b"},  # "does_not_exist" is deliberately NOT a known asset
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:asset_b", "attributes": {"deps": ["asset_a"]}}
    ]
    assert "does_not_exist" in capsys.readouterr().out


def test_drops_an_edge_whose_source_is_not_a_real_asset(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="does_not_exist", target="asset_b")],
        known_asset_keys={"asset_b"},
    )
    service._write_post_processing_defs_yaml(project)

    assert not (defs_dir / "defs.yaml").exists()


def test_drops_a_field_override_for_an_asset_that_is_not_real(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        asset_field_overrides={"does_not_exist": AssetFieldOverrides(group_name="g")},
        known_asset_keys=set(),
    )
    service._write_post_processing_defs_yaml(project)

    assert not (defs_dir / "defs.yaml").exists()


def test_dbt_model_keys_are_always_treated_as_known(service, tmp_path):
    """dbt asset keys aren't reflected as graph.nodes the same way
    component-produced assets are in every caller of this writer, so a
    real dbt model target must not be dropped just because it's absent
    from known_asset_keys -- it's still correctly excluded from `deps`
    specifically (dbt deps come from the manifest), but that's a
    different mechanism (dbt_targets) than the dangling-key check."""
    project, defs_dir = _make_project(
        tmp_path,
        asset_field_overrides={"models/stg_customers": AssetFieldOverrides(group_name="staging")},
        known_asset_keys=set(),
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:models/stg_customers", "attributes": {"group_name": "staging"}}
    ]


def test_field_overrides_are_allowed_on_dbt_targets_unlike_deps(service, tmp_path):
    """deps on a dbt model target are skipped (the restriction stays --
    dbt deps come from the manifest), but group_name/owners/tags are
    Dagster's own documented pattern for per-model dbt customization via
    post_processing, so those must NOT be skipped for the same target."""
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="models/stg_customers")],
        asset_field_overrides={"models/stg_customers": AssetFieldOverrides(group_name="staging")},
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:models/stg_customers", "attributes": {"group_name": "staging"}}
    ]


def test_empty_overrides_values_are_not_written(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        asset_field_overrides={"asset_a": AssetFieldOverrides()},
    )
    service._write_post_processing_defs_yaml(project)

    assert not (defs_dir / "defs.yaml").exists()


def test_removes_stale_custom_lineage_json(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="asset_b")],
    )
    stale = defs_dir / "custom_lineage.json"
    stale.write_text('{"edges": []}')

    service._write_post_processing_defs_yaml(project)

    assert not stale.exists()
    assert (defs_dir / "defs.yaml").exists()


def test_rule_with_real_selector_syntax_is_used_verbatim(service, tmp_path):
    """A target containing ':' or '*' is real Dagster selection syntax --
    used as-is, not key:-prefixed (which would corrupt it, e.g.
    key:tag:critical=true is nonsensical)."""
    project, defs_dir = _make_project(
        tmp_path,
        asset_post_processing_rules=[
            AssetPostProcessingRule(target="tag:critical=true", owners=["team:analytics-eng"]),
        ],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "tag:critical=true", "attributes": {"owners": ["team:analytics-eng"]}}
    ]


def test_rule_with_a_bare_asset_name_gets_the_safety_prefix(service, tmp_path):
    """A rule target with no selector syntax at all is treated as "the
    user just typed an asset name" and gets the same key: safety prefix
    as AssetFieldOverrides -- confirmed directly that a bare string
    target that doesn't resolve crashes the whole project, while key:
    degrades gracefully."""
    project, defs_dir = _make_project(
        tmp_path,
        asset_post_processing_rules=[AssetPostProcessingRule(target="my_asset", group_name="g")],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "key:my_asset", "attributes": {"group_name": "g"}}
    ]


def test_wildcard_rule_target_is_used_verbatim(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        asset_post_processing_rules=[AssetPostProcessingRule(target="*", tags={"reviewed": "true"})],
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assert content["post_processing"]["assets"] == [
        {"target": "*", "attributes": {"tags": {"reviewed": "true"}}}
    ]


def test_rules_coexist_with_deps_and_field_overrides(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        custom_lineage=[CustomLineageEdge(source="asset_a", target="asset_b")],
        asset_field_overrides={"asset_c": AssetFieldOverrides(group_name="analytics")},
        asset_post_processing_rules=[AssetPostProcessingRule(target="tag:critical=true", owners=["x"])],
        known_asset_keys={"asset_a", "asset_b", "asset_c"},
    )
    service._write_post_processing_defs_yaml(project)

    content = yaml.safe_load((defs_dir / "defs.yaml").read_text())
    assets = content["post_processing"]["assets"]
    assert len(assets) == 3
    targets = {a["target"] for a in assets}
    assert targets == {"key:asset_b", "key:asset_c", "tag:critical=true"}


def test_empty_rule_with_no_attributes_is_skipped(service, tmp_path):
    project, defs_dir = _make_project(
        tmp_path,
        asset_post_processing_rules=[AssetPostProcessingRule(target="tag:critical=true")],
    )
    service._write_post_processing_defs_yaml(project)

    assert not (defs_dir / "defs.yaml").exists()
