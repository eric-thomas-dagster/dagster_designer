"""Python Asset Component - for creating custom Python-based assets."""

from typing import Optional
from pydantic import BaseModel
from dagster import asset, Definitions, AssetExecutionContext


class PythonAssetComponentParams(BaseModel):
    """Parameters for Python Asset Component."""
    asset_name: str
    description: Optional[str] = None
    group_name: Optional[str] = None
    compute_kind: Optional[str] = "python"
    deps: Optional[list[str]] = None
    code: Optional[str] = None
    owners: Optional[list[str]] = None
    tags: Optional[dict[str, str]] = None


class PythonAssetComponent:
    """Component for creating a Python asset with custom code."""

    params_schema = PythonAssetComponentParams

    def __init__(self, **params):
        self.params = self.params_schema(**params)

    def build_defs(self, context) -> Definitions:
        """Build Dagster definitions for this component."""
        
        # Parse dependencies
        deps_list = self.params.deps or []
        
        # Build the asset decorator parameters
        asset_params = {
            "name": self.params.asset_name,
            "compute_kind": self.params.compute_kind,
        }
        
        if self.params.description:
            asset_params["description"] = self.params.description
        if self.params.group_name:
            asset_params["group_name"] = self.params.group_name
        if self.params.owners:
            asset_params["owners"] = self.params.owners
        if self.params.tags:
            asset_params["tags"] = self.params.tags
        if deps_list:
            asset_params["deps"] = deps_list

        # Create the asset function
        code = self.params.code or "    return {}"
        
        # Build the function dynamically
        func_code = f"""
@asset(**asset_params)
def {self.params.asset_name}_asset(context: AssetExecutionContext):
    \"\"\"Custom Python asset: {self.params.asset_name}\"\"\"
{code}
"""
        
        # Execute the code to create the asset
        local_vars = {
            "asset": asset,
            "asset_params": asset_params,
            "AssetExecutionContext": AssetExecutionContext,
        }
        exec(func_code, local_vars)
        
        created_asset = local_vars[f"{self.params.asset_name}_asset"]
        
        return Definitions(assets=[created_asset])
