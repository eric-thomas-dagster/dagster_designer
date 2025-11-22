"""Freshness Policy component for Dagster Designer."""

from typing import Optional

import dagster as dg


class FreshnessPolicyComponent(dg.Component, dg.Model, dg.Resolvable):
    """Component for creating reusable freshness policy definitions from YAML configuration."""

    policy_name: str
    maximum_lag_minutes: Optional[int] = None
    maximum_lag_env_var: Optional[str] = None
    cron_schedule: Optional[str] = None
    cron_env_var: Optional[str] = None
    description: Optional[str] = None

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        """Build Dagster definitions - returns empty since this is just a definition."""
        # Freshness policies are definitions, not executable resources
        # They get referenced by assets, not loaded as standalone definitions
        return dg.Definitions()

    def get_freshness_policy(self) -> dg.FreshnessPolicy:
        """Generate the FreshnessPolicy object for this component."""
        from datetime import timedelta
        import os

        # Get lag minutes from env var or static value
        if self.maximum_lag_env_var:
            default_lag = str(self.maximum_lag_minutes or 60)
            lag_minutes = int(os.getenv(self.maximum_lag_env_var, default_lag))
        else:
            lag_minutes = self.maximum_lag_minutes or 60

        # Determine cron schedule
        cron = None
        if self.cron_env_var:
            default_cron = self.cron_schedule or "0 */6 * * *"
            cron = os.getenv(self.cron_env_var, default_cron)
        elif self.cron_schedule:
            cron = self.cron_schedule

        # Choose appropriate factory method
        if cron:
            # Use cron-based freshness policy
            return dg.FreshnessPolicy.cron(
                deadline_cron=cron,
                lower_bound_delta=timedelta(minutes=lag_minutes)
            )
        else:
            # Use time-window-based freshness policy
            return dg.FreshnessPolicy.time_window(
                fail_window=timedelta(minutes=lag_minutes)
            )

    def to_python_code(self) -> str:
        """Generate Python code string for the freshness policy."""
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
