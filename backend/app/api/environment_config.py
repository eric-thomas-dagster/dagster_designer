"""
Environment-aware configuration resolution for pipeline templates.

This module handles the new multi-environment configuration structure where
users configure all environments at once:

{
  "shared": {
    "ecommerce_platform": "shopify",
    "prediction_period_months": 24
  },
  "environments": {
    "local": {
      "output_destination": "duckdb",
      "shopify_access_token": "test_token"
    },
    "branch": {
      "output_destination": "postgres",
      "shopify_access_token": "staging_token"
    },
    "production": {
      "output_destination": "snowflake",
      "shopify_access_token": "prod_token"
    }
  }
}
"""

import os
from typing import Dict, Any


def get_current_environment() -> str:
    """
    Determine the current environment from environment variables.

    Priority:
    1. DAGSTER_ENVIRONMENT env var
    2. DAGSTER_CLOUD_DEPLOYMENT_NAME presence (indicates branch deployment)
    3. Default to "local"

    Returns:
        "local", "branch", or "production"
    """
    # Check explicit environment variable
    env = os.getenv("DAGSTER_ENVIRONMENT")
    if env in ["local", "branch", "production"]:
        return env

    # Check if we're in Dagster Cloud
    deployment_name = os.getenv("DAGSTER_CLOUD_DEPLOYMENT_NAME")
    if deployment_name:
        # Branch deployments have non-"prod" names
        if deployment_name.lower() in ["prod", "production", "main"]:
            return "production"
        else:
            return "branch"

    # Default to local for development
    return "local"


def resolve_environment_config(pipeline_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Resolve environment-specific configuration to a flat config for the current environment.

    Takes a multi-environment config structure and returns a flat config
    with values for the current environment.

    Args:
        pipeline_config: Configuration with shared + environments structure

    Returns:
        Flat configuration dict with resolved values for current environment
    """
    # Get current environment
    current_env = get_current_environment()
    print(f"[EnvironmentConfig] Current environment: {current_env}")

    # Handle both old (flat) and new (nested) config structures
    if "environments" not in pipeline_config:
        # Old flat structure - return as-is for backward compatibility
        print(f"[EnvironmentConfig] Using flat config structure (legacy)")
        return pipeline_config

    # New nested structure - merge shared + environment-specific
    resolved_config = {}

    # Start with shared config
    if "shared" in pipeline_config:
        resolved_config.update(pipeline_config["shared"])
        print(f"[EnvironmentConfig] Loaded {len(pipeline_config['shared'])} shared parameters")

    # Override with environment-specific config
    if "environments" in pipeline_config and current_env in pipeline_config["environments"]:
        env_config = pipeline_config["environments"][current_env]
        resolved_config.update(env_config)
        print(f"[EnvironmentConfig] Loaded {len(env_config)} {current_env}-specific parameters")
    else:
        print(f"[EnvironmentConfig] Warning: No config found for environment '{current_env}'")

    print(f"[EnvironmentConfig] Resolved to {len(resolved_config)} total parameters")
    return resolved_config


def validate_environment_config(
    pipeline_config: Dict[str, Any],
    pipeline_params: Dict[str, Dict]
) -> tuple[bool, list[str]]:
    """
    Validate that all required environments have necessary configuration.

    Args:
        pipeline_config: User-provided configuration
        pipeline_params: Parameter schema from pipeline template

    Returns:
        Tuple of (is_valid, error_messages)
    """
    errors = []

    # Check if we have environment structure
    if "environments" not in pipeline_config:
        # Old flat structure - validate as single config
        return True, []

    environments = pipeline_config.get("environments", {})
    required_envs = ["local", "branch", "production"]

    # Check each environment has required params
    for env in required_envs:
        if env not in environments:
            errors.append(f"Missing configuration for '{env}' environment")
            continue

        env_config = environments[env]

        # Check for required environment-specific parameters
        for param_name, param_schema in pipeline_params.items():
            if not param_schema.get("environment_specific"):
                continue  # Shared param, checked separately

            if param_schema.get("required"):
                if param_name not in env_config:
                    errors.append(
                        f"Missing required parameter '{param_name}' "
                        f"for '{env}' environment"
                    )

    # Check shared parameters
    shared_config = pipeline_config.get("shared", {})
    for param_name, param_schema in pipeline_params.items():
        if param_schema.get("environment_specific"):
            continue  # Environment-specific, checked above

        if param_schema.get("required"):
            if param_name not in shared_config:
                errors.append(f"Missing required shared parameter '{param_name}'")

    return len(errors) == 0, errors


# Export environment name for use in components
CURRENT_ENVIRONMENT = get_current_environment()
