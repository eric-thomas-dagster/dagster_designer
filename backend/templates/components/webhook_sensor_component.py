"""Webhook Sensor component for Dagster Designer."""

from typing import Optional
from dagster import (
    Component,
    Resolvable,
    Definitions,
    SensorDefinition,
    SkipReason,
    SensorEvaluationContext,
    ComponentLoadContext,
    DefaultSensorStatus,
)
from pydantic import BaseModel, Field


class WebhookSensorComponent(Component, Resolvable, BaseModel):
    """Component that creates a Dagster sensor for webhook callbacks.

    Note: This is a placeholder implementation. Webhook sensors require external
    infrastructure to receive HTTP requests and store events for the sensor to process.
    Consider using Dagster Cloud webhooks or implementing a separate webhook receiver.
    """

    sensor_name: str = Field(description="Name of the sensor")
    webhook_path: str = Field(description="URL path for the webhook endpoint")
    job_name: str = Field(description="Name of the job to trigger")
    auth_token: Optional[str] = Field(default="", description="Optional bearer token for authentication")
    validate_signature: bool = Field(default=False, description="Validate webhook signature")
    signature_header: str = Field(default="X-Hub-Signature-256", description="HTTP header containing the signature")
    secret_key: Optional[str] = Field(default="", description="Secret key for signature validation")
    default_status: str = Field(default="RUNNING", description="Default status of the sensor")

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the webhook sensor."""

        webhook_path = self.webhook_path

        def sensor_fn(sensor_context: SensorEvaluationContext):
            # This is a placeholder implementation
            # In practice, webhooks would be handled by:
            # 1. Dagster Cloud webhook sensors
            # 2. External service writing to a queue or database
            # 3. Custom webhook receiver storing events

            # Check for webhook events (e.g., from a queue or database)
            # For this example, we return a skip reason with setup instructions

            return SkipReason(
                f"Webhook sensor '{self.sensor_name}' requires external webhook handling. "
                f"Set up a webhook receiver at path '{webhook_path}' that stores events "
                "for this sensor to process. See documentation for setup instructions."
            )

        # Create the sensor
        sensor = SensorDefinition(
            name=self.sensor_name,
            evaluation_fn=sensor_fn,
            job_name=self.job_name,
            minimum_interval_seconds=30,
            default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
        )

        return Definitions(sensors=[sensor])
