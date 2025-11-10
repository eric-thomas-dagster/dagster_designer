"""Schedule component for Dagster Designer."""

from typing import Optional

import dagster as dg
from dagster._core.definitions.asset_selection import AssetSelection


class ScheduleComponent(dg.Component, dg.Model, dg.Resolvable):
    """Component for creating schedules from YAML configuration."""

    schedule_name: str
    cron_expression: str
    job_name: Optional[str] = None
    asset_selection: Optional[list[str]] = None
    description: Optional[str] = None
    timezone: str = "UTC"
    default_status: str = "RUNNING"

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        """Build Dagster definitions from component parameters."""
        schedules = []

        # Determine target - either a job name or asset selection
        if self.job_name:
            # Schedule references an existing job by name
            target = self.job_name
        elif self.asset_selection:
            # Create an implicit job from asset selection
            job_name = f"{self.schedule_name}_job"
            asset_sel = AssetSelection.keys(*self.asset_selection)
            target = dg.define_asset_job(
                name=job_name,
                selection=asset_sel,
                description=f"Auto-generated job for {self.schedule_name}",
            )
        else:
            raise ValueError(
                f"Schedule {self.schedule_name} must specify either job_name or asset_selection"
            )

        # Create schedule
        schedule = dg.ScheduleDefinition(
            name=self.schedule_name,
            cron_schedule=self.cron_expression,
            job_name=target if isinstance(target, str) else target.name,
            execution_timezone=self.timezone,
            description=self.description,
            default_status=(
                dg.DefaultScheduleStatus.RUNNING
                if self.default_status == "RUNNING"
                else dg.DefaultScheduleStatus.STOPPED
            ),
        )

        schedules.append(schedule)

        # If we created a job, include it
        jobs = [target] if not isinstance(target, str) else []

        return dg.Definitions(schedules=schedules, jobs=jobs)
