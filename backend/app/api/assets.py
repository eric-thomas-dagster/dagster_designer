"""API endpoints for asset operations."""

import sys
import importlib.util
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

from ..services.project_service import project_service

router = APIRouter(prefix="/assets", tags=["assets"])


class AssetDataResponse(BaseModel):
    """Response containing asset data preview."""

    success: bool
    data: list[dict[str, Any]] | None = None
    columns: list[str] | None = None
    dtypes: dict[str, str] | None = None
    shape: tuple[int, int] | None = None
    row_count: int | None = None
    column_count: int | None = None
    error: str | None = None
    sample_limit: int | None = None


@router.get("/{project_id}/{asset_key:path}/preview")
async def preview_asset_data(project_id: str, asset_key: str):
    """
    Execute an asset function and return its dataframe data for preview.

    This directly executes the asset function to get data for local development
    preview, bypassing Dagster's IO manager persistence.

    Args:
        project_id: Project ID
        asset_key: Asset key (can be multi-part like "models/customers")

    Returns:
        Asset data in JSON format suitable for table display
    """
    try:
        # Get project
        project = project_service.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        # Get project directory
        project_dir = project_service._get_project_dir(project)
        if not project_dir.exists():
            raise HTTPException(status_code=404, detail="Project directory not found")

        # Add project src to path
        src_dir = project_dir / "src"
        if not src_dir.exists():
            raise HTTPException(status_code=404, detail="Project src directory not found")

        sys.path.insert(0, str(src_dir))

        try:
            # Import the definitions module
            module_name = project.directory_name
            definitions_module = importlib.import_module(f"{module_name}.definitions")
            defs = definitions_module.defs

            # Find the asset by key
            target_asset_key = asset_key
            found_asset = None
            asset_def = None

            # Get all assets from definitions
            all_assets = []
            if hasattr(defs, 'assets') and defs.assets:
                all_assets.extend(defs.assets)

            # Iterate through all asset definitions
            for assets_def in all_assets:
                # Handle both AssetsDefinition and multi-asset cases
                if hasattr(assets_def, 'keys'):
                    keys = assets_def.keys
                elif hasattr(assets_def, 'key'):
                    keys = [assets_def.key]
                else:
                    continue

                for key in keys:
                    key_str = key.to_user_string()
                    if key_str == target_asset_key:
                        found_asset = key
                        asset_def = assets_def
                        break
                if found_asset:
                    break

            if not found_asset or not asset_def:
                return AssetDataResponse(
                    success=False,
                    error=f"Asset '{asset_key}' not found in project definitions"
                )

            # Check if this asset can be executed directly
            if not hasattr(asset_def, 'op') or not hasattr(asset_def.op, 'compute_fn'):
                return AssetDataResponse(
                    success=False,
                    error="This asset cannot be previewed directly. It may require dependencies or a Dagster context."
                )

            # Get the compute function - handle DecoratedOpFunction
            compute_fn = asset_def.op.compute_fn

            # If it's a DecoratedOpFunction, get the underlying function
            if hasattr(compute_fn, 'decorated_fn'):
                actual_fn = compute_fn.decorated_fn
            else:
                actual_fn = compute_fn

            # Helper function to create mock context
            def create_mock_context():
                class SimpleMockContext:
                    class SimpleLogger:
                        def info(self, msg): pass
                        def warning(self, msg): pass
                        def error(self, msg): pass
                        def debug(self, msg): pass

                    def __init__(self):
                        self.log = self.SimpleLogger()
                        self.run_id = "preview"
                        self.op_execution_context = None
                        # Partition-related attributes for partitioned assets
                        self.has_partition_key = False
                        self.partition_key = None
                        self.asset_partition_key_for_output = lambda x=None: None
                        self._output_metadata = {}

                    def add_output_metadata(self, metadata, output_name=None):
                        """Mock method for adding output metadata."""
                        if output_name:
                            self._output_metadata[output_name] = metadata
                        else:
                            self._output_metadata.update(metadata)

                return SimpleMockContext()

            # Helper function to execute an asset by key
            def execute_asset_by_key(asset_key_to_exec):
                """Recursively execute an asset and return its result."""
                # Find the asset definition
                for assets_def in all_assets:
                    if hasattr(assets_def, 'keys'):
                        keys = assets_def.keys
                    elif hasattr(assets_def, 'key'):
                        keys = [assets_def.key]
                    else:
                        continue

                    for key in keys:
                        if key.to_user_string() == asset_key_to_exec:
                            # Found the dependency asset
                            dep_compute_fn = assets_def.op.compute_fn
                            if hasattr(dep_compute_fn, 'decorated_fn'):
                                dep_actual_fn = dep_compute_fn.decorated_fn
                            else:
                                dep_actual_fn = dep_compute_fn

                            # Execute the dependency
                            import inspect
                            dep_sig = inspect.signature(dep_actual_fn)
                            dep_params = list(dep_sig.parameters.values())

                            # Check if dependency itself has dependencies
                            context_param = None
                            dep_dependency_params = []
                            for p in dep_params:
                                if p.name in ['context', 'ctx']:
                                    context_param = p
                                else:
                                    dep_dependency_params.append(p)

                            # Build args for dependency
                            dep_args = []
                            if context_param:
                                dep_args.append(create_mock_context())

                            # Recursively execute dependencies of this dependency
                            for dep_param in dep_dependency_params:
                                # Find the upstream asset key from the asset's deps
                                if hasattr(assets_def, 'keys_by_input_name'):
                                    dep_key = assets_def.keys_by_input_name.get(dep_param.name)
                                    if dep_key:
                                        dep_result = execute_asset_by_key(dep_key.to_user_string())
                                        dep_args.append(dep_result)

                            return dep_actual_fn(*dep_args)

                raise ValueError(f"Dependency asset '{asset_key_to_exec}' not found")

            # Check parameters and identify dependencies
            import inspect
            sig = inspect.signature(actual_fn)
            params = list(sig.parameters.values())

            # Separate context param from dependency params
            context_param = None
            dependency_params = []
            has_var_keyword = False  # **kwargs
            has_var_positional = False  # *args

            for param in params:
                if param.name in ['context', 'ctx']:
                    context_param = param
                elif param.kind == inspect.Parameter.VAR_KEYWORD:
                    has_var_keyword = True
                    dependency_params.append(param)
                elif param.kind == inspect.Parameter.VAR_POSITIONAL:
                    has_var_positional = True
                else:
                    dependency_params.append(param)

            # Build arguments for the target asset
            args = []
            kwargs = {}

            # Add context if needed
            if context_param:
                args.append(create_mock_context())

            # Execute dependencies and add their results
            if dependency_params:
                print(f"[Asset Preview] Asset '{asset_key}' has {len(dependency_params)} dependencies, executing upstream assets...", flush=True)

                # Get the list of dependency asset keys from the asset definition
                dep_keys = []
                if hasattr(asset_def, 'dependency_asset_keys'):
                    dep_keys = [k.to_user_string() for k in asset_def.dependency_asset_keys]
                elif hasattr(asset_def, 'asset_deps'):
                    for dep_dict in asset_def.asset_deps.values():
                        dep_keys.extend([k.to_user_string() for k in dep_dict])

                print(f"[Asset Preview] Found {len(dep_keys)} dependency keys: {dep_keys}", flush=True)

                for i, dep_param in enumerate(dependency_params):
                    dep_key_str = None

                    # Try method 1: Use keys_by_input_name if available
                    if hasattr(asset_def, 'keys_by_input_name'):
                        dep_asset_key = asset_def.keys_by_input_name.get(dep_param.name)
                        if dep_asset_key:
                            dep_key_str = dep_asset_key.to_user_string()

                    # Try method 2: If single param and single dep, assume they match
                    if not dep_key_str and len(dependency_params) == 1 and len(dep_keys) == 1:
                        dep_key_str = dep_keys[0]
                        print(f"[Asset Preview] Single dependency match: param '{dep_param.name}' -> asset '{dep_key_str}'", flush=True)

                    # Try method 3: Match by index if we have enough deps
                    if not dep_key_str and i < len(dep_keys):
                        dep_key_str = dep_keys[i]
                        print(f"[Asset Preview] Index-based match: param '{dep_param.name}' -> asset '{dep_key_str}'", flush=True)

                    if dep_key_str:
                        print(f"[Asset Preview] Executing upstream asset: {dep_key_str}", flush=True)
                        try:
                            dep_result = execute_asset_by_key(dep_key_str)

                            # If the function uses **kwargs, add as keyword argument
                            # Otherwise add as positional argument
                            if has_var_keyword:
                                # Use the dependency asset key as the kwarg name
                                kwarg_name = dep_key_str.replace('/', '_').replace('-', '_')
                                kwargs[kwarg_name] = dep_result
                                print(f"[Asset Preview] Added dependency as kwarg: {kwarg_name}", flush=True)
                            else:
                                args.append(dep_result)

                            print(f"[Asset Preview] Successfully executed upstream asset: {dep_key_str}", flush=True)
                        except Exception as e:
                            return AssetDataResponse(
                                success=False,
                                error=f"Failed to execute upstream asset '{dep_key_str}': {str(e)}"
                            )
                    else:
                        return AssetDataResponse(
                            success=False,
                            error=f"Could not find upstream asset for dependency parameter '{dep_param.name}'. Available deps: {dep_keys}"
                        )

            # Execute the target asset with all dependencies
            try:
                print(f"[Asset Preview] Executing target asset '{asset_key}' with {len(args)} args and {len(kwargs)} kwargs", flush=True)
                result = actual_fn(*args, **kwargs)
            except Exception as e:
                return AssetDataResponse(
                    success=False,
                    error=f"Failed to execute asset: {str(e)}"
                )

            # Check if result is a dataframe
            has_dataframe = False
            try:
                import pandas as pd
                if isinstance(result, pd.DataFrame):
                    has_dataframe = True
                    df_type = "pandas"
            except ImportError:
                pass

            if not has_dataframe:
                try:
                    import polars as pl
                    if isinstance(result, pl.DataFrame):
                        has_dataframe = True
                        df_type = "polars"
                except ImportError:
                    pass

            if not has_dataframe:
                return AssetDataResponse(
                    success=False,
                    error="Asset does not return a DataFrame (pandas or polars)"
                )

            # Convert dataframe to dict for JSON serialization
            sample_limit = 1000  # Limit rows for performance

            if df_type == "pandas":
                # Limit rows if too large
                if len(result) > sample_limit:
                    sample_df = result.head(sample_limit)
                else:
                    sample_df = result

                # Convert to dict
                data = sample_df.to_dict('records')
                columns = list(sample_df.columns)
                dtypes = {col: str(dtype) for col, dtype in sample_df.dtypes.items()}
                shape = result.shape

            else:  # polars
                # Limit rows if too large
                if len(result) > sample_limit:
                    sample_df = result.head(sample_limit)
                else:
                    sample_df = result

                # Convert to dict
                data = sample_df.to_dicts()
                columns = list(sample_df.columns)
                dtypes = {col: str(dtype) for col, dtype in sample_df.schema.items()}
                shape = result.shape

            return AssetDataResponse(
                success=True,
                data=data,
                columns=columns,
                dtypes=dtypes,
                shape=shape,
                row_count=shape[0],
                column_count=shape[1],
                sample_limit=sample_limit if shape[0] > sample_limit else None
            )

        except ImportError as e:
            return AssetDataResponse(
                success=False,
                error=f"Failed to import project definitions: {str(e)}"
            )
        except Exception as e:
            return AssetDataResponse(
                success=False,
                error=f"Failed to execute asset: {str(e)}"
            )
        finally:
            # Clean up sys.path
            if str(src_dir) in sys.path:
                sys.path.remove(str(src_dir))

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Unexpected error: {str(e)}")
