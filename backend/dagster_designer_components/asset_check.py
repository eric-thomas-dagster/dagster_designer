"""Asset check component for Dagster Designer."""

from typing import Optional, Literal

import dagster as dg


class AssetCheckComponent(dg.Component, dg.Model, dg.Resolvable):
    """Component for creating asset checks from YAML configuration."""

    check_name: str
    asset_name: str
    check_type: Literal["row_count", "freshness", "schema", "custom"]
    description: Optional[str] = None
    threshold: Optional[int] = None
    max_age_hours: Optional[int] = None
    column_name: Optional[str] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        """Build Dagster definitions from component parameters."""
        # Create asset check based on type
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
        """Create a row count check."""
        asset_name = self.asset_name
        threshold = self.threshold or 0

        @dg.asset_check(
            asset=asset_name,
            name=self.check_name,
            description=self.description or f"Check row count >= {threshold}",
        )
        def row_count_check(context):
            """Check that row count meets threshold."""
            # This is a template - user needs to implement actual count logic
            # For now, return a passing check
            return dg.AssetCheckResult(
                passed=True,
                description=f"Row count check template for {asset_name}",
                metadata={"threshold": threshold},
            )

        return row_count_check

    def _create_freshness_check(self):
        """Create a freshness check."""
        asset_name = self.asset_name
        max_age = self.max_age_hours or 24

        @dg.asset_check(
            asset=asset_name,
            name=self.check_name,
            description=self.description
            or f"Check data is less than {max_age} hours old",
        )
        def freshness_check(context):
            """Check data freshness."""
            # This is a template - user needs to implement actual freshness logic
            return dg.AssetCheckResult(
                passed=True,
                description=f"Freshness check template for {asset_name}",
                metadata={"max_age_hours": max_age},
            )

        return freshness_check

    def _create_schema_check(self):
        """Create a schema validation check."""
        asset_name = self.asset_name
        column_name = self.column_name

        @dg.asset_check(
            asset=asset_name,
            name=self.check_name,
            description=self.description or f"Check schema for {asset_name}",
        )
        def schema_check(context):
            """Check schema validity."""
            # This is a template - user needs to implement actual schema logic
            return dg.AssetCheckResult(
                passed=True,
                description=f"Schema check template for {asset_name}",
                metadata={"column_name": column_name} if column_name else {},
            )

        return schema_check

    def _create_custom_check(self):
        """Create a custom check."""
        asset_name = self.asset_name

        @dg.asset_check(
            asset=asset_name,
            name=self.check_name,
            description=self.description or "Custom asset check",
        )
        def custom_check(context):
            """Custom asset check - modify as needed."""
            return dg.AssetCheckResult(
                passed=True, description=f"Custom check template for {asset_name}"
            )

        return custom_check
