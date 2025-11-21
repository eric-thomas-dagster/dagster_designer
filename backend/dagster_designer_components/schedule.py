"""Schedule component for Dagster Designer."""

from typing import Optional

import dagster as dg
from dagster._core.definitions.asset_selection import AssetSelection
from dagster._core.definitions.partition import PartitionsDefinition


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
            target_job = None
        elif self.asset_selection:
            # Create an implicit job from asset selection
            job_name = f"{self.schedule_name}_job"
            asset_sel = AssetSelection.keys(*self.asset_selection)
            target_job = dg.define_asset_job(
                name=job_name,
                selection=asset_sel,
                description=f"Auto-generated job for {self.schedule_name}",
            )
            target = target_job
        else:
            raise ValueError(
                f"Schedule {self.schedule_name} must specify either job_name or asset_selection"
            )

        # Check if the job contains partitioned assets
        # For asset selections, we can try to detect partitioned assets
        is_partitioned_job = False
        if self.asset_selection:
            # Try to resolve assets and check for partitions
            try:
                # Get all assets from the context
                if hasattr(context, 'defs') and context.defs and hasattr(context.defs, 'get_all_asset_specs'):
                    all_specs = context.defs.get_all_asset_specs()
                    selected_keys = [dg.AssetKey.from_user_string(key) for key in self.asset_selection]

                    # Check if any selected asset has partitions
                    for spec in all_specs:
                        if spec.key in selected_keys and spec.partitions_def is not None:
                            is_partitioned_job = True
                            break
            except Exception:
                # If we can't determine, fall back to regular schedule
                pass

        # Create schedule
        # Use build_schedule_from_partitioned_job for partitioned assets
        if is_partitioned_job and target_job:
            # For partitioned jobs, use build_schedule_from_partitioned_job
            # This automatically handles partition selection based on the schedule
            schedule = dg.build_schedule_from_partitioned_job(
                job=target_job,
                name=self.schedule_name,
                description=self.description,
                default_status=(
                    dg.DefaultScheduleStatus.RUNNING
                    if self.default_status == "RUNNING"
                    else dg.DefaultScheduleStatus.STOPPED
                ),
            )
        else:
            # Regular schedule for non-partitioned jobs
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
        jobs = [target_job] if target_job else []

        return dg.Definitions(schedules=schedules, jobs=jobs)
