"""Schedule component for Dagster Designer."""

from typing import Optional

from dagster import ScheduleDefinition, DefaultScheduleStatus
from dagster._core.definitions.declarative_automation.serialized_objects import (
    AssetSelection as SerializableAssetSelection,
)
from dagster._core.definitions.asset_selection import AssetSelection
from pydantic import BaseModel


class ScheduleComponentParams(BaseModel):
    """Parameters for schedule component."""

    schedule_name: str
    cron_expression: str
    job_name: Optional[str] = None
    asset_selection: Optional[list[str]] = None
    description: Optional[str] = None
    timezone: str = "UTC"
    default_status: str = "RUNNING"


class ScheduleComponent:
    """Component for creating schedules from YAML configuration."""

    params_schema = ScheduleComponentParams

    def __init__(self, **params):
        """Initialize the schedule component."""
        self.params = ScheduleComponentParams(**params)

    def build_defs(self, context):
        """Build Dagster definitions from component parameters."""
        from dagster import Definitions, define_asset_job

        schedules = []

        # Determine target - either a job name or asset selection
        if self.params.job_name:
            # Schedule references an existing job by name
            target = self.params.job_name
        elif self.params.asset_selection:
            # Create an implicit job from asset selection
            job_name = f"{self.params.schedule_name}_job"
            asset_sel = AssetSelection.keys(*self.params.asset_selection)
            target = define_asset_job(
                name=job_name,
                selection=asset_sel,
                description=f"Auto-generated job for {self.params.schedule_name}",
            )
        else:
            raise ValueError(
                f"Schedule {self.params.schedule_name} must specify either job_name or asset_selection"
            )

        # Create schedule
        schedule = ScheduleDefinition(
            name=self.params.schedule_name,
            cron_schedule=self.params.cron_expression,
            job_name=target if isinstance(target, str) else target.name,
            execution_timezone=self.params.timezone,
            description=self.params.description,
            default_status=(
                DefaultScheduleStatus.RUNNING
                if self.params.default_status == "RUNNING"
                else DefaultScheduleStatus.STOPPED
            ),
        )

        schedules.append(schedule)

        # If we created a job, include it
        jobs = [target] if not isinstance(target, str) else []

        return Definitions(schedules=schedules, jobs=jobs)
