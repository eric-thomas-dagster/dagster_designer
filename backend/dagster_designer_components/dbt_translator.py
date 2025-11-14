"""Custom dbt translator for resolving asset key conflicts.

This translator adds a resource type prefix (models/sources/snapshots/seeds/tests)
to asset keys to prevent conflicts when models and sources share the same name.
"""

from typing import Any, Mapping

from dagster import AssetKey
from dagster_dbt import DagsterDbtTranslator


class ResourceTypePrefixTranslator(DagsterDbtTranslator):
    """Translator that prefixes asset keys with resource type to avoid conflicts.

    This is useful when you have dbt projects where models and sources share names,
    which would otherwise cause duplicate asset key errors in Dagster.

    Example:
        - Model: models/blapi/usage_events.sql -> ['models', 'blapi', 'usage_events']
        - Source: blapi.usage_events -> ['sources', 'blapi', 'usage_events']
    """

    def get_asset_key(self, dbt_resource_props: Mapping[str, Any]) -> AssetKey:
        """Generate asset key with resource type prefix.

        Args:
            dbt_resource_props: Properties of the dbt resource from manifest

        Returns:
            AssetKey with resource type prefix
        """
        # Get the default asset key from the parent class
        default_key = super().get_asset_key(dbt_resource_props)

        # Extract resource type (model, source, snapshot, seed, test, etc.)
        resource_type = dbt_resource_props.get("resource_type", "unknown")

        # Add plural 's' to resource type for consistency: model -> models
        if not resource_type.endswith('s'):
            resource_type = f"{resource_type}s"

        # Prefix the asset key with the resource type
        return default_key.with_prefix(resource_type)
