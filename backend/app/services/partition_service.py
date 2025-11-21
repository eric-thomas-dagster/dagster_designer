"""Service for managing component partition configurations."""

from pathlib import Path
import yaml

from ..models.partition import PartitionConfig


class PartitionService:
    """Service for generating partition-related files."""

    def write_template_vars(self, component_dir: Path, partition_config: PartitionConfig) -> bool:
        """
        Write template_vars.py file for a component.

        Args:
            component_dir: Path to the component directory (e.g., project/src/project/defs/component_name)
            partition_config: Partition configuration

        Returns:
            True if file was written, False if partitions are disabled
        """
        if not partition_config.enabled:
            # Remove template_vars.py if it exists
            template_vars_path = component_dir / "template_vars.py"
            if template_vars_path.exists():
                template_vars_path.unlink()
            return False

        # Generate and write template_vars.py
        content = partition_config.to_template_vars_file()
        template_vars_path = component_dir / "template_vars.py"
        template_vars_path.write_text(content)
        print(f"[Partition Service] Wrote template_vars.py to {template_vars_path}")
        return True

    def update_defs_yaml(self, component_dir: Path, partition_config: PartitionConfig) -> None:
        """
        Update defs.yaml to include template_vars_module and post_processing.

        Args:
            component_dir: Path to the component directory
            partition_config: Partition configuration
        """
        defs_yaml_path = component_dir / "defs.yaml"
        if not defs_yaml_path.exists():
            print(f"[Partition Service] defs.yaml not found at {defs_yaml_path}")
            return

        # Load existing defs.yaml
        with open(defs_yaml_path, 'r') as f:
            defs_data = yaml.safe_load(f) or {}

        if partition_config.enabled:
            # Add template_vars_module reference
            defs_data["template_vars_module"] = ".template_vars"

            # Add or update post_processing
            post_processing = partition_config.to_post_processing_yaml()
            defs_data["post_processing"] = post_processing

            print(f"[Partition Service] Added partition config to defs.yaml")
        else:
            # Remove partition-related fields
            defs_data.pop("template_vars_module", None)

            # Remove partition from post_processing if it exists
            if "post_processing" in defs_data and "assets" in defs_data["post_processing"]:
                # Filter out partition-related post_processing rules
                assets = defs_data["post_processing"]["assets"]
                filtered_assets = [
                    asset for asset in assets
                    if not (
                        asset.get("target") == "*" and
                        "partitions_def" in asset.get("attributes", {})
                    )
                ]

                if filtered_assets:
                    defs_data["post_processing"]["assets"] = filtered_assets
                else:
                    # Remove post_processing entirely if empty
                    defs_data.pop("post_processing", None)

            print(f"[Partition Service] Removed partition config from defs.yaml")

        # Write updated defs.yaml
        with open(defs_yaml_path, 'w') as f:
            yaml.dump(defs_data, f, default_flow_style=False, sort_keys=False)

    def apply_partition_config(
        self,
        component_dir: Path,
        partition_config: PartitionConfig
    ) -> None:
        """
        Apply partition configuration to a component.

        This writes template_vars.py and updates defs.yaml.

        Args:
            component_dir: Path to the component directory
            partition_config: Partition configuration
        """
        print(f"[Partition Service] Applying partition config to {component_dir.name}")

        # Write template_vars.py
        self.write_template_vars(component_dir, partition_config)

        # Update defs.yaml
        self.update_defs_yaml(component_dir, partition_config)

        print(f"[Partition Service] Partition config applied successfully")


# Singleton instance
partition_service = PartitionService()
