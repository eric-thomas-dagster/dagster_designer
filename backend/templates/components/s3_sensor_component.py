"""S3 Sensor component for Dagster Designer."""

from typing import Optional
import boto3
import re
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


class S3SensorComponent(Component, Resolvable, BaseModel):
    """Component that creates a Dagster sensor for monitoring S3 buckets."""

    sensor_name: str = Field(description="Name of the sensor")
    bucket_name: str = Field(description="S3 bucket name to monitor")
    prefix: Optional[str] = Field(default="", description="Object key prefix filter")
    pattern: Optional[str] = Field(default="", description="Regex pattern to match object keys")
    job_name: str = Field(description="Name of the job to trigger")
    minimum_interval_seconds: int = Field(default=30, description="How often to check for new objects")
    aws_region: Optional[str] = Field(default="", description="AWS region")
    since_key: Optional[str] = Field(default="", description="Only process objects after this key")
    default_status: str = Field(default="RUNNING", description="Default status of the sensor")

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the S3 sensor."""

        bucket_name = self.bucket_name
        prefix = self.prefix or ""
        pattern = self.pattern
        aws_region = self.aws_region
        since_key = self.since_key

        def sensor_fn(sensor_context: SensorEvaluationContext):
            # Initialize S3 client
            s3_client_kwargs = {}
            if aws_region:
                s3_client_kwargs['region_name'] = aws_region
            s3_client = boto3.client('s3', **s3_client_kwargs)

            # Get the last processed key from cursor
            last_key = sensor_context.cursor or since_key or ""

            # List objects in bucket
            paginator = s3_client.get_paginator('list_objects_v2')
            pages = paginator.paginate(
                Bucket=bucket_name,
                Prefix=prefix,
                StartAfter=last_key
            )

            # Collect new objects
            new_objects = []
            for page in pages:
                if 'Contents' in page:
                    new_objects.extend(page['Contents'])

            # Filter by regex pattern if provided
            if pattern:
                pattern_re = re.compile(pattern)
                new_objects = [obj for obj in new_objects if pattern_re.match(obj['Key'])]

            if not new_objects:
                return SkipReason(f"No new objects found in s3://{bucket_name}/{prefix}")

            # Sort by key to process in order
            new_objects.sort(key=lambda x: x['Key'])

            # Update cursor to the last processed key
            latest_key = new_objects[-1]['Key']
            sensor_context.update_cursor(latest_key)

            # Create run requests for each new object
            for obj in new_objects:
                yield RunRequest(
                    run_key=f"{obj['Key']}-{obj['LastModified'].timestamp()}",
                    run_config={
                        "ops": {
                            "config": {
                                "s3_bucket": bucket_name,
                                "s3_key": obj['Key'],
                                "s3_size": obj['Size'],
                                "s3_last_modified": obj['LastModified'].isoformat(),
                            }
                        }
                    },
                    tags={
                        "s3_bucket": bucket_name,
                        "s3_key": obj['Key'],
                        "source": "s3_sensor",
                    }
                )

            sensor_context.log.info(f"Triggered {len(new_objects)} runs for new S3 objects")

        # Create the sensor
        sensor = SensorDefinition(
            name=self.sensor_name,
            evaluation_fn=sensor_fn,
            job_name=self.job_name,
            minimum_interval_seconds=self.minimum_interval_seconds,
            default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
        )

        return Definitions(sensors=[sensor])
