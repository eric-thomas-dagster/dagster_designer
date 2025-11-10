"""Schedule component for Dagster Designer."""

from typing import Any, Optional, Sequence
from dagster import (
    Component,
    Definitions,
    ScheduleDefinition,
    AssetSelection,
    ComponentLoadContext,
    RunRequest,
    ScheduleEvaluationContext,
    define_asset_job,
)
from dagster.components.resolved.model import Model
from dagster.components.resolved.base import Resolvable


class ScheduleComponent(Component, Resolvable, Model):
    """Component that creates a Dagster schedule for running jobs or assets on a cron schedule."""

    schedule_name: str
    cron_expression: str
    job_name: Optional[str] = None
    asset_selection: Optional[Sequence[str]] = None
    description: Optional[str] = None
    timezone: str = "UTC"
    default_status: str = "RUNNING"

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the schedule."""
        job = None

        # If job_name is provided, schedule will target that job
        # Otherwise, create an implicit job from asset_selection
        if not self.job_name and self.asset_selection:
            # Create an implicit job for the schedule
            selection = AssetSelection.keys(*self.asset_selection)
            job = define_asset_job(
                name=f"{self.schedule_name}_job",
                selection=selection,
            )

        # Create the schedule
        if job:
            # Schedule with implicit job
            schedule = ScheduleDefinition(
                name=self.schedule_name,
                cron_schedule=self.cron_expression,
                job=job,
                description=self.description,
                default_status=self.default_status,
                timezone=self.timezone,
            )
            return Definitions(schedules=[schedule], jobs=[job])
        else:
            # Schedule targeting existing job
            schedule = ScheduleDefinition(
                name=self.schedule_name,
                cron_schedule=self.cron_expression,
                job_name=self.job_name,
                description=self.description,
                default_status=self.default_status,
                timezone=self.timezone,
            )
            return Definitions(schedules=[schedule])
