import asyncio
from types import SimpleNamespace

from app.api import projects as P
from app.models.graph import GraphNode, GraphEdge, PipelineGraph as Graph


def _node(i, comp=None):
    return GraphNode(id=i, type="asset", node_kind="asset", position={"x": 0, "y": 0},
                     data={"asset_key": i, "component_id": comp or i})


def test_delete_succeeds_even_if_project_cannot_load(monkeypatch, tmp_path):
    defs = tmp_path / "src" / "m" / "defs" / "gone"
    defs.mkdir(parents=True); (defs / "defs.yaml").write_text("type: x\n")
    (defs.parent / "kept").mkdir(); (defs.parent / "kept" / "defs.yaml").write_text("type: x\n")   # a live component has its folder
    proj = SimpleNamespace(
        id="p", components=[], custom_lineage=[], asset_field_overrides={},
        graph=Graph(nodes=[_node("gone"), _node("kept")], edges=[GraphEdge(id="e1", source="kept", target="gone"), GraphEdge(id="e2", source="kept", target="kept2")]),
    )
    saved = {}
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: proj)
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: tmp_path)

    def update_project(pid, upd):
        saved["graph"] = upd.graph
        return proj
    monkeypatch.setattr(P.project_service, "update_project", update_project)

    async def boom(*a, **k):
        raise RuntimeError("dg list defs failed with return code 1")
    monkeypatch.setattr(P.asset_introspection_service, "get_assets_for_project_async", boom)
    monkeypatch.setattr(P.asset_introspection_service, "clear_cache", lambda pid: None)

    asyncio.run(P.delete_component_instance("p", "gone"))
    assert not defs.exists()
    assert [n.id for n in saved["graph"].nodes] == ["kept"]
    assert [e.id for e in saved["graph"].edges] == ["e2"]


def test_ghost_assets_of_already_deleted_components_are_dropped_too(monkeypatch, tmp_path):
    """While the project can't load, assets of components deleted earlier (their folders are gone) linger in the stored graph
    and 'come back' after every delete -- a multi-asset component's other nodes too."""
    defs = tmp_path / "src" / "m" / "defs"
    (defs / "kept").mkdir(parents=True); (defs / "kept" / "defs.yaml").write_text("type: x\n")
    (defs / "victim").mkdir(); (defs / "victim" / "defs.yaml").write_text("type: x\n")
    nodes = [_node("victim_a", "victim"), _node("victim_b", "victim"), _node("kept_a", "kept"), _node("ghost_a", "ghost_folder_deleted_earlier")]
    nodes.append(GraphNode(id="stg", type="asset", node_kind="asset", position={"x": 0, "y": 0}, data={"asset_key": "stg", "component_id": None}))
    proj = SimpleNamespace(id="p", components=[], custom_lineage=[], asset_field_overrides={}, graph=Graph(nodes=nodes, edges=[]))
    saved = {}
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: proj)
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: tmp_path)
    monkeypatch.setattr(P.project_service, "update_project", lambda pid, upd: saved.setdefault("graph", upd.graph) and proj)

    async def boom(*a, **k):
        raise RuntimeError("project does not load")
    monkeypatch.setattr(P.asset_introspection_service, "get_assets_for_project_async", boom)
    monkeypatch.setattr(P.asset_introspection_service, "clear_cache", lambda pid: None)
    asyncio.run(P.delete_component_instance("p", "victim"))
    assert sorted(n.id for n in saved["graph"].nodes) == ["kept_a", "stg"]     # both victim assets AND the ghost are gone; dbt-style node kept


def test_deleting_a_pure_ghost_does_not_404(monkeypatch, tmp_path):
    """The ghost's folder AND component entry are already gone (only graph nodes remain) -- that used to 404, so the
    UI's delete silently did nothing and the ghost 'came back'."""
    defs = tmp_path / "src" / "m" / "defs"
    (defs / "kept").mkdir(parents=True); (defs / "kept" / "defs.yaml").write_text("type: x\n")
    nodes = [_node("ghost_a", "ghost_pipeline"), _node("ghost_b", "ghost_pipeline"), _node("kept_a", "kept")]
    proj = SimpleNamespace(id="p", components=[], custom_lineage=[], asset_field_overrides={}, graph=Graph(nodes=nodes, edges=[]))
    saved = {}
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: proj)
    monkeypatch.setattr(P.project_service, "_get_project_dir", lambda p: tmp_path)
    monkeypatch.setattr(P.project_service, "update_project", lambda pid, upd: saved.setdefault("graph", upd.graph) and proj)

    async def boom(*a, **k):
        raise RuntimeError("project does not load")
    monkeypatch.setattr(P.asset_introspection_service, "get_assets_for_project_async", boom)
    monkeypatch.setattr(P.asset_introspection_service, "clear_cache", lambda pid: None)
    asyncio.run(P.delete_component_instance("p", "ghost_pipeline"))
    assert [n.id for n in saved["graph"].nodes] == ["kept_a"]
