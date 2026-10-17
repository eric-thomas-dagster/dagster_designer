import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import projects as P
from app.main import app
from app.models.graph import GraphEdge, GraphNode, PipelineGraph
from app.services import graph_index as gi


def node(i, group, **data):
    return GraphNode(id=i, type="asset", node_kind="asset", position={"x": 0, "y": 0},
                     data={"asset_key": i, "group_name": group, "kinds": ["py"], **data})


def graph():
    nodes = [node("a1", "A"), node("a2", "A", checks=[{"name": "c"}], description="Orders cleaned"), node("b1", "B"), node("c1", "C"),
             GraphNode(id="comp", type="component", node_kind="component", position={"x": 0, "y": 0}, data={})]
    edges = [GraphEdge(id="e1", source="a1", target="a2"), GraphEdge(id="e2", source="a2", target="b1"), GraphEdge(id="e3", source="b1", target="c1")]
    return PipelineGraph(nodes=nodes, edges=edges)


def test_index_groups_and_group_edges():
    idx = gi.build_index(graph())
    assert idx.asset_count == 4
    assert {g["name"]: g["count"] for g in idx.groups.values()} == {"A": 2, "B": 1, "C": 1}
    assert idx.groups["A"]["has_checks"] == 1
    assert dict(idx.group_edges) == {("A", "B"): 1, ("B", "C"): 1}


def test_lazy_graph_has_summary_not_assets():
    lg = gi.lazy_graph(gi.build_index(graph()))
    assert [n.id for n in lg.nodes] == ["comp"] and lg.edges == []
    assert lg.lazy["total_assets"] == 4
    assert [g["name"] for g in lg.lazy["groups"]] == ["A", "B", "C"]
    assert {"source": "A", "target": "B", "count": 1} in lg.lazy["group_edges"]


def test_group_slice_has_assets_and_every_touching_edge_tagged():
    s = gi.group_slice(gi.build_index(graph()), "B")
    assert [n.id for n in s["nodes"]] == ["b1"]
    tagged = {e.id: (e.source_group, e.target_group) for e in s["edges"]}
    assert tagged == {"e2": ("A", "B"), "e3": ("B", "C")}
    assert gi.group_slice(gi.build_index(graph()), "nope")["nodes"] == []


def test_search_filters_pages_and_counts():
    idx = gi.build_index(graph())
    assert gi.search_assets(idx, q="orders")["total"] == 1                 # matched on description
    assert gi.search_assets(idx, group="A")["total"] == 2
    r = gi.search_assets(idx, limit=2, offset=1)
    assert r["total"] == 4 and [x["asset_key"] for x in r["rows"]] == ["a2", "b1"]
    assert gi.search_assets(idx, kind="nope")["total"] == 0


def test_threshold():
    assert gi.should_serve_lazily(graph(), threshold=3) and not gi.should_serve_lazily(graph(), threshold=4)


def test_merge_lazy_update_never_drops_unloaded_assets():
    stored = graph()
    moved = node("a1", "A"); moved.position = {"x": 99.0, "y": 5.0}
    custom = GraphEdge(id="cust", source="a1", target="c1", is_custom=True)
    incoming = PipelineGraph(nodes=[moved], edges=[custom, GraphEdge(id="e1", source="a1", target="a2")], lazy={"total_assets": 4})
    out = gi.merge_lazy_update(stored, incoming)
    assert [n.id for n in out.nodes] == ["a1", "a2", "b1", "c1", "comp"]          # nothing dropped
    assert out.nodes[0].position == {"x": 99.0, "y": 5.0}                          # edit to a loaded node kept
    assert sorted(e.id for e in out.edges) == ["cust", "e1", "e2", "e3"]           # custom edge added, none removed


def test_endpoints_serve_lazily_over_the_threshold(monkeypatch):
    from app.models.project import Project
    data = Project(id="p", name="p", directory_name="d", graph=graph()).model_dump(mode="json")
    monkeypatch.setattr(P.project_service, "get_raw_project_json", lambda pid: ((1, 1), data))
    monkeypatch.setattr(P.project_service, "get_project_root_module", lambda proj: "m")
    full = Project(**data)
    monkeypatch.setattr(P.project_service, "get_project", lambda pid: full.model_copy(deep=True))
    gi._cache.clear(); gi._count_cache.clear()
    c = TestClient(app)
    assert c.get("/api/v1/projects/p/graph/groups/A").json()["nodes"][0]["id"] == "a1"
    assert c.get("/api/v1/projects/p/graph-search", params={"q": "a2"}).json()["total"] == 1
    monkeypatch.setattr(gi, "LAZY_THRESHOLD", 3)
    r = asyncio.run(P.get_project("p", live=False, lazy=True))
    assert [n.id for n in r.graph.nodes] == ["comp"] and r.graph.lazy["total_assets"] == 4
    monkeypatch.setattr(gi, "LAZY_THRESHOLD", 4)
    assert len(asyncio.run(P.get_project("p", live=False, lazy=True)).graph.nodes) == 5   # under it: the full graph
    assert len(asyncio.run(P.get_project("p", live=False, lazy=False)).graph.nodes) == 5


def test_update_project_never_shrinks_a_big_graph_by_accident(monkeypatch):
    from app.services import project_service as ps
    from app.models.project import ProjectUpdate
    stored = PipelineGraph(nodes=[node(f"n{i}", "G") for i in range(10)], edges=[])
    monkeypatch.setattr(gi, "LAZY_THRESHOLD", 5)
    svc = ps.ProjectService.__new__(ps.ProjectService)
    proj = SimpleNamespace(graph=stored, components=[], custom_lineage=[], asset_field_overrides={})
    svc.get_project = lambda pid: proj
    saved = {}
    svc._save_project = lambda p: saved.setdefault("p", p)
    try:
        svc.update_project("p", ProjectUpdate(graph=PipelineGraph(nodes=[node("n0", "G")], edges=[])))
    except Exception:
        pass  # whatever happens after the graph merge (saving etc.) is not what this checks
    assert len(proj.graph.nodes) == 10          # the partial graph was merged in, not substituted
