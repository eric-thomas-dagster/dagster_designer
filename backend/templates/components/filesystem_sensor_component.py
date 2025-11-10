"""File System Sensor component for Dagster Designer."""

from typing import Optional
from pathlib import Path
import shutil
from dagster import (
    Component,
    Resolvable,
    Definitions,
    SensorDefinition,
    RunRequest,
    SkipReason,
    SensorEvaluationContext,
    ComponentLoadContext,
    DefaultSensorStatus,
)
from pydantic import BaseModel, Field


class FileSystemSensorComponent(Component, Resolvable, BaseModel):
    """Component that creates a Dagster sensor for monitoring file system directories."""

    sensor_name: str = Field(description="Name of the sensor")
    directory_path: str = Field(description="Path to the directory to monitor")
    file_pattern: str = Field(default="*", description="Glob pattern to match files")
    recursive: bool = Field(default=False, description="Monitor subdirectories recursively")
    job_name: str = Field(description="Name of the job to trigger")
    minimum_interval_seconds: int = Field(default=30, description="How often to check for new files")
    move_after_processing: bool = Field(default=False, description="Move files to archive directory after processing")
    archive_directory: Optional[str] = Field(default="", description="Directory to move processed files to")
    default_status: str = Field(default="RUNNING", description="Default status of the sensor")

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the file system sensor."""

        directory_path = self.directory_path
        file_pattern = self.file_pattern
        recursive = self.recursive
        move_after = self.move_after_processing
        archive_dir = self.archive_directory

        def sensor_fn(sensor_context: SensorEvaluationContext):
            # Get list of files matching pattern
            base_path = Path(directory_path)

            if not base_path.exists():
                return SkipReason(f"Directory {base_path} does not exist")

            # Find matching files
            if recursive:
                files = list(base_path.glob(f"**/{file_pattern}"))
            else:
                files = list(base_path.glob(file_pattern))

            files = [f for f in files if f.is_file()]

            if not files:
                return SkipReason(f"No files matching pattern '{file_pattern}' found")

            # Get last processed timestamp from cursor
            last_timestamp = float(sensor_context.cursor or "0")

            # Filter for new files
            new_files = [f for f in files if f.stat().st_mtime > last_timestamp]

            if not new_files:
                return SkipReason("No new files since last check")

            # Sort by modification time
            new_files.sort(key=lambda f: f.stat().st_mtime)

            # Update cursor to latest timestamp
            latest_timestamp = new_files[-1].stat().st_mtime
            sensor_context.update_cursor(str(latest_timestamp))

            # Create run requests
            for file_path in new_files:
                yield RunRequest(
                    run_key=f"{file_path.name}-{file_path.stat().st_mtime}",
                    run_config={
                        "ops": {
                            "config": {
                                "file_path": str(file_path),
                                "file_name": file_path.name,
                                "file_size": file_path.stat().st_size,
                                "modified_time": file_path.stat().st_mtime,
                            }
                        }
                    },
                    tags={
                        "file_name": file_path.name,
                        "file_path": str(file_path),
                        "source": "filesystem_sensor",
                    }
                )

            sensor_context.log.info(f"Triggered {len(new_files)} runs for new files")

            # Move processed files to archive if requested
            if move_after and archive_dir:
                archive_path = Path(archive_dir)
                archive_path.mkdir(parents=True, exist_ok=True)

                for file_path in new_files:
                    dest = archive_path / file_path.name
                    shutil.move(str(file_path), str(dest))
                    sensor_context.log.info(f"Moved {file_path} to {dest}")

        # Create the sensor
        sensor = SensorDefinition(
            name=self.sensor_name,
            evaluation_fn=sensor_fn,
            job_name=self.job_name,
            minimum_interval_seconds=self.minimum_interval_seconds,
            default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
        )

        return Definitions(sensors=[sensor])
