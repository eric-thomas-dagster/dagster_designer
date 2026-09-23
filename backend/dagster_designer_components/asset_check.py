"""Asset check component for Dagster Designer."""

from typing import Optional, Literal

import dagster as dg

from ._check_helpers import asset_key_from_string, latest_materialization_metadata, latest_materialization_timestamp


class AssetCheckComponent(dg.Component, dg.Model, dg.Resolvable):
    """Component for creating asset checks from YAML configuration.

    Reads real signal from the Dagster instance's own event log -- the
    target asset's most recent materialization timestamp (freshness) and
    any metadata it logged (row_count, column_schema for row_count/schema
    checks) -- rather than a hardcoded placeholder result. When an asset's
    IO manager doesn't log the metadata a check needs, the check fails
    with a message saying so instead of silently reporting a pass that
    isn't backed by anything.
    """

    check_name: str
    asset_name: str
    check_type: Literal["row_count", "freshness", "schema", "custom"]
    description: Optional[str] = None
    threshold: Optional[int] = None
    max_age_hours: Optional[int] = None
    column_name: Optional[str] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        """Build Dagster definitions from component parameters."""
        if self.check_type == "row_count":
            check_def = self._create_row_count_check()
        elif self.check_type == "freshness":
            check_def = self._create_freshness_check()
        elif self.check_type == "schema":
            check_def = self._create_schema_check()
        else:
            check_def = self._create_custom_check()

        return dg.Definitions(asset_checks=[check_def])

    def _create_row_count_check(self):
        asset_name = self.asset_name
        asset_key = asset_key_from_string(asset_name)
        threshold = self.threshold if self.threshold is not None else 0
        check_name = self.check_name
        description = self.description

        @dg.asset_check(
            asset=asset_key,
            name=check_name,
            description=description or f"Check row count >= {threshold}",
        )
        def row_count_check(context: dg.AssetCheckExecutionContext):
            metadata = latest_materialization_metadata(context, asset_key)
            row_count = None
            for key in ("dagster/row_count", "row_count", "num_rows"):
                if key in metadata:
                    try:
                        row_count = int(metadata[key])
                    except (TypeError, ValueError):
                        pass
                    break
            if row_count is None:
                return dg.AssetCheckResult(
                    passed=False,
                    description=(
                        f"No row-count metadata found on {asset_name}'s latest materialization "
                        f"(looked for dagster/row_count, row_count, num_rows). Log one of these "
                        f"via MetadataValue.int(...) in the asset's own materialization metadata "
                        f"to make this check real."
                    ),
                )
            return dg.AssetCheckResult(
                passed=row_count >= threshold,
                description=f"{asset_name} has {row_count} rows (threshold {threshold}).",
                metadata={"row_count": row_count, "threshold": threshold},
            )

        return row_count_check

    def _create_freshness_check(self):
        asset_name = self.asset_name
        asset_key = asset_key_from_string(asset_name)
        max_age = self.max_age_hours if self.max_age_hours is not None else 24
        check_name = self.check_name
        description = self.description

        @dg.asset_check(
            asset=asset_key,
            name=check_name,
            description=description or f"Check data is less than {max_age} hours old",
        )
        def freshness_check(context: dg.AssetCheckExecutionContext):
            import time as _time
            ts = latest_materialization_timestamp(context, asset_key)
            if ts is None:
                return dg.AssetCheckResult(
                    passed=False,
                    description=f"{asset_name} has never been materialized.",
                )
            age_hours = (_time.time() - ts) / 3600
            return dg.AssetCheckResult(
                passed=age_hours <= max_age,
                description=f"{asset_name} was last materialized {age_hours:.1f}h ago (max {max_age}h).",
                metadata={"age_hours": age_hours, "max_age_hours": max_age},
            )

        return freshness_check

    def _create_schema_check(self):
        asset_name = self.asset_name
        asset_key = asset_key_from_string(asset_name)
        column_name = self.column_name
        check_name = self.check_name
        description = self.description

        @dg.asset_check(
            asset=asset_key,
            name=check_name,
            description=description or f"Check schema for {asset_name}",
        )
        def schema_check(context: dg.AssetCheckExecutionContext):
            if not column_name:
                return dg.AssetCheckResult(
                    passed=False,
                    description="No column_name configured for this schema check -- set one in the YAML.",
                )
            metadata = latest_materialization_metadata(context, asset_key)
            columns: set[str] = set()
            for key in ("dagster/column_schema", "dagster/table_schema", "column_schema", "table_schema"):
                raw = metadata.get(key)
                if raw is not None and hasattr(raw, "columns"):
                    columns = {c.name for c in raw.columns}
                    break
            if not columns:
                return dg.AssetCheckResult(
                    passed=False,
                    description=(
                        f"No column-schema metadata found on {asset_name}'s latest materialization "
                        f"(looked for dagster/column_schema). Log MetadataValue.table_schema(...) "
                        f"in the asset's own materialization metadata to make this check real."
                    ),
                )
            passed = column_name in columns
            return dg.AssetCheckResult(
                passed=passed,
                description=f"Column '{column_name}' {'found' if passed else 'NOT FOUND'} in {asset_name}'s schema.",
                metadata={"column_name": column_name, "known_columns": sorted(columns)},
            )

        return schema_check

    def _create_custom_check(self):
        asset_name = self.asset_name
        asset_key = asset_key_from_string(asset_name)
        check_name = self.check_name
        description = self.description

        @dg.asset_check(
            asset=asset_key,
            name=check_name,
            description=description or "Custom asset check",
        )
        def custom_check(context: dg.AssetCheckExecutionContext):
            # No default logic exists for "custom" -- fail loudly with a
            # clear message instead of silently reporting a pass that
            # isn't backed by anything. For a real custom check with SQL
            # or Python you write yourself, use a Monitor
            # (EnhancedAssetCheckComponent) instead, or edit this function.
            return dg.AssetCheckResult(
                passed=False,
                description=(
                    "This custom check has no implementation yet. Edit "
                    "_create_custom_check in dagster_designer_components/asset_check.py "
                    "to add real logic, or recreate this check as a Monitor instead."
                ),
            )

        return custom_check
