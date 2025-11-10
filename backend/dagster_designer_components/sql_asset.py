"""SQL Asset Component - for creating SQL-based assets."""

from typing import Optional
from pydantic import BaseModel
from dagster import asset, Definitions, AssetExecutionContext


class SQLAssetComponentParams(BaseModel):
    """Parameters for SQL Asset Component."""
    asset_name: str
    query: str
    description: Optional[str] = None
    group_name: Optional[str] = None
    io_manager_key: Optional[str] = None
    deps: Optional[list[str]] = None
    owners: Optional[list[str]] = None
    tags: Optional[dict[str, str]] = None


class SQLAssetComponent:
    """Component for creating a SQL asset."""

    params_schema = SQLAssetComponentParams

    def __init__(self, **params):
        self.params = self.params_schema(**params)

    def build_defs(self, context) -> Definitions:
        """Build Dagster definitions for this component."""
        
        # Parse dependencies
        deps_list = self.params.deps or []
        
        # Build the asset decorator parameters
        asset_params = {
            "name": self.params.asset_name,
            "compute_kind": "sql",
        }
        
        if self.params.description:
            asset_params["description"] = self.params.description
        if self.params.group_name:
            asset_params["group_name"] = self.params.group_name
        if self.params.io_manager_key:
            asset_params["io_manager_key"] = self.params.io_manager_key
        if self.params.owners:
            asset_params["owners"] = self.params.owners
        if self.params.tags:
            asset_params["tags"] = self.params.tags
        if deps_list:
            asset_params["deps"] = deps_list

        # Create the asset function with SQL query
        query = self.params.query
        
        @asset(**asset_params)
        def sql_asset_func(context: AssetExecutionContext):
            f"""Custom SQL asset: {self.params.asset_name}"""
            # Execute SQL query using the context's resources
            # This is a placeholder - actual execution depends on your SQL resource setup
            context.log.info(f"Executing SQL query: {query}")
            
            # In a real implementation, you would:
            # result = context.resources.db.execute(query)
            # return result
            
            return {"query": query, "executed": True}
        
        return Definitions(assets=[sql_asset_func])
