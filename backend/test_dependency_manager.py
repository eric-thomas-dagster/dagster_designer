#!/usr/bin/env python3
"""Test script for dependency manager."""

import sys
sys.path.insert(0, '/Users/ericthomas/dagster_designer/backend')

from app.services.dependency_manager import dependency_manager

# Test 1: Analyze a component config with single destination
print("=" * 60)
print("Test 1: Single destination")
print("=" * 60)

component_config_single = {
    "asset_name": "shopify_data",
    "destination": "snowflake",
    "snowflake_account": "myaccount",
    "snowflake_database": "analytics",
}

packages = dependency_manager.analyze_component_dependencies(component_config_single)
print(f"✅ Required packages: {packages}")
assert packages == ["dlt[snowflake]"], f"Expected ['dlt[snowflake]'], got {packages}"

# Test 2: Environment routing with multiple destinations
print("\n" + "=" * 60)
print("Test 2: Environment routing with multiple destinations")
print("=" * 60)

component_config_env = {
    "asset_name": "orders_data",
    "use_environment_routing": True,
    "destination_local": "duckdb",
    "destination_branch": "postgres",
    "destination_prod": "snowflake",
}

packages = dependency_manager.analyze_component_dependencies(component_config_env)
print(f"✅ Required packages: {packages}")
expected = ["dlt[duckdb]", "dlt[postgres]", "dlt[snowflake]"]
assert set(packages) == set(expected), f"Expected {expected}, got {packages}"

# Test 3: No destination
print("\n" + "=" * 60)
print("Test 3: No destination")
print("=" * 60)

component_config_none = {
    "asset_name": "local_data",
}

packages = dependency_manager.analyze_component_dependencies(component_config_none)
print(f"✅ Required packages: {packages}")
assert packages == [], f"Expected [], got {packages}"

# Test 4: Multiple components with duplicates
print("\n" + "=" * 60)
print("Test 4: Deduplication")
print("=" * 60)

component_config_dup = {
    "asset_name": "data",
    "destination": "snowflake",
    "use_environment_routing": True,
    "destination_local": "duckdb",
    "destination_branch": "snowflake",  # Duplicate!
    "destination_prod": "snowflake",    # Duplicate!
}

packages = dependency_manager.analyze_component_dependencies(component_config_dup)
print(f"✅ Required packages: {packages}")
# Should be deduplicated
assert packages.count("dlt[snowflake]") == 1, f"Snowflake should appear only once, got {packages}"

print("\n" + "=" * 60)
print("✅ ALL TESTS PASSED!")
print("=" * 60)
