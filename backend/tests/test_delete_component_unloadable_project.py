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
