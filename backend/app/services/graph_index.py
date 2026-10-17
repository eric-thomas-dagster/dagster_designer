"""Serve a very large project's asset graph in pieces instead of as one giant object.

Why: the stored graph is one JSON object with every asset. At 30k assets that is ~33MB (107MB at 100k) sent, parsed
and held by the browser on every load, although the UI -- which collapses a wide graph into one card per group --
shows a few thousand group cards at a time. Above LAZY_THRESHOLD assets, GET /projects/{id} instead returns:

  * `graph.lazy`: every group (name, size, kinds, whether any asset has checks) and the group-to-group edge counts
  * `graph.nodes` / `graph.edges`: empty -- the client fetches a group's assets (`group_slice`) when it is expanded
    and finds assets by name with `search_assets`.

Smaller projects are untouched. The stored graph itself is never changed by any of this.
"""
from __future__ import annotations

import os
import threading
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from ..models.graph import GraphEdge, GraphNode, PipelineGraph

LAZY_THRESHOLD = int(os.environ.get("DESIGNER_LAZY_THRESHOLD", "5000"))
UNGROUPED = "ungrouped"


def group_of(node: GraphNode) -> str:
    return (node.data or {}).get("group_name") or UNGROUPED


@dataclass
class GraphIndex:
    asset_count: int = 0
    groups: dict[str, dict[str, Any]] = field(default_factory=dict)
    node_by_id: dict[str, GraphNode] = field(default_factory=dict)
    node_group: dict[str, str] = field(default_factory=dict)
    nodes_by_group: dict[str, list[GraphNode]] = field(default_factory=dict)
    edges_by_group: dict[str, list[GraphEdge]] = field(default_factory=dict)
    group_edges: Counter = field(default_factory=Counter)
    other_nodes: list[GraphNode] = field(default_factory=list)  # non-asset nodes (kept in the lazy graph as-is)


def build_index(graph: PipelineGraph) -> GraphIndex:
    idx = GraphIndex()
    for n in graph.nodes:
        if n.node_kind != "asset":
            idx.other_nodes.append(n)
            continue
        g = group_of(n)
        idx.asset_count += 1
        idx.node_by_id[n.id] = n
        idx.node_group[n.id] = g
        idx.nodes_by_group.setdefault(g, []).append(n)
        info = idx.groups.setdefault(g, {"name": g, "count": 0, "kinds": set(), "has_checks": 0, "code_locations": set()})
        info["count"] += 1
        info["kinds"].update((n.data or {}).get("kinds") or [])
        if (n.data or {}).get("checks"):
            info["has_checks"] += 1
        loc = (n.data or {}).get("code_location")
        if loc:
            info["code_locations"].add(loc)
    for e in graph.edges:
        sg, tg = idx.node_group.get(e.source), idx.node_group.get(e.target)
        if sg is None or tg is None:
            continue
        tagged = e.model_copy(update={"source_group": sg, "target_group": tg})
        idx.edges_by_group.setdefault(sg, []).append(tagged)
        if tg != sg:
            idx.edges_by_group.setdefault(tg, []).append(tagged)
            idx.group_edges[(sg, tg)] += 1
    return idx


_cache: dict[str, tuple[Any, GraphIndex]] = {}
_lock = threading.Lock()


def get_index(project_id: str, version: Any, graph) -> GraphIndex:
    """The index for this project, rebuilt only when `version` (the project file's mtime) changes.
    `graph` is a PipelineGraph or a zero-argument callable returning one -- the callable is only invoked on a
    cache miss, so a hit never pays to materialize a 100k-node graph."""
    with _lock:
        hit = _cache.get(project_id)
        if hit and hit[0] == version:
            return hit[1]
    idx = build_index(graph() if callable(graph) else graph)
    with _lock:
        _cache[project_id] = (version, idx)
    return idx


def should_serve_lazily(graph: PipelineGraph, threshold: int | None = None) -> bool:
    t = LAZY_THRESHOLD if threshold is None else threshold
    return sum(1 for n in graph.nodes if n.node_kind == "asset") > t


def lazy_graph(idx: GraphIndex) -> PipelineGraph:
    return PipelineGraph(
        nodes=list(idx.other_nodes),
        edges=[],
        lazy={
            "total_assets": idx.asset_count,
            "groups": [
                {"name": g["name"], "count": g["count"], "kinds": sorted(g["kinds"]), "has_checks": g["has_checks"],
                 "code_locations": sorted(g["code_locations"])}
                for g in sorted(idx.groups.values(), key=lambda x: x["name"])
            ],
            "group_edges": [{"source": s, "target": t, "count": c} for (s, t), c in sorted(idx.group_edges.items())],
        },
    )


def group_slice(idx: GraphIndex, group: str) -> dict[str, Any]:
    """Every asset of `group` in full, and every edge touching it (tagged with each end's group)."""
    return {
        "group": group,
        "nodes": idx.nodes_by_group.get(group, []),
        "edges": idx.edges_by_group.get(group, []),
    }


def search_assets(idx: GraphIndex, q: str = "", group: str | None = None, kind: str | None = None,
                  offset: int = 0, limit: int = 100) -> dict[str, Any]:
    """Page through assets matching a text query (asset key / label / description), a group and a kind."""
    needle = (q or "").strip().lower()
    pool = idx.nodes_by_group.get(group, []) if group else (n for ns in idx.nodes_by_group.values() for n in ns)
    matched: list[GraphNode] = []
    for n in pool:
        d = n.data or {}
        if kind and kind not in (d.get("kinds") or []):
            continue
        if needle and needle not in f"{d.get('asset_key', '')} {d.get('label', '')} {d.get('description', '')}".lower():
            continue
        matched.append(n)
    matched.sort(key=lambda n: str((n.data or {}).get("asset_key") or n.id))
    page = matched[offset: offset + limit]
    return {
        "total": len(matched),
        "offset": offset,
        "rows": [
            {
                "id": n.id,
                "asset_key": (n.data or {}).get("asset_key") or n.id,
                "group_name": group_of(n),
                "kinds": (n.data or {}).get("kinds") or [],
                "description": ((n.data or {}).get("description") or "")[:200],
                "owners": (n.data or {}).get("owners") or [],
                "tags": (n.data or {}).get("tags") or [],
                "checks": len((n.data or {}).get("checks") or []),
                "deps": len((n.data or {}).get("deps") or []),
            }
            for n in page
        ],
    }


def merge_lazy_update(stored: PipelineGraph, incoming: PipelineGraph) -> PipelineGraph:
    """Apply a client's graph update when the client only holds part of a large graph.

    Replacing the stored graph with the client's partial one would delete every asset it never loaded, so instead:
    nodes the client sent replace their stored namesakes (this carries position / config edits for the groups it
    has open), and new custom edges are added. Edges are never removed and nothing the client didn't send is touched."""
    by_id = {n.id: n for n in incoming.nodes if n.node_kind == "asset" or n.node_kind == "component"}
    merged_nodes = [by_id.pop(n.id, n) for n in stored.nodes]
    stored_edge_ids = {e.id for e in stored.edges}
    new_edges = [e.model_copy(update={"source_group": None, "target_group": None})
                 for e in incoming.edges if e.is_custom and e.id not in stored_edge_ids]
    return PipelineGraph(nodes=merged_nodes, edges=list(stored.edges) + new_edges, viewport=incoming.viewport or stored.viewport)


_count_cache: dict[str, tuple[Any, int]] = {}


def count_assets_raw(project_id: str, version: Any, graph_dict: dict) -> int:
    """Asset count straight from the stored JSON dict (no pydantic), cached per project-file version."""
    with _lock:
        hit = _count_cache.get(project_id)
        if hit and hit[0] == version:
            return hit[1]
    n = sum(1 for node in (graph_dict.get("nodes") or []) if node.get("node_kind") == "asset")
    with _lock:
        _count_cache[project_id] = (version, n)
    return n
