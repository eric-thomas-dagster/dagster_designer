"""Sensor component for Dagster Designer."""

from typing import Optional, Literal

import dagster as dg
from pathlib import Path


class SensorComponent(dg.Component, dg.Model, dg.Resolvable):
    """Component for creating sensors from YAML configuration."""

    sensor_name: str
    sensor_type: Literal["file", "run_status", "custom"]
    job_name: str
    description: Optional[str] = None
    file_path: Optional[str] = None
    minimum_interval_seconds: int = 30
    default_status: str = "RUNNING"

    def build_defs(self, context: dg.ComponentLoadContext) -> dg.Definitions:
        """Build Dagster definitions from component parameters."""
        # Create sensor based on type
        if self.sensor_type == "file":
            sensor_def = self._create_file_sensor()
        elif self.sensor_type == "run_status":
            sensor_def = self._create_run_status_sensor()
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
