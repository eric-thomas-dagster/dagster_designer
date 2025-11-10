"""Database Sensor component for Dagster Designer."""

from typing import Optional
import os
from sqlalchemy import create_engine, text
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


class DatabaseSensorComponent(Component, Resolvable, BaseModel):
    """Component that creates a Dagster sensor for monitoring database tables."""

    sensor_name: str = Field(description="Name of the sensor")
    connection_string: str = Field(description="SQLAlchemy connection string")
    table_name: str = Field(description="Name of the table to monitor")
    timestamp_column: str = Field(description="Column name for tracking new rows")
    query_condition: Optional[str] = Field(default="", description="Additional SQL WHERE condition")
    job_name: str = Field(description="Name of the job to trigger")
    minimum_interval_seconds: int = Field(default=60, description="How often to check for new rows")
    batch_size: int = Field(default=100, description="Maximum number of rows to process per run")
    default_status: str = Field(default="RUNNING", description="Default status of the sensor")

    def build_defs(self, context: ComponentLoadContext) -> Definitions:
        """Build definitions for the database sensor."""

        connection_string = self.connection_string
        table_name = self.table_name
        timestamp_column = self.timestamp_column
        query_condition = self.query_condition
        batch_size = self.batch_size

        def sensor_fn(sensor_context: SensorEvaluationContext):
            # Get connection string from environment
            conn_string = os.getenv("DATABASE_URL", connection_string)

            try:
                # Create database engine
                engine = create_engine(conn_string)

                # Get last processed timestamp from cursor
                last_timestamp = sensor_context.cursor or "1970-01-01 00:00:00"

                # Build query
                where_clause = f"AND {query_condition}" if query_condition else ""
                query = text(f"""
                    SELECT *
                    FROM {table_name}
                    WHERE {timestamp_column} > :last_timestamp
                    {where_clause}
                    ORDER BY {timestamp_column} ASC
                    LIMIT {batch_size}
                """)

                with engine.connect() as conn:
                    result = conn.execute(query, {"last_timestamp": last_timestamp})
                    new_rows = result.fetchall()
                    column_names = result.keys()

                if not new_rows:
                    return SkipReason(f"No new rows in {table_name}")

                # Update cursor to latest timestamp
                latest_timestamp = str(new_rows[-1][column_names.index(timestamp_column)])
                sensor_context.update_cursor(latest_timestamp)

                # Create run requests for each new row
                for row in new_rows:
                    row_dict = dict(zip(column_names, row))
                    row_id = row_dict.get('id', row_dict.get(timestamp_column))

                    yield RunRequest(
                        run_key=f"row-{row_id}-{row_dict[timestamp_column]}",
                        run_config={
                            "ops": {
                                "config": {
                                    "row_data": {k: str(v) for k, v in row_dict.items()},
                                    "table_name": table_name,
                                }
                            }
                        },
                        tags={
                            "table": table_name,
                            "row_id": str(row_id),
                            "source": "database_sensor",
                        }
                    )

                sensor_context.log.info(f"Triggered {len(new_rows)} runs for new database rows")

            except Exception as e:
                sensor_context.log.error(f"Error querying database: {e}")
                return SkipReason(f"Database error: {e}")

        # Create the sensor
        sensor = SensorDefinition(
            name=self.sensor_name,
            evaluation_fn=sensor_fn,
            job_name=self.job_name,
            minimum_interval_seconds=self.minimum_interval_seconds,
            default_status=DefaultSensorStatus.RUNNING if self.default_status == "RUNNING" else DefaultSensorStatus.STOPPED,
        )

        return Definitions(sensors=[sensor])
