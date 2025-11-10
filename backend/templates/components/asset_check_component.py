"""Asset check component for Dagster Designer."""

from typing import Optional
from dagster import (
    Component,
    Definitions,
    asset_check,
    AssetCheckResult,
    AssetCheckExecutionContext,
    ComponentLoadContext,
    AssetKey,
)
from dagster.components.resolved.model import Model
from dagster.components.resolved.base import Resolvable


class AssetCheckComponent(Component, Resolvable, Model):
    """Component that creates a Dagster asset check for data quality validation."""

    check_name: str
    asset_name: str
    check_type: str  # "row_count", "freshness", "schema", or "custom"
    description: Optional[str] = None
    threshold: Optional[int] = None
    max_age_hours: Optional[int] = None
    column_name: Optional[str] = None

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the asset check."""
        asset_key = AssetKey(self.asset_name)

        if self.check_type == "row_count":
            @asset_check(
                asset=asset_key,
                name=self.check_name,
                description=self.description or f"Row count check for {self.asset_name}",
            )
            def check_fn(check_context: AssetCheckExecutionContext):
                # Users should implement actual row count logic
                # This is a placeholder
                row_count = 0  # Replace with actual query
                passed = row_count >= (self.threshold or 0)
                return AssetCheckResult(
                    passed=passed,
                    metadata={"row_count": row_count, "threshold": self.threshold},
                )

        elif self.check_type == "freshness":
            @asset_check(
                asset=asset_key,
                name=self.check_name,
                description=self.description or f"Freshness check for {self.asset_name}",
            )
            def check_fn(check_context: AssetCheckExecutionContext):
                # Users should implement actual freshness logic
                # This is a placeholder
                age_hours = 0  # Replace with actual age calculation
                passed = age_hours <= (self.max_age_hours or 24)
                return AssetCheckResult(
                    passed=passed,
                    metadata={"age_hours": age_hours, "max_age_hours": self.max_age_hours},
                )

        elif self.check_type == "schema":
            @asset_check(
                asset=asset_key,
                name=self.check_name,
                description=self.description or f"Schema check for {self.asset_name}",
            )
            def check_fn(check_context: AssetCheckExecutionContext):
                # Users should implement actual schema validation logic
                # This is a placeholder
                passed = True  # Replace with actual schema check
                return AssetCheckResult(
                    passed=passed,
                    metadata={"column_name": self.column_name},
                )

        else:  # custom
            @asset_check(
                asset=asset_key,
                name=self.check_name,
                description=self.description or f"Custom check for {self.asset_name}",
            )
            def check_fn(check_context: AssetCheckExecutionContext):
                # Users should implement their custom check logic here
                passed = True
                return AssetCheckResult(passed=passed)

        return Definitions(asset_checks=[check_fn])
