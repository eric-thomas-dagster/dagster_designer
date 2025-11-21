"""Sensor component for Dagster Designer."""

from typing import Optional, Literal

import dagster as dg
from pathlib import Path


class SensorComponent(dg.Component, dg.Model, dg.Resolvable):
    """Component for creating sensors from YAML configuration."""

    sensor_name: str
    sensor_type: Literal["file", "run_status", "asset", "custom"]
    job_name: str
    description: Optional[str] = None
    file_path: Optional[str] = None
    asset_key: Optional[str] = None  # For asset sensors
    minimum_interval_seconds: int = 30
    default_status: str = "RUNNING"
    is_partitioned: Optional[bool] = None  # Whether sensor should handle partitioned assets

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        """Build Dagster definitions from component parameters."""
        # Create sensor based on type
        if self.sensor_type == "file":
            sensor_def = self._create_file_sensor()
        elif self.sensor_type == "run_status":
            sensor_def = self._create_run_status_sensor()
        elif self.sensor_type == "asset":
            sensor_def = self._create_asset_sensor()
        else:
            sensor_def = self._create_custom_sensor()

        return dg.Definitions(sensors=[sensor_def])

    def _create_file_sensor(self):
        """Create a file-watching sensor."""
        file_path = self.file_path
        job_name = self.job_name

        @dg.sensor(
            name=self.sensor_name,
            job_name=job_name,
            minimum_interval_seconds=self.minimum_interval_seconds,
            description=self.description or f"Watch for file: {file_path}",
            default_status=(
                dg.DefaultSensorStatus.RUNNING
                if self.default_status == "RUNNING"
                else dg.DefaultSensorStatus.STOPPED
            ),
        )
        def file_sensor(context: dg.SensorEvaluationContext):
            """Sensor that triggers when a file exists."""
            if file_path and Path(file_path).exists():
                return dg.RunRequest(run_key=f"file_{file_path}_{context.cursor or '0'}")
            return dg.SkipReason(f"File {file_path} does not exist")

        return file_sensor

    def _create_run_status_sensor(self):
        """Create a run status sensor."""
        @dg.run_status_sensor(
            name=self.sensor_name,
            run_status=dg.DagsterRunStatus.SUCCESS,
            request_job_name=self.job_name,
            description=self.description or "Monitor run status",
            minimum_interval_seconds=self.minimum_interval_seconds,
            default_status=(
                dg.DefaultSensorStatus.RUNNING
                if self.default_status == "RUNNING"
                else dg.DefaultSensorStatus.STOPPED
            ),
        )
        def status_sensor(context: dg.RunStatusSensorContext):
            """Sensor that triggers on run status changes."""
            return dg.RunRequest(run_key=f"status_{context.dagster_run.run_id}")

        return status_sensor

    def _create_asset_sensor(self):
        """Create an asset sensor that monitors asset materializations.

        For partitioned assets, this will automatically trigger runs with the
        same partition key as the materialization event.
        """
        import sys

        # Parse asset key (handle both simple keys and path-like keys)
        # e.g., "my_asset" or "path/to/asset"
        asset_key_parts = self.asset_key.split("/") if self.asset_key else ["unknown"]
        monitored_asset_key = dg.AssetKey(asset_key_parts)

        @dg.asset_sensor(
            name=self.sensor_name,
            asset_key=monitored_asset_key,
            job_name=self.job_name,
            minimum_interval_seconds=self.minimum_interval_seconds,
            description=self.description or f"Monitor asset: {self.asset_key}",
            default_status=(
                dg.DefaultSensorStatus.RUNNING
                if self.default_status == "RUNNING"
                else dg.DefaultSensorStatus.STOPPED
            ),
        )
        def asset_sensor_fn(context: dg.SensorEvaluationContext, asset_event: dg.EventLogEntry):
            """Sensor that triggers when the monitored asset is materialized.

            For partitioned assets, automatically passes the partition key to the triggered run.
            """
            # Check if the asset event has a partition key
            partition_key = None
            if hasattr(asset_event, 'partition_key') and asset_event.partition_key:
                partition_key = asset_event.partition_key
            elif hasattr(asset_event, 'dagster_event') and asset_event.dagster_event:
                # Try to extract partition from the event metadata
                event = asset_event.dagster_event
                if hasattr(event, 'partition') and event.partition:
                    partition_key = event.partition
                elif hasattr(event, 'step_key') and event.step_key:
                    # Partition might be encoded in step_key
                    step_key = event.step_key
                    if '[' in step_key and ']' in step_key:
                        # Format: "asset_name[partition_key]"
                        partition_key = step_key[step_key.find('[')+1:step_key.find(']')]

            run_key = f"{self.sensor_name}_{asset_event.run_id}"

            if partition_key:
                # Partitioned asset - trigger run for the same partition
                print(f"[SensorComponent] Asset sensor '{self.sensor_name}' detected "
                      f"partition '{partition_key}' for asset {self.asset_key}, "
                      f"triggering partitioned run",
                      file=sys.stderr, flush=True)

                yield dg.RunRequest(
                    run_key=f"{run_key}_{partition_key}",
                    partition_key=partition_key,  # Pass partition key to the triggered run
                    run_config={},
                )
            else:
                # Non-partitioned asset or partition key not available
                print(f"[SensorComponent] Asset sensor '{self.sensor_name}' detected "
                      f"materialization of {self.asset_key} (non-partitioned)",
                      file=sys.stderr, flush=True)

                yield dg.RunRequest(
                    run_key=run_key,
                    run_config={},
                )

        return asset_sensor_fn

    def _create_custom_sensor(self):
        """Create a custom sensor."""
        @dg.sensor(
            name=self.sensor_name,
            job_name=self.job_name,
            minimum_interval_seconds=self.minimum_interval_seconds,
            description=self.description or "Custom sensor",
            default_status=(
                dg.DefaultSensorStatus.RUNNING
                if self.default_status == "RUNNING"
                else dg.DefaultSensorStatus.STOPPED
            ),
        )
        def custom_sensor(context: dg.SensorEvaluationContext):
            """Custom sensor - modify this logic as needed."""
            # Default: always trigger
            return dg.RunRequest(run_key=context.cursor or "0")

        return custom_sensor
