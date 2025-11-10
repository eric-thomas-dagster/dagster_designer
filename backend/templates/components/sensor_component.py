"""Sensor component for Dagster Designer."""

from typing import Optional
from pathlib import Path
from dagster import (
    Component,
    Resolvable,
    Definitions,
    SensorDefinition,
    RunRequest,
    SensorEvaluationContext,
    ComponentLoadContext,
    DefaultSensorStatus,
    run_status_sensor,
    DagsterRunStatus,
    asset_sensor,
    AssetKey,
    EventLogEntry,
)
from pydantic import BaseModel, Field


class SensorComponent(Component, Resolvable, BaseModel):
    """Component that creates a Dagster sensor for triggering jobs based on events."""

    sensor_name: str = Field(description="Name of the sensor")
    sensor_type: str = Field(description="Type of sensor: 'file', 'run_status', 'asset', or 'custom'")
    job_name: str = Field(description="Name of the job to trigger")
    description: Optional[str] = Field(default=None, description="Sensor description")
    file_path: Optional[str] = Field(default=None, description="File path to monitor (for file sensors)")
    asset_key: Optional[str] = Field(default=None, description="Asset key to monitor (for asset sensors)")
    monitored_job_name: Optional[str] = Field(default=None, description="Name of the job to monitor (for run_status sensors)")
    run_status: Optional[str] = Field(default="SUCCESS", description="Run status to monitor: SUCCESS, FAILURE, or CANCELED (for run_status sensors)")
    minimum_interval_seconds: int = Field(default=30, description="Minimum interval between sensor evaluations in seconds")
    default_status: str = Field(default="RUNNING", description="Default status of the sensor")

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the sensor."""

        if self.sensor_type == "file":
            # File sensor implementation
            def sensor_fn(sensor_context: SensorEvaluationContext):
                if self.file_path and Path(self.file_path).exists():
                    yield RunRequest(run_key=f"{self.sensor_name}_{Path(self.file_path).stat().st_mtime}")

            # Create the sensor
            sensor = SensorDefinition(
                name=self.sensor_name,
                evaluation_fn=sensor_fn,
                job_name=self.job_name,
                description=self.description,
                minimum_interval_seconds=self.minimum_interval_seconds,
                default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
            )

        elif self.sensor_type == "run_status":
            # Run status sensor implementation
            if not self.monitored_job_name:
                raise ValueError("monitored_job_name is required for run_status sensors")

            # Map string status to DagsterRunStatus enum
            status_map = {
                "SUCCESS": DagsterRunStatus.SUCCESS,
                "FAILURE": DagsterRunStatus.FAILURE,
                "CANCELED": DagsterRunStatus.CANCELED,
            }
            monitored_status = status_map.get(self.run_status or "SUCCESS", DagsterRunStatus.SUCCESS)

            @run_status_sensor(
                name=self.sensor_name,
                run_status=monitored_status,
                monitored_jobs=[self.monitored_job_name],
                request_job=self.job_name,
                description=self.description,
                minimum_interval_seconds=self.minimum_interval_seconds,
                default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
            )
            def sensor_fn(context):
                # Trigger the job when the monitored job reaches the specified status
                yield RunRequest(run_key=context.dagster_run.run_id)

            sensor = sensor_fn

        elif self.sensor_type == "asset":
            # Asset sensor implementation
            if not self.asset_key:
                raise ValueError("asset_key is required for asset sensors")

            # Parse asset key (handle both simple keys and path-like keys)
            # e.g., "my_asset" or "path/to/asset"
            asset_key_parts = self.asset_key.split("/")
            monitored_asset_key = AssetKey(asset_key_parts)

            @asset_sensor(
                name=self.sensor_name,
                asset_key=monitored_asset_key,
                job_name=self.job_name,
                description=self.description or f"Monitor asset: {self.asset_key}",
                minimum_interval_seconds=self.minimum_interval_seconds,
                default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
            )
            def sensor_fn(context: SensorEvaluationContext, asset_event: EventLogEntry):
                # Trigger the job when the monitored asset is materialized
                yield RunRequest(
                    run_key=f"{self.sensor_name}_{asset_event.run_id}",
                    run_config={},
                )

            sensor = sensor_fn

        else:
            # Custom sensor - users need to implement their own logic
            def sensor_fn(sensor_context: SensorEvaluationContext):
                # Placeholder for custom sensor logic
                # Users should edit this file to add their custom logic
                pass

            # Create the sensor
            sensor = SensorDefinition(
                name=self.sensor_name,
                evaluation_fn=sensor_fn,
                job_name=self.job_name,
                description=self.description,
                minimum_interval_seconds=self.minimum_interval_seconds,
                default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
            )

        return Definitions(sensors=[sensor])
