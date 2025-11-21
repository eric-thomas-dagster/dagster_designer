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
    is_partitioned: Optional[bool] = None  # Explicitly specify if schedule targets partitioned assets

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

        # Determine if this schedule should be partition-aware
        # Priority: 1) explicit is_partitioned flag, 2) auto-detection
        is_partitioned_job = False

        if self.is_partitioned is not None:
            # User explicitly specified partition-awareness
            is_partitioned_job = self.is_partitioned
        elif self.asset_selection or self.job_name:
            # Try to auto-detect partitioned assets/jobs
            try:
                # Get all asset specs from context
                all_specs = []
                if hasattr(context, 'defs') and context.defs:
                    if hasattr(context.defs, 'get_all_asset_specs'):
                        all_specs = list(context.defs.get_all_asset_specs())
                    elif hasattr(context.defs, 'assets'):
                        # Fallback: get specs from asset list
                        all_specs = [asset.to_source_asset().to_spec() if hasattr(asset, 'to_source_asset') else None
                                    for asset in context.defs.assets]
                        all_specs = [s for s in all_specs if s is not None]

                if self.asset_selection:
                    # Check selected assets for partitions
                    selected_keys = [dg.AssetKey.from_user_string(key) for key in self.asset_selection]
                    for spec in all_specs:
                        if spec.key in selected_keys and spec.partitions_def is not None:
                            is_partitioned_job = True
                            break

                elif self.job_name:
                    # For job references, try to resolve the job and check its assets
                    if hasattr(context.defs, 'get_job_def'):
                        try:
                            job_def = context.defs.get_job_def(self.job_name)
                            # Check if the job has a partitions_def
                            if hasattr(job_def, 'partitions_def') and job_def.partitions_def is not None:
                                is_partitioned_job = True
                        except Exception:
                            pass

                    # Fallback: check if any asset in the job is partitioned
                    if not is_partitioned_job:
                        for spec in all_specs:
                            if spec.partitions_def is not None:
                                # Conservative approach: assume job might contain this partitioned asset
                                is_partitioned_job = True
                                break

            except Exception as e:
                # If we can't determine, fall back to regular schedule
                import sys
                print(f"[ScheduleComponent] Could not detect partitions, using regular schedule: {e}",
                      file=sys.stderr, flush=True)

        # Create schedule
        # Use build_schedule_from_partitioned_job for partitioned assets
        if is_partitioned_job and target_job:
            # For partitioned jobs, use build_schedule_from_partitioned_job
            # This automatically handles partition selection based on the partition definition
            # Note: The schedule timing is derived from the partition definition, not cron_expression
            import sys
            print(f"[ScheduleComponent] Creating partitioned schedule '{self.schedule_name}' - "
                  f"schedule will be derived from partition definition",
                  file=sys.stderr, flush=True)

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
            import sys
            print(f"[ScheduleComponent] Creating regular schedule '{self.schedule_name}' "
                  f"with cron '{self.cron_expression}'",
                  file=sys.stderr, flush=True)

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
