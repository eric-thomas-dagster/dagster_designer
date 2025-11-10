from pydantic import BaseModel, Field
from typing import Any


class ComponentSchema(BaseModel):
    """Schema definition for a Dagster component."""

    name: str = Field(..., description="Component class name")
    module: str = Field(..., description="Python module path")
    type: str = Field(..., description="Full component type (module.class)")
    description: str | None = Field(None, description="Component documentation")
    schema: dict[str, Any] = Field(..., description="JSON schema from Pydantic model")
    category: str = Field("custom", description="Component category (dbt, fivetran, etc.)")
    icon: str | None = Field(None, description="Icon identifier for UI")


class ComponentInstance(BaseModel):
    """Instance of a component in a project (particularly for asset factory components)."""

    id: str = Field(..., description="Unique component instance ID")
    component_type: str = Field(..., description="Component type (module.class)")
    label: str = Field(..., description="Display label")
    attributes: dict[str, Any] = Field(default_factory=dict, description="Component configuration")
    translation: dict[str, Any] | None = Field(None, description="Asset translation rules")
    post_processing: dict[str, Any] | None = Field(None, description="Post-processing rules")
    is_asset_factory: bool = Field(True, description="Whether this component generates multiple assets")


class ComponentRegistryResponse(BaseModel):
    """Response containing available components."""

    components: list[ComponentSchema]
    total: int
