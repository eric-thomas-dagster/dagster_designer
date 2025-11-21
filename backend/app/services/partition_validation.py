"""Partition compatibility validation for jobs."""

from typing import List, Tuple
from app.models.partition import PartitionConfig


def validate_partition_compatibility(
    partition_configs: List[PartitionConfig],
) -> Tuple[bool, List[str]]:
    """
    Validate that all partition configs are compatible for use in the same job.

    According to Dagster requirements, when creating an asset job that contains
    multiple partitioned assets, all assets must have the same partition definition.

    Args:
        partition_configs: List of PartitionConfig objects for assets in the job

    Returns:
        (is_compatible, issues) - True if compatible, plus list of issue descriptions
    """
    # Filter to only enabled partition configs
    enabled_configs = [p for p in partition_configs if p.enabled]

    # No conflict if 0 or 1 partitioned asset
    if len(enabled_configs) <= 1:
        return True, []

    issues = []
    ref_config = enabled_configs[0]

    for i, config in enumerate(enabled_configs[1:], 2):
        # Check partition type - must be identical
        if config.partition_type != ref_config.partition_type:
            issues.append(
                f"Asset {i} has partition type '{config.partition_type}' "
                f"but first partitioned asset has '{ref_config.partition_type}'. "
                f"All partitioned assets in a job must use the same partition type."
            )

        # For time-based partitions, check critical parameters
        if config.partition_type in ["daily", "weekly", "monthly", "hourly"]:
            # Start date must match
            if config.start_date != ref_config.start_date:
                issues.append(
                    f"Asset {i} has start_date '{config.start_date}' "
                    f"but first partitioned asset has '{ref_config.start_date}'. "
                    f"All time-based partitions in a job must have the same start_date."
                )

            # Timezone must match
            if config.timezone != ref_config.timezone:
                issues.append(
                    f"Asset {i} has timezone '{config.timezone}' "
                    f"but first partitioned asset has '{ref_config.timezone}'. "
                    f"All time-based partitions in a job must use the same timezone."
                )

            # End date should match (if both specified)
            if config.end_date != ref_config.end_date:
                if config.end_date is not None and ref_config.end_date is not None:
                    issues.append(
                        f"Asset {i} has end_date '{config.end_date}' "
                        f"but first partitioned asset has '{ref_config.end_date}'. "
                        f"All time-based partitions in a job should have the same end_date."
                    )

            # Offset parameters should match for weekly/monthly
            if config.partition_type in ["weekly", "monthly"]:
                if config.day_offset != ref_config.day_offset:
                    issues.append(
                        f"Asset {i} has day_offset '{config.day_offset}' "
                        f"but first partitioned asset has '{ref_config.day_offset}'. "
                        f"Day offset must match for {config.partition_type} partitions."
                    )

            # Hour offset should match for daily/weekly/monthly
            if config.partition_type in ["daily", "weekly", "monthly"]:
                if config.hour_offset != ref_config.hour_offset:
                    issues.append(
                        f"Asset {i} has hour_offset '{config.hour_offset}' "
                        f"but first partitioned asset has '{ref_config.hour_offset}'. "
                        f"Hour offset must match for {config.partition_type} partitions."
                    )

            # Minute offset should match for all time-based
            if config.minute_offset != ref_config.minute_offset:
                issues.append(
                    f"Asset {i} has minute_offset '{config.minute_offset}' "
                    f"but first partitioned asset has '{ref_config.minute_offset}'. "
                    f"Minute offset must match for time-based partitions."
                )

        # For static partitions, keys must match exactly
        elif config.partition_type == "static":
            if set(config.partition_keys) != set(ref_config.partition_keys):
                issues.append(
                    f"Asset {i} has different static partition keys than first partitioned asset. "
                    f"All static partitions in a job must have the exact same partition keys."
                )

        # For dynamic partitions, cron schedule must match
        elif config.partition_type == "dynamic":
            if config.cron_schedule != ref_config.cron_schedule:
                issues.append(
                    f"Asset {i} has cron_schedule '{config.cron_schedule}' "
                    f"but first partitioned asset has '{ref_config.cron_schedule}'. "
                    f"All dynamic partitions in a job must use the same cron schedule."
                )

    return len(issues) == 0, issues


def get_partition_summary(config: PartitionConfig) -> str:
    """
    Get a human-readable summary of a partition configuration.

    Args:
        config: PartitionConfig to summarize

    Returns:
        Brief description of the partition configuration
    """
    if not config.enabled:
        return "No partitions"

    summary = f"{config.partition_type}"

    if config.partition_type in ["daily", "weekly", "monthly", "hourly"]:
        summary += f" from {config.start_date}"
        if config.end_date:
            summary += f" to {config.end_date}"
        if config.timezone != "UTC":
            summary += f" ({config.timezone})"
    elif config.partition_type == "static":
        summary += f" ({len(config.partition_keys)} keys)"
    elif config.partition_type == "dynamic":
        summary += f" ({config.cron_schedule})"

    return summary
