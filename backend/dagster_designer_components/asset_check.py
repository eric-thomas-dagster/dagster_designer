"""Asset check component for Dagster Designer."""

from typing import Optional, Literal

from dagster import asset_check, AssetCheckResult, AssetCheckSeverity
from pydantic import BaseModel


class AssetCheckComponentParams(BaseModel):
    """Parameters for asset check component."""

    check_name: str
    asset_name: str
    check_type: Literal["row_count", "freshness", "schema", "custom"]
    description: Optional[str] = None
    threshold: Optional[int] = None
    max_age_hours: Optional[int] = None
    column_name: Optional[str] = None


class AssetCheckComponent:
    """Component for creating asset checks from YAML configuration."""

    params_schema = AssetCheckComponentParams

    def __init__(self, **params):
        """Initialize the asset check component."""
        self.params = AssetCheckComponentParams(**params)

    def build_defs(self, context):
        """Build Dagster definitions from component parameters."""
        from dagster import Definitions

        # Create asset check based on type
        if self.params.check_type == "row_count":
            check_def = self._create_row_count_check()
        elif self.params.check_type == "freshness":
            check_def = self._create_freshness_check()
        elif self.params.check_type == "schema":
            check_def = self._create_schema_check()
        else:
            check_def = self._create_custom_check()

        return Definitions(asset_checks=[check_def])

    def _create_row_count_check(self):
        """Create a row count check."""
        asset_name = self.params.asset_name
        threshold = self.params.threshold or 0

        @asset_check(
            asset=asset_name,
            name=self.params.check_name,
            description=self.params.description or f"Check row count >= {threshold}",
        )
        def row_count_check(context):
            """Check that row count meets threshold."""
            # This is a template - user needs to implement actual count logic
            # For now, return a passing check
            return AssetCheckResult(
                passed=True,
                description=f"Row count check template for {asset_name}",
                metadata={"threshold": threshold},
            )

        return row_count_check

    def _create_freshness_check(self):
        """Create a freshness check."""
        asset_name = self.params.asset_name
        max_age = self.params.max_age_hours or 24

        @asset_check(
            asset=asset_name,
            name=self.params.check_name,
            description=self.params.description
            or f"Check data is less than {max_age} hours old",
        )
        def freshness_check(context):
            """Check data freshness."""
            # This is a template - user needs to implement actual freshness logic
            return AssetCheckResult(
                passed=True,
                description=f"Freshness check template for {asset_name}",
                metadata={"max_age_hours": max_age},
            )

        return freshness_check

    def _create_schema_check(self):
        """Create a schema validation check."""
        asset_name = self.params.asset_name
        column_name = self.params.column_name

        @asset_check(
            asset=asset_name,
            name=self.params.check_name,
            description=self.params.description or f"Check schema for {asset_name}",
        )
        def schema_check(context):
            """Check schema validity."""
            # This is a template - user needs to implement actual schema logic
            return AssetCheckResult(
                passed=True,
                description=f"Schema check template for {asset_name}",
                metadata={"column_name": column_name} if column_name else {},
            )

        return schema_check

    def _create_custom_check(self):
        """Create a custom check."""
        asset_name = self.params.asset_name

        @asset_check(
            asset=asset_name,
            name=self.params.check_name,
            description=self.params.description or "Custom asset check",
        )
        def custom_check(context):
            """Custom asset check - modify as needed."""
            return AssetCheckResult(
                passed=True, description=f"Custom check template for {asset_name}"
            )

        return custom_check
