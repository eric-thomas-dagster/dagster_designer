#!/usr/bin/env python3
"""
Helper script to extract config schema and defaults for a Dagster asset.

Usage:
    python -m scripts.show_config <project_module> <asset_key>

Example:
    python -m scripts.show_config project_abc123_my_project my_asset_key
"""
import sys
import json
import importlib
from dagster._config import ConfigType


def serialize_config_type(config_type: ConfigType, max_depth=10, current_depth=0):
    """Convert a ConfigType to JSON-serializable format."""
    if current_depth >= max_depth:
        return {"error": "Max depth reached"}

    result = {
        "kind": config_type.kind.name if hasattr(config_type, 'kind') else None,
        "description": config_type.description if hasattr(config_type, 'description') else None,
    }

    # Handle different config type kinds
    if hasattr(config_type, 'fields'):
        # Shape/Permissive config with fields
        fields_info = {}
        for field_name, field_def in config_type.fields.items():
            field_info = {
                "is_required": field_def.is_required,
                "description": field_def.description if hasattr(field_def, 'description') else None,
            }

            if hasattr(field_def, 'config_type'):
                field_info["config_type"] = serialize_config_type(
                    field_def.config_type,
                    max_depth,
                    current_depth + 1
                )

            # Get default value if available
            if hasattr(field_def, 'default_value'):
                try:
                    field_info["default_value"] = serialize_default(field_def.default_value)
                except Exception:
                    pass

            fields_info[field_name] = field_info

        result["fields"] = fields_info

    elif hasattr(config_type, 'inner_type'):
        # Array or Noneable
        result["inner_type"] = serialize_config_type(
            config_type.inner_type,
            max_depth,
            current_depth + 1
        )

    elif hasattr(config_type, 'key_type') and hasattr(config_type, 'value_type'):
        # Map
        result["key_type"] = serialize_config_type(
            config_type.key_type,
            max_depth,
            current_depth + 1
        )
        result["value_type"] = serialize_config_type(
            config_type.value_type,
            max_depth,
            current_depth + 1
        )

    return result


def serialize_default(config):
    """Convert dagster config default values into JSON serializable objects."""
    if isinstance(config, dict):
        return {k: serialize_default(v) for k, v in config.items()}
    if isinstance(config, list):
        return [serialize_default(v) for v in config]
    if isinstance(config, (str, int, float, bool, type(None))):
        return config
    # For other types, convert to string
    return str(config)


def main():
    if len(sys.argv) != 3:
        print(json.dumps({
            "error": "Usage: python -m scripts.show_config <project_module> <asset_key>"
        }))
        sys.exit(1)

    project_module = sys.argv[1]
    asset_key = sys.argv[2]

    try:
        # Import the project's definitions module
        definitions_module = importlib.import_module(f"{project_module}.definitions")
        defs = definitions_module.defs

        # Get the asset - iterate through asset definitions
        from dagster import AssetKey

        target_asset_key = AssetKey(asset_key.split("/"))
        assets_def = None
        op_def = None

        # Search through all asset definitions
        if hasattr(defs, 'assets') and defs.assets:
            for asset in defs.assets:
                if hasattr(asset, 'keys'):
                    # Multi-asset
                    if target_asset_key in asset.keys:
                        assets_def = asset
                        op_def = asset.node_def if hasattr(asset, 'node_def') else None
                        break
                elif hasattr(asset, 'key'):
                    # Single asset
                    if asset.key == target_asset_key:
                        assets_def = asset
                        op_def = asset.node_def if hasattr(asset, 'node_def') else None
                        break

        if assets_def is None:
            print(json.dumps({
                "asset_key": asset_key,
                "has_config": False,
                "error": "Asset not found"
            }))
            sys.exit(0)

        # Get the config schema from the op definition
        config_schema = None
        if op_def and hasattr(op_def, 'config_schema'):
            config_schema = op_def.config_schema

        if config_schema is None:
            print(json.dumps({
                "asset_key": asset_key,
                "has_config": False,
                "config_schema": None,
                "default_config": None
            }))
        else:
            # Serialize the config schema
            schema_info = serialize_config_type(config_schema.config_type)

            # Extract default config
            default_config = None
            try:
                default_value = config_schema.default_value
                if default_value is not None:
                    default_config = serialize_default(default_value)
            except Exception as e:
                schema_info["default_value_error"] = str(e)

            result = {
                "asset_key": asset_key,
                "has_config": True,
                "config_schema": schema_info,
                "default_config": default_config
            }

            print(json.dumps(result, indent=2))

    except Exception as e:
        import traceback
        print(json.dumps({
            "error": str(e),
            "error_type": type(e).__name__,
            "traceback": traceback.format_exc()
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
