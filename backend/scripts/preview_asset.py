"""
Script to execute an asset and return its data for preview.
Runs in the project's Python environment to access custom components.
"""
import sys
import json
import traceback
import warnings
from pathlib import Path

# Suppress warnings that would interfere with JSON output
warnings.filterwarnings('ignore')


def create_mock_context():
    """Create a mock context for asset execution."""
    class SimpleMockContext:
        def __init__(self):
            self.log = self.SimpleLogger()
            self.has_partition_key = False
            self.partition_key = None
            self._output_metadata = {}
            self.resources = {}

        def add_output_metadata(self, metadata, output_name=None):
            if output_name:
                self._output_metadata[output_name] = metadata
            else:
                self._output_metadata.update(metadata)

        class SimpleLogger:
            def info(self, msg): pass
            def warning(self, msg): pass
            def error(self, msg): pass
            def debug(self, msg): pass

    return SimpleMockContext()


def execute_asset_dependencies(defs, asset_key: str, executed_results: dict):
    """
    Recursively execute upstream dependencies of an asset.
    Returns a dict of asset_key -> result.
    """
    # Get all assets
    all_assets = []
    if hasattr(defs, 'assets') and defs.assets:
        all_assets.extend(defs.assets)

    # Find the target asset
    target_asset_def = None
    for asset_group in all_assets:
        if hasattr(asset_group, 'keys'):
            for key in asset_group.keys:
                if key.to_user_string() == asset_key or key.to_user_string().replace('/', '_') == asset_key:
                    target_asset_def = asset_group
                    break
        if target_asset_def:
            break

    if not target_asset_def:
        return executed_results

    # Get dependencies
    if hasattr(target_asset_def, 'dependency_keys'):
        dep_keys = target_asset_def.dependency_keys or set()

        # Execute each dependency
        for dep_key in dep_keys:
            dep_key_str = dep_key.to_user_string()

            # Skip if already executed
            if dep_key_str in executed_results:
                continue

            # Recursively execute upstream dependencies first
            execute_asset_dependencies(defs, dep_key_str, executed_results)

            # Find and execute this dependency
            for asset_group in all_assets:
                if hasattr(asset_group, 'keys'):
                    for key in asset_group.keys:
                        if key == dep_key:
                            # Execute the asset
                            try:
                                # Get the function
                                if hasattr(asset_group, 'op'):
                                    func = asset_group.op.compute_fn
                                    # Unwrap DecoratedOpFunction or other wrappers
                                    if hasattr(func, 'decorated_fn'):
                                        func = func.decorated_fn
                                    # Continue unwrapping if there are more layers
                                    while hasattr(func, '__wrapped__'):
                                        func = func.__wrapped__

                                    # Execute with mock context
                                    context = create_mock_context()

                                    # Build kwargs from already executed dependencies
                                    import inspect
                                    sig = inspect.signature(func)
                                    kwargs = {}

                                    for param_name in sig.parameters:
                                        if param_name == 'context':
                                            continue
                                        # Look for this param in executed results
                                        for exec_key, exec_result in executed_results.items():
                                            if param_name == exec_key.replace('/', '_') or param_name == exec_key:
                                                kwargs[param_name] = exec_result
                                                break

                                    result = func(context, **kwargs)
                                    executed_results[dep_key_str] = result
                            except Exception as e:
                                print(f"Warning: Failed to execute dependency {dep_key_str}: {e}")
                            break

    return executed_results


def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "success": False,
            "error": "Usage: python -m scripts.preview_asset <project_module> <asset_key>"
        }))
        sys.exit(1)

    project_module = sys.argv[1]
    asset_key = sys.argv[2]

    try:
        # Import the definitions module
        import importlib
        definitions_module = importlib.import_module(f"{project_module}.definitions")
        defs = definitions_module.defs

        # Find the asset by key
        all_assets = []
        if hasattr(defs, 'assets') and defs.assets:
            all_assets.extend(defs.assets)

        found_asset = None
        asset_def = None

        for asset_group in all_assets:
            if hasattr(asset_group, 'keys'):
                for key in asset_group.keys:
                    key_str = key.to_user_string()
                    if key_str == asset_key or key_str.replace('/', '_') == asset_key:
                        found_asset = key
                        asset_def = asset_group
                        break
            if found_asset:
                break

        if not found_asset:
            print(json.dumps({
                "success": False,
                "error": f"Asset '{asset_key}' not found"
            }))
            sys.exit(1)

        # Execute dependencies first
        executed_results = {}
        execute_asset_dependencies(defs, asset_key, executed_results)

        # Now execute the target asset
        if hasattr(asset_def, 'op'):
            func = asset_def.op.compute_fn

            # Unwrap DecoratedOpFunction or other wrappers
            if hasattr(func, 'decorated_fn'):
                func = func.decorated_fn

            # Continue unwrapping if there are more layers
            while hasattr(func, '__wrapped__'):
                func = func.__wrapped__

            # Create mock context
            context = create_mock_context()

            # Match parameters to executed dependencies
            import inspect
            sig = inspect.signature(func)
            kwargs = {}

            for param_name in sig.parameters:
                if param_name == 'context':
                    continue
                # Look for this param in executed results
                for exec_key, exec_result in executed_results.items():
                    if param_name == exec_key.replace('/', '_') or param_name == exec_key:
                        kwargs[param_name] = exec_result
                        break

            # Execute the asset
            result = func(context, **kwargs)

            # Convert result to JSON-serializable format
            if result is not None:
                import pandas as pd
                if isinstance(result, pd.DataFrame):
                    # Convert DataFrame to dict
                    data = result.to_dict('records')
                    columns = result.columns.tolist()
                    dtypes = {col: str(dtype) for col, dtype in result.dtypes.items()}

                    print(json.dumps({
                        "success": True,
                        "data": data,
                        "columns": columns,
                        "dtypes": dtypes,
                        "row_count": len(result),
                        "column_count": len(columns),
                        "shape": list(result.shape)
                    }))
                else:
                    print(json.dumps({
                        "success": False,
                        "error": f"Asset returned {type(result).__name__}, expected DataFrame"
                    }))
            else:
                print(json.dumps({
                    "success": False,
                    "error": "Asset returned None"
                }))
        else:
            print(json.dumps({
                "success": False,
                "error": "Asset definition has no executable function"
            }))

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"Failed to execute asset: {str(e)}",
            "traceback": traceback.format_exc()
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
