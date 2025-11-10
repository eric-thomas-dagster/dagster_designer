"""Sensor component for Dagster Designer."""

from typing import Optional, Literal

from dagster import sensor, SensorEvaluationContext, RunRequest, SkipReason, DefaultSensorStatus
from pydantic import BaseModel
from pathlib import Path


class SensorComponentParams(BaseModel):
    """Parameters for sensor component."""

    sensor_name: str
    sensor_type: Literal["file", "run_status", "custom"]
    job_name: str
    description: Optional[str] = None
    file_path: Optional[str] = None
    minimum_interval_seconds: int = 30
    default_status: str = "RUNNING"


class SensorComponent:
    """Component for creating sensors from YAML configuration."""

    params_schema = SensorComponentParams

    def __init__(self, **params):
        """Initialize the sensor component."""
        self.params = SensorComponentParams(**params)

    def build_defs(self, context):
        """Build Dagster definitions from component parameters."""
        from dagster import Definitions

        # Create sensor based on type
        if self.params.sensor_type == "file":
            sensor_def = self._create_file_sensor()
        elif self.params.sensor_type == "run_status":
            sensor_def = self._create_run_status_sensor()
        else:
            sensor_def = self._create_custom_sensor()

        return Definitions(sensors=[sensor_def])

    def _create_file_sensor(self):
        """Create a file-watching sensor."""
        file_path = self.params.file_path
        job_name = self.params.job_name

        @sensor(
            name=self.params.sensor_name,
            job_name=job_name,
            minimum_interval_seconds=self.params.minimum_interval_seconds,
            description=self.params.description or f"Watch for file: {file_path}",
            default_status=(
                DefaultSensorStatus.RUNNING
                if self.params.default_status == "RUNNING"
                else DefaultSensorStatus.STOPPED
            ),
        )
        def file_sensor(context: SensorEvaluationContext):
            """Sensor that triggers when a file exists."""
            if file_path and Path(file_path).exists():
                return RunRequest(run_key=f"file_{file_path}_{context.cursor or '0'}")
            return SkipReason(f"File {file_path} does not exist")

        return file_sensor

    def _create_run_status_sensor(self):
        """Create a run status sensor."""
        from dagster import run_status_sensor, DagsterRunStatus, RunStatusSensorContext

        @run_status_sensor(
            name=self.params.sensor_name,
            run_status=DagsterRunStatus.SUCCESS,
            request_job_name=self.params.job_name,
            description=self.params.description or "Monitor run status",
            minimum_interval_seconds=self.params.minimum_interval_seconds,
            default_status=(
                DefaultSensorStatus.RUNNING
                if self.params.default_status == "RUNNING"
                else DefaultSensorStatus.STOPPED
            ),
        )
        def status_sensor(context: RunStatusSensorContext):
            """Sensor that triggers on run status changes."""
            return RunRequest(run_key=f"status_{context.dagster_run.run_id}")

        return status_sensor

    def _create_custom_sensor(self):
        """Create a custom sensor."""

        @sensor(
            name=self.params.sensor_name,
            job_name=self.params.job_name,
            minimum_interval_seconds=self.params.minimum_interval_seconds,
            description=self.params.description or "Custom sensor",
            default_status=(
                DefaultSensorStatus.RUNNING
                if self.params.default_status == "RUNNING"
                else DefaultSensorStatus.STOPPED
            ),
        )
        def custom_sensor(context: SensorEvaluationContext):
            """Custom sensor - modify this logic as needed."""
            # Default: always trigger
            return RunRequest(run_key=context.cursor or "0")

        return custom_sensor
