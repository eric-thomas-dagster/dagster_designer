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


class PipelineGraph(BaseModel):
    """Complete pipeline graph definition."""

    nodes: list[GraphNode] = Field(default_factory=list, description="Graph nodes")
    edges: list[GraphEdge] = Field(default_factory=list, description="Graph edges")
    viewport: dict[str, Any] | None = Field(None, description="Viewport state (zoom, pan)")
