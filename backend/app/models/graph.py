from pydantic import BaseModel, Field
from typing import Any, Literal


class GraphNode(BaseModel):
    """A node in the pipeline graph (can be an asset or a 1:1 component)."""

    id: str = Field(..., description="Unique node ID")
    type: str = Field(..., description="Node type (component, asset)")
    data: dict[str, Any] = Field(..., description="Node data (component config or asset metadata)")
    position: dict[str, float] = Field(..., description="X,Y position")
    node_kind: Literal["asset", "component"] = Field("component", description="Whether this is an asset or component node")
    source_component: str | None = Field(None, description="ID of component that generated this asset (for asset nodes)")


class GraphEdge(BaseModel):
    """An edge connecting nodes in the pipeline graph."""

    id: str = Field(..., description="Unique edge ID")
    source: str = Field(..., description="Source node ID")
    target: str = Field(..., description="Target node ID")
    source_handle: str | None = Field(None, description="Source connection point")
    target_handle: str | None = Field(None, description="Target connection point")
    is_custom: bool = Field(False, description="Whether this edge was manually drawn (custom lineage) vs introspected")
    # Only set on edges served by the large-project ("lazy") graph endpoints: the group each end belongs to, so
    # the client can draw an edge to an asset it hasn't loaded as an edge to that asset's collapsed group.
    source_group: str | None = Field(None, description="Group of the source asset (lazy graph only)")
    target_group: str | None = Field(None, description="Group of the target asset (lazy graph only)")


class PipelineGraph(BaseModel):
    """Complete pipeline graph definition."""

    nodes: list[GraphNode] = Field(default_factory=list, description="Graph nodes")
    edges: list[GraphEdge] = Field(default_factory=list, description="Graph edges")
    viewport: dict[str, Any] | None = Field(None, description="Viewport state (zoom, pan)")
    # Set (never stored) when a large project is served in pieces: the groups and group-to-group edges for the
    # whole catalog, while `nodes`/`edges` hold only the groups the client has loaded. See services/graph_index.py.
    lazy: dict[str, Any] | None = Field(None, description="Large-project summary; nodes/edges are a partial view")
