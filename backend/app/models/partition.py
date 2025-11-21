"""Partition configuration models."""

from typing import Literal
from pydantic import BaseModel, Field


class PartitionConfig(BaseModel):
    """Configuration for asset partitions."""

    enabled: bool = Field(False, description="Whether partitions are enabled for this component")
    partition_type: Literal["daily", "weekly", "monthly", "hourly", "static", "dynamic"] = Field(
        "daily",
        description="Type of partitions"
    )

    # Time-based partition fields
    start_date: str | None = Field(None, description="Start date for time-based partitions (YYYY-MM-DD)")
    end_date: str | None = Field(None, description="End date for time-based partitions (optional)")
    timezone: str = Field("UTC", description="Timezone for time-based partitions")
    minute_offset: int | None = Field(None, description="Minutes past the hour to split the partition (all time-based)")
    hour_offset: int | None = Field(None, description="Hours past midnight to split the partition (daily/weekly/monthly)")
    day_offset: int | None = Field(None, description="Day of week (weekly: 0-6) or day of month (monthly: 1-31)")

    # For hourly/custom partitions
    cron_schedule: str | None = Field(None, description="Cron schedule for dynamic partitions")
    fmt: str | None = Field(None, description="Date format string")

    # For static partitions
    partition_keys: list[str] = Field(default_factory=list, description="Static partition keys")

    # Naming
    var_name: str = Field("component_partitions_def", description="Name of the partition definition variable")

    def to_python_code(self) -> str:
        """Generate Python code for the partition definition."""
        if not self.enabled:
            return ""

        if self.partition_type == "daily":
            params = [f'start_date="{self.start_date}"']
            if self.end_date:
                params.append(f'end_date="{self.end_date}"')
            if self.timezone != "UTC":
                params.append(f'timezone="{self.timezone}"')
            if self.minute_offset is not None:
                params.append(f'minute_offset={self.minute_offset}')
            if self.hour_offset is not None:
                params.append(f'hour_offset={self.hour_offset}')
            if self.fmt:
                params.append(f'fmt="{self.fmt}"')

            return f"dg.DailyPartitionsDefinition({', '.join(params)})"

        elif self.partition_type == "weekly":
            params = [f'start_date="{self.start_date}"']
            if self.end_date:
                params.append(f'end_date="{self.end_date}"')
            if self.timezone != "UTC":
                params.append(f'timezone="{self.timezone}"')
            if self.minute_offset is not None:
                params.append(f'minute_offset={self.minute_offset}')
            if self.hour_offset is not None:
                params.append(f'hour_offset={self.hour_offset}')
            if self.day_offset is not None:
                params.append(f'day_offset={self.day_offset}')

            return f"dg.WeeklyPartitionsDefinition({', '.join(params)})"

        elif self.partition_type == "monthly":
            params = [f'start_date="{self.start_date}"']
            if self.end_date:
                params.append(f'end_date="{self.end_date}"')
            if self.timezone != "UTC":
                params.append(f'timezone="{self.timezone}"')
            if self.minute_offset is not None:
                params.append(f'minute_offset={self.minute_offset}')
            if self.hour_offset is not None:
                params.append(f'hour_offset={self.hour_offset}')
            if self.day_offset is not None:
                params.append(f'day_offset={self.day_offset}')

            return f"dg.MonthlyPartitionsDefinition({', '.join(params)})"

        elif self.partition_type == "hourly":
            params = [f'start_date="{self.start_date}"']
            if self.end_date:
                params.append(f'end_date="{self.end_date}"')
            if self.timezone != "UTC":
                params.append(f'timezone="{self.timezone}"')
            if self.minute_offset is not None:
                params.append(f'minute_offset={self.minute_offset}')
            if self.fmt:
                params.append(f'fmt="{self.fmt}"')

            return f"dg.HourlyPartitionsDefinition({', '.join(params)})"

        elif self.partition_type == "static":
            keys_str = ', '.join(f'"{key}"' for key in self.partition_keys)
            return f"dg.StaticPartitionsDefinition([{keys_str}])"

        elif self.partition_type == "dynamic":
            if not self.cron_schedule:
                raise ValueError("Dynamic partitions require a cron_schedule")
            params = [f'cron_schedule="{self.cron_schedule}"']
            if self.start_date:
                params.append(f'start_date="{self.start_date}"')
            if self.end_date:
                params.append(f'end_date="{self.end_date}"')
            if self.timezone != "UTC":
                params.append(f'timezone="{self.timezone}"')

            return f"dg.TimeWindowPartitionsDefinition({', '.join(params)})"

        return ""

    def to_template_vars_file(self) -> str:
        """Generate complete template_vars.py file content."""
        if not self.enabled:
            return ""

        partition_code = self.to_python_code()
        return_type = self._get_return_type()

        return f'''"""Partition definitions for this component."""

import dagster as dg


@dg.template_var
def {self.var_name}() -> {return_type}:
    """Partition definition for all assets in this component."""
    return {partition_code}
'''

    def _get_return_type(self) -> str:
        """Get the return type annotation for the partition definition."""
        type_map = {
            "daily": "dg.DailyPartitionsDefinition",
            "weekly": "dg.WeeklyPartitionsDefinition",
            "monthly": "dg.MonthlyPartitionsDefinition",
            "hourly": "dg.HourlyPartitionsDefinition",
            "static": "dg.StaticPartitionsDefinition",
            "dynamic": "dg.TimeWindowPartitionsDefinition",
        }
        return type_map.get(self.partition_type, "dg.PartitionsDefinition")

    def to_post_processing_yaml(self) -> dict:
        """Generate post_processing section for defs.yaml."""
        if not self.enabled:
            return {}

        return {
            "assets": [
                {
                    "target": "*",
                    "attributes": {
                        "partitions_def": f"{{{{ {self.var_name} }}}}"
                    }
                }
            ]
        }
