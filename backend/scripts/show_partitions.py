#!/usr/bin/env python3
"""
Helper script to extract partition definition information for a Dagster asset.

Usage:
    python -m scripts.show_partitions <project_module> <asset_key>

Example:
    python -m scripts.show_partitions project_abc123_my_project my_asset_key
"""
import sys
import json
import importlib
from datetime import datetime


def serialize_partition_def(partitions_def):
    """Convert a partition definition to JSON-serializable format."""
    if partitions_def is None:
        return None

    result = {
        "type": type(partitions_def).__name__,
    }

    # Try to get partition keys (may fail for some partition types)
    try:
        # For time-based partitions, we may need to limit the keys
        keys = list(partitions_def.get_partition_keys())

        # If too many keys (e.g., daily partitions over years), sample them
        if len(keys) > 1000:
            result["partition_keys"] = keys[:100] + keys[-100:]
            result["partition_count"] = len(keys)
            result["sample_note"] = "Showing first 100 and last 100 keys"
        else:
            result["partition_keys"] = keys
            result["partition_count"] = len(keys)
    except Exception as e:
        result["partition_keys_error"] = str(e)
        result["partition_count"] = 0

    # Extract start/end for time-based partitions
    try:
        if hasattr(partitions_def, 'start'):
            start = partitions_def.start
            if hasattr(start, 'isoformat'):
                result["start_date"] = start.isoformat()
            else:
                result["start_date"] = str(start)

        if hasattr(partitions_def, 'end'):
            end = partitions_def.end
            if end and hasattr(end, 'isoformat'):
                result["end_date"] = end.isoformat()
            elif end:
                result["end_date"] = str(end)

        if hasattr(partitions_def, 'cron_schedule'):
            result["cron_schedule"] = partitions_def.cron_schedule

        if hasattr(partitions_def, 'fmt'):
            result["date_format"] = partitions_def.fmt

        if hasattr(partitions_def, 'timezone'):
            result["timezone"] = str(partitions_def.timezone)

    except Exception as e:
        result["metadata_error"] = str(e)

    return result


def main():
    if len(sys.argv) != 3:
        print(json.dumps({
            "error": "Usage: python -m scripts.show_partitions <project_module> <asset_key>"
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
        partitions_def = None

        # Search through all asset definitions
        if hasattr(defs, 'assets') and defs.assets:
            for assets_def in defs.assets:
                if hasattr(assets_def, 'keys'):
                    # Multi-asset
                    if target_asset_key in assets_def.keys:
                        partitions_def = assets_def.partitions_def
                        break
                elif hasattr(assets_def, 'key'):
                    # Single asset
                    if assets_def.key == target_asset_key:
                        partitions_def = assets_def.partitions_def
                        break

        # If not found in assets, check asset specs
        if partitions_def is None and hasattr(defs, 'get_all_asset_specs'):
            for spec in defs.get_all_asset_specs():
                if spec.key == target_asset_key:
                    partitions_def = spec.partitions_def
                    break

        if partitions_def is None:
            print(json.dumps({
                "asset_key": asset_key,
                "is_partitioned": False,
                "partitions_def": None
            }))
        else:
            result = {
                "asset_key": asset_key,
                "is_partitioned": True,
                "partitions_def": serialize_partition_def(partitions_def)
            }
            print(json.dumps(result, indent=2))

    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "error_type": type(e).__name__
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
