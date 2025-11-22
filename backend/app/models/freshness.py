"""Freshness policy configuration models."""

from typing import Literal
from pydantic import BaseModel, Field


class FreshnessPolicy(BaseModel):
    """Configuration for asset freshness policies."""

    mode: Literal["none", "template", "inline"] = Field(
        "none",
        description="Freshness policy mode: none (disabled), template (use existing), inline (define here)"
    )

    # Template mode
    template_name: str | None = Field(
        None,
        description="Name of the freshness policy template to use (when mode=template)"
    )

    # Inline mode - Maximum lag configuration
    maximum_lag_minutes: int | None = Field(
        60,
        description="Static value for maximum acceptable lag in minutes (when mode=inline)",
    )
    maximum_lag_env_var: str | None = Field(
        None,
        description="Environment variable name for maximum_lag_minutes (when mode=inline with env var)",
    )

    # Inline mode - Cron schedule configuration
    cron_schedule: str | None = Field(
        None,
        description="Static value for expected update cadence (cron) (when mode=inline)",
    )
    cron_env_var: str | None = Field(
        None,
        description="Environment variable name for cron_schedule (when mode=inline with env var)",
    )

    # Backwards compatibility
    enabled: bool = Field(False, description="Deprecated: use mode instead")

    def to_python_code(self, asset_key: str | None = None) -> str:
        """Generate Python code for the freshness policy.

        Args:
            asset_key: Optional asset key for generating asset-specific env var names

        Returns:
            Python code string for dg.FreshnessPolicy(), template reference, or None
        """
        # Handle backwards compatibility
        if self.mode == "none" or (not self.enabled and self.mode == "none"):
            return "None"

        # Template mode - just return the template name reference
        if self.mode == "template" and self.template_name:
            return self.template_name

        # Inline mode - generate FreshnessPolicy code
        if self.mode == "inline" or self.enabled:  # enabled for backwards compatibility
            # Determine lag code - use os.getenv() for env vars
            if self.maximum_lag_env_var:
                default_lag = self.maximum_lag_minutes or 60
                lag_code = f'int(os.getenv("{self.maximum_lag_env_var}", "{default_lag}"))'
            else:
                lag_minutes = self.maximum_lag_minutes or 60
                lag_code = str(lag_minutes)

            # Determine cron code
            cron_code = None
            if self.cron_env_var:
                default_cron = f'"{self.cron_schedule}"' if self.cron_schedule else '"0 */6 * * *"'
                cron_code = f'os.getenv("{self.cron_env_var}", {default_cron})'
            elif self.cron_schedule:
                cron_code = f'"{self.cron_schedule}"'

            # Generate appropriate factory method call
            if cron_code:
                return f"dg.FreshnessPolicy.cron(deadline_cron={cron_code}, lower_bound_delta=timedelta(minutes={lag_code}))"
            else:
                return f"dg.FreshnessPolicy.time_window(fail_window=timedelta(minutes={lag_code}))"

        return "None"

    def to_dict(self) -> dict:
        """Convert to dictionary for storage."""
        return {
            "mode": self.mode,
            "template_name": self.template_name,
            "enabled": self.enabled,
            "maximum_lag_minutes": self.maximum_lag_minutes,
            "maximum_lag_env_var": self.maximum_lag_env_var,
            "cron_schedule": self.cron_schedule,
            "cron_env_var": self.cron_env_var,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "FreshnessPolicy":
        """Create from dictionary."""
        return cls(**data)
