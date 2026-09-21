"""Custom dbt translator for resolving asset key conflicts and surfacing
dbt's semantic layer.

This translator adds a resource type prefix (models/sources/snapshots/seeds/tests)
to asset keys to prevent conflicts when models and sources share the same name.

It also attaches semantic-layer metadata (entities, dimensions, measures) to
whichever dbt model a semantic model is built on top of. dagster-dbt has no
built-in support for this -- semantic_models are a manifest.json section
alongside nodes/sources/exposures, not a "node" themselves, and dagster-dbt's
own asset-building loop explicitly skips them ("skip non-assets, such as
semantic models, metrics, tests, and ephemeral models" -- see
dagster_dbt/asset_utils.py). There is no way to make a semantic model into
its own separate Dagster asset through the standard pipeline; the closest
real integration point is enriching the *underlying model's* own AssetSpec,
via get_asset_spec (which -- unlike get_metadata -- is handed the full
manifest, not just this one resource's own properties, so it can look
semantic_models up at all).
"""

from typing import Any, Mapping, Optional

from dagster import AssetKey, AssetSpec, MetadataValue
from dagster_dbt import DagsterDbtTranslator
from dagster_dbt.dbt_project import DbtProject


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

    def get_asset_spec(
        self,
        manifest: Mapping[str, Any],
        unique_id: str,
        project: Optional["DbtProject"],
    ) -> AssetSpec:
        spec = super().get_asset_spec(manifest, unique_id, project)

        semantic_model = self._semantic_model_for(manifest, unique_id)
        if semantic_model is None:
            return spec

        metadata: dict[str, Any] = {"dbt/semantic_model_name": semantic_model.get("name")}
        if semantic_model.get("description"):
            metadata["dbt/semantic_model_description"] = semantic_model["description"]
        entities = semantic_model.get("entities") or []
        if entities:
            metadata["dbt/semantic_model_entities"] = MetadataValue.json(
                [{"name": e.get("name"), "type": e.get("type")} for e in entities]
            )
        dimensions = semantic_model.get("dimensions") or []
        if dimensions:
            metadata["dbt/semantic_model_dimensions"] = MetadataValue.json(
                [{"name": d.get("name"), "type": d.get("type")} for d in dimensions]
            )
        measures = semantic_model.get("measures") or []
        if measures:
            metadata["dbt/semantic_model_measures"] = MetadataValue.json(
                [{"name": m.get("name"), "agg": m.get("agg")} for m in measures]
            )

        return spec.merge_attributes(metadata=metadata)

    @staticmethod
    def _semantic_model_for(manifest: Mapping[str, Any], unique_id: str) -> Optional[Mapping[str, Any]]:
        """The semantic model (if any) built on top of this dbt resource,
        matched by unique_id appearing in the semantic model's own
        depends_on.nodes -- more reliable than parsing its free-text `model`
        ref string (e.g. "ref('orders')")."""
        for semantic_model in (manifest.get("semantic_models") or {}).values():
            depends_on_nodes = (semantic_model.get("depends_on") or {}).get("nodes") or []
            if unique_id in depends_on_nodes:
                return semantic_model
        return None
