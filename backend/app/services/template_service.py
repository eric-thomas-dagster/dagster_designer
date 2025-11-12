"""Service for generating code templates for Dagster primitives."""

from typing import Any, Literal
from pathlib import Path
import yaml
import json
import toml

# Import sensor template generators
from .sensor_templates import (
    generate_s3_sensor,
    generate_email_sensor,
    generate_filesystem_sensor,
    generate_database_sensor,
    generate_webhook_sensor,
)


PrimitiveType = Literal["python_asset", "sql_asset", "schedule", "job", "sensor", "asset_check", "io_manager", "resource"]


class TemplateService:
    """Service for generating Dagster primitive templates."""

    def __init__(self, projects_dir: str = "./projects"):
        self.projects_dir = Path(projects_dir)

    def _get_project_metadata(self, project_id: str) -> dict[str, Any]:
        """Load project metadata from JSON file."""
        metadata_file = self.projects_dir / f"{project_id}.json"
        if not metadata_file.exists():
            raise FileNotFoundError(f"Project metadata for {project_id} not found")

        with open(metadata_file, 'r') as f:
            return json.load(f)

    def _get_project_path(self, project_id: str) -> Path:
        """Get the path to a project directory."""
        metadata = self._get_project_metadata(project_id)
        directory_name = metadata.get("directory_name", project_id)
        project_path = self.projects_dir / directory_name
        if not project_path.exists():
            raise FileNotFoundError(f"Project {project_id} not found")
        return project_path

    def generate_python_asset(
        self,
        asset_name: str,
        group_name: str = "",
        description: str = "",
        compute_kind: str = "python",
        code: str = "",
        deps: list[str] | None = None,
        owners: list[str] | None = None,
        tags: dict[str, str] | None = None,
    ) -> str:
        """
        Generate a Python asset template.

        Args:
            asset_name: Name of the asset
            group_name: Asset group
            description: Asset description
            compute_kind: Compute kind badge
            code: Python code for the asset function body
            deps: List of asset dependencies
            owners: List of owner emails
            tags: Dictionary of tags

        Returns:
            Generated Python code
        """
        deps = deps or []
        owners = owners or []
        tags = tags or {}

        # Build decorator parameters
        decorator_params = []

        if group_name:
            decorator_params.append(f'group_name="{group_name}"')

        if description:
            decorator_params.append(f'description="{description}"')

        if compute_kind:
            decorator_params.append(f'compute_kind="{compute_kind}"')

        if owners:
            owners_str = ", ".join([f'"{owner}"' for owner in owners])
            decorator_params.append(f'owners=[{owners_str}]')

        if tags:
            tags_str = ", ".join([f'"{k}": "{v}"' for k, v in tags.items()])
            decorator_params.append(f'tags={{{tags_str}}}')

        decorator_line = f"@asset({', '.join(decorator_params)})" if decorator_params else "@asset"

        # Build function signature with dependencies
        if deps:
            deps_params = ", ".join([f"{dep}: Any" for dep in deps])
            function_signature = f"def {asset_name}({deps_params}):"
        else:
            function_signature = f"def {asset_name}():"

        # Default code if none provided
        if not code:
            code = f'    """Compute the {asset_name} asset."""\n    # TODO: Add your asset computation logic here\n    return {{}}'
        else:
            # Indent the code
            code = "\n".join(f"    {line}" if line else "" for line in code.split("\n"))

        template = f'''"""Generated Python asset."""

from dagster import asset, AssetExecutionContext
from typing import Any


{decorator_line}
{function_signature}
    """Compute the {asset_name} asset."""
{code}
'''
        return template

    def generate_sql_asset(
        self,
        asset_name: str,
        query: str,
        group_name: str = "",
        description: str = "",
        io_manager_key: str = "db_io_manager",
        deps: list[str] | None = None,
    ) -> str:
        """
        Generate a SQL asset template.

        Args:
            asset_name: Name of the asset
            query: SQL query
            group_name: Asset group
            description: Asset description
            io_manager_key: IO manager to use for SQL execution
            deps: List of asset dependencies

        Returns:
            Generated Python code
        """
        deps = deps or []

        # Build decorator parameters
        decorator_params = [f'io_manager_key="{io_manager_key}"']

        if group_name:
            decorator_params.append(f'group_name="{group_name}"')

        if description:
            decorator_params.append(f'description="{description}"')

        decorator_params.append('compute_kind="sql"')

        decorator_line = f"@asset({', '.join(decorator_params)})"

        # Build function signature with dependencies
        if deps:
            deps_params = ", ".join([f"{dep}: Any" for dep in deps])
            function_signature = f"def {asset_name}(context: AssetExecutionContext, {deps_params}):"
        else:
            function_signature = f"def {asset_name}(context: AssetExecutionContext):"

        # Escape triple quotes in query
        query = query.replace('"""', '\\"\\"\\"')

        template = f'''"""Generated SQL asset."""

from dagster import asset, AssetExecutionContext
from typing import Any


{decorator_line}
{function_signature}
    """Execute SQL query for {asset_name}."""
    query = """
{query}
    """

    return query
'''
        return template

    def generate_schedule(
        self,
        schedule_name: str,
        cron_expression: str,
        job_name: str = "",
        asset_selection: list[str] | None = None,
        description: str = "",
        timezone: str = "UTC",
        project_path: Path | None = None,
    ) -> str:
        """
        Generate a schedule component YAML template.

        Args:
            schedule_name: Name of the schedule
            cron_expression: Cron expression (e.g., "0 0 * * *")
            job_name: Name of the job to run (optional if asset_selection provided)
            asset_selection: List of assets to schedule (optional if job_name provided)
            description: Schedule description
            timezone: Timezone for schedule
            project_path: Path to project (for module name resolution)

        Returns:
            Generated YAML code
        """
        # Determine the module name
        if project_path:
            module_name = f"{project_path.name}.dagster_designer_components.ScheduleComponent"
        else:
            module_name = "dagster_designer_components.ScheduleComponent"

        config = {
            "type": module_name,
            "attributes": {
                "schedule_name": schedule_name,
                "cron_expression": cron_expression,
                "timezone": timezone,
                "default_status": "RUNNING",
            }
        }

        if job_name:
            config["attributes"]["job_name"] = job_name
        elif asset_selection:
            config["attributes"]["asset_selection"] = asset_selection
        else:
            # Default to job_name if neither provided
            config["attributes"]["job_name"] = "my_job"

        if description:
            config["attributes"]["description"] = description

        return yaml.dump(config, default_flow_style=False, sort_keys=False)

    def generate_job(
        self,
        job_name: str,
        asset_selection: list[str],
        description: str = "",
        tags: dict[str, str] | None = None,
        project_path: Path | None = None,
    ) -> str:
        """
        Generate a job component YAML template.

        Args:
            job_name: Name of the job
            asset_selection: List of asset keys to include in job
            description: Job description
            tags: Dictionary of tags
            project_path: Path to project (for module name resolution)

        Returns:
            Generated YAML code
        """
        tags = tags or {}

        # Determine the module name
        if project_path:
            module_name = f"{project_path.name}.dagster_designer_components.JobComponent"
        else:
            module_name = "dagster_designer_components.JobComponent"

        config = {
            "type": module_name,
            "attributes": {
                "job_name": job_name,
                "asset_selection": asset_selection or [],
            }
        }

        if description:
            config["attributes"]["description"] = description

        if tags:
            config["attributes"]["tags"] = tags

        return yaml.dump(config, default_flow_style=False, sort_keys=False)

    def generate_sensor(
        self,
        sensor_name: str,
        sensor_type: str,  # Accept any string for community sensors
        job_name: str,
        description: str = "",
        file_path: str = "",
        minimum_interval_seconds: int = 30,
        # S3 sensor params
        bucket_name: str = "",
        prefix: str = "",
        pattern: str = "",
        aws_region: str = "",
        since_key: str = "",
        # Email sensor params
        imap_host: str = "",
        imap_port: int = 993,
        email_user: str = "",
        email_password: str = "",
        mailbox: str = "INBOX",
        subject_pattern: str = "",
        from_pattern: str = "",
        mark_as_read: bool = True,
        # Filesystem sensor params
        directory_path: str = "",
        file_pattern: str = "*",
        recursive: bool = False,
        move_after_processing: bool = False,
        archive_directory: str = "",
        # Database sensor params
        connection_string: str = "",
        table_name: str = "",
        timestamp_column: str = "",
        query_condition: str = "",
        batch_size: int = 100,
        # Webhook sensor params
        webhook_path: str = "",
        auth_token: str = "",
        validate_signature: bool = False,
        signature_header: str = "X-Hub-Signature-256",
        secret_key: str = "",
        **kwargs,  # Accept extra attributes for community sensors
    ) -> str:
        """
        Generate a sensor template (YAML component config for all sensor types).

        Args:
            sensor_name: Name of the sensor
            sensor_type: Type of sensor (or community sensor ID)
            job_name: Job to trigger
            description: Sensor description
            file_path: File path to watch (for file sensors)
            minimum_interval_seconds: Minimum interval between evaluations
            Additional params for each sensor type
            **kwargs: Extra attributes for community sensors

        Returns:
            Generated YAML component configuration
        """
        # Built-in sensor types
        built_in_types = {"file", "run_status", "asset", "custom", "s3", "email", "filesystem", "database", "webhook"}

        # Check if this is a community sensor (not a built-in type)
        if sensor_type not in built_in_types:
            # This is a community sensor - use the component_type if provided
            component_type = kwargs.pop('component_type', f"community.{sensor_type}")

            config = {
                "type": component_type,
                "attributes": {
                    "sensor_name": sensor_name,
                    "job_name": job_name,
                    "minimum_interval_seconds": minimum_interval_seconds,
                }
            }

            # Add description if provided
            if description:
                config["attributes"]["description"] = description

            # Add all extra kwargs (community sensor specific attributes)
            for key, value in kwargs.items():
                if value not in (None, "", [], {}):  # Only include non-empty values
                    config["attributes"][key] = value

            return yaml.dump(config, default_flow_style=False, sort_keys=False)

        # For convenience sensors, generate YAML component config
        if sensor_type == "s3":
            config = {
                "type": "dagster_designer_components.S3SensorComponent",
                "attributes": {
                    "sensor_name": sensor_name,
                    "bucket_name": bucket_name,
                    "job_name": job_name,
                    "minimum_interval_seconds": minimum_interval_seconds,
                }
            }
            if prefix:
                config["attributes"]["prefix"] = prefix
            if pattern:
                config["attributes"]["pattern"] = pattern
            if aws_region:
                config["attributes"]["aws_region"] = aws_region
            if since_key:
                config["attributes"]["since_key"] = since_key

            return yaml.dump(config, default_flow_style=False, sort_keys=False)

        elif sensor_type == "email":
            config = {
                "type": "dagster_designer_components.EmailSensorComponent",
                "attributes": {
                    "sensor_name": sensor_name,
                    "imap_host": imap_host,
                    "imap_port": imap_port,
                    "email_user": email_user,
                    "email_password": email_password,
                    "mailbox": mailbox,
                    "job_name": job_name,
                    "minimum_interval_seconds": minimum_interval_seconds,
                    "mark_as_read": mark_as_read,
                }
            }
            if subject_pattern:
                config["attributes"]["subject_pattern"] = subject_pattern
            if from_pattern:
                config["attributes"]["from_pattern"] = from_pattern

            return yaml.dump(config, default_flow_style=False, sort_keys=False)

        elif sensor_type == "filesystem":
            config = {
                "type": "dagster_designer_components.FileSystemSensorComponent",
                "attributes": {
                    "sensor_name": sensor_name,
                    "directory_path": directory_path,
                    "file_pattern": file_pattern,
                    "recursive": recursive,
                    "job_name": job_name,
                    "minimum_interval_seconds": minimum_interval_seconds,
                    "move_after_processing": move_after_processing,
                }
            }
            if archive_directory:
                config["attributes"]["archive_directory"] = archive_directory

            return yaml.dump(config, default_flow_style=False, sort_keys=False)

        elif sensor_type == "database":
            config = {
                "type": "dagster_designer_components.DatabaseSensorComponent",
                "attributes": {
                    "sensor_name": sensor_name,
                    "connection_string": connection_string,
                    "table_name": table_name,
                    "timestamp_column": timestamp_column,
                    "job_name": job_name,
                    "minimum_interval_seconds": minimum_interval_seconds,
                    "batch_size": batch_size,
                }
            }
            if query_condition:
                config["attributes"]["query_condition"] = query_condition

            return yaml.dump(config, default_flow_style=False, sort_keys=False)

        elif sensor_type == "webhook":
            config = {
                "type": "dagster_designer_components.WebhookSensorComponent",
                "attributes": {
                    "sensor_name": sensor_name,
                    "webhook_path": webhook_path,
                    "job_name": job_name,
                    "validate_signature": validate_signature,
                }
            }
            if auth_token:
                config["attributes"]["auth_token"] = auth_token
            if validate_signature:
                config["attributes"]["signature_header"] = signature_header
                if secret_key:
                    config["attributes"]["secret_key"] = secret_key

            return yaml.dump(config, default_flow_style=False, sort_keys=False)

        else:
            # For basic sensor types (file, run_status, custom), generate YAML component config
            config = {
                "type": "dagster_designer_components.SensorComponent",
                "attributes": {
                    "sensor_name": sensor_name,
                    "sensor_type": sensor_type,
                    "job_name": job_name,
                    "minimum_interval_seconds": minimum_interval_seconds,
                    "default_status": "RUNNING",
                }
            }

            if description:
                config["attributes"]["description"] = description

            if file_path:
                config["attributes"]["file_path"] = file_path

            return yaml.dump(config, default_flow_style=False, sort_keys=False)

    def generate_asset_check(
        self,
        check_name: str,
        asset_name: str,
        check_type: Literal["row_count", "freshness", "schema", "custom"],
        description: str = "",
        threshold: int | None = None,
        max_age_hours: int | None = None,
        column_name: str | None = None,
    ) -> str:
        """
        Generate an asset check component YAML template.

        Args:
            check_name: Name of the check
            asset_name: Asset to check
            check_type: Type of check
            description: Check description
            threshold: Threshold for row count checks
            max_age_hours: Maximum age for freshness checks
            column_name: Column name for schema checks

        Returns:
            Generated YAML code
        """
        config = {
            "type": "dagster_designer_components.AssetCheckComponent",
            "attributes": {
                "check_name": check_name,
                "asset_name": asset_name,
                "check_type": check_type,
            }
        }

        if description:
            config["attributes"]["description"] = description

        if threshold is not None:
            config["attributes"]["threshold"] = threshold

        if max_age_hours is not None:
            config["attributes"]["max_age_hours"] = max_age_hours

        if column_name:
            config["attributes"]["column_name"] = column_name

        return yaml.dump(config, default_flow_style=False, sort_keys=False)

    def save_python_asset_to_project(
        self,
        project_id: str,
        asset_name: str,
        code: str,
    ) -> Path:
        """
        Save a Python asset to the assets folder.

        Args:
            project_id: Project ID
            asset_name: Name of the asset
            code: Generated Python code

        Returns:
            Path to the saved file
        """
        project_path = self._get_project_path(project_id)
        defs_dir = project_path / "src" / project_path.name / "defs"

        # Create assets directory
        assets_dir = defs_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        # Create __init__.py if it doesn't exist
        init_file = assets_dir / "__init__.py"
        if not init_file.exists():
            init_file.write_text("")

        # Save the asset file
        file_path = assets_dir / f"{asset_name}.py"
        file_path.write_text(code)

        return file_path

    def save_template_to_project(
        self,
        project_id: str,
        primitive_type: PrimitiveType,
        name: str,
        code: str,
    ) -> Path:
        """
        Save generated template code to a project file.

        Args:
            project_id: Project ID
            primitive_type: Type of primitive
            name: Name of the primitive
            code: Generated code (YAML for primitives, Python for assets)

        Returns:
            Path to the saved file
        """
        project_path = self._get_project_path(project_id)

        # For jobs and schedules, fix the module path in the YAML if needed
        if primitive_type in ["job", "schedule", "sensor", "asset_check"]:
            import yaml
            try:
                config = yaml.safe_load(code)
                if config and "type" in config:
                    # If the type doesn't have the project module prefix, add it
                    if not config["type"].startswith(project_path.name):
                        component_class = config["type"].split(".")[-1]  # Get JobComponent, ScheduleComponent, etc.
                        config["type"] = f"{project_path.name}.dagster_designer_components.{component_class}"
                        code = yaml.dump(config, default_flow_style=False, sort_keys=False)
            except Exception as e:
                print(f"Warning: Could not fix module path in YAML: {e}")

        # Determine file location based on primitive type
        # Try src/{project_name}/defs/ (created by tool) first
        defs_dir = project_path / "src" / project_path.name / "defs"

        # If not found, try {project_module}/defs/ (imported projects)
        if not defs_dir.exists():
            for item in project_path.iterdir():
                if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', 'dbt_project']:
                    potential_defs_dir = item / "defs"
                    if potential_defs_dir.exists():
                        defs_dir = potential_defs_dir
                        break

        if primitive_type in ["python_asset", "sql_asset"]:
            # Assets still go in assets directory as Python files
            file_dir = defs_dir / "assets"
            file_extension = ".py"

            # Create directory if it doesn't exist
            file_dir.mkdir(parents=True, exist_ok=True)

            # Create __init__.py if it doesn't exist
            init_file = file_dir / "__init__.py"
            if not init_file.exists():
                init_file.write_text("")
        elif primitive_type in ["io_manager", "resource"]:
            # IO managers and resources go in a resources.py file
            file_dir = defs_dir
            file_dir.mkdir(parents=True, exist_ok=True)

            resources_file = file_dir / "resources.py"

            # If resources.py doesn't exist, create it with a header
            if not resources_file.exists():
                resources_file.write_text('"""Resources and IO managers for this project."""\n\n')

            # Append the new code to resources.py
            existing_content = resources_file.read_text()
            if code not in existing_content:  # Avoid duplicates
                resources_file.write_text(existing_content + "\n\n" + code)

            return resources_file
        else:
            # Primitives (schedule, job, sensor, asset_check) use component instance pattern
            # Create instance folder: defs/<component_name>/defs.yaml
            file_dir = defs_dir / name
            file_extension = ".yaml"

            # Create component instance directory if it doesn't exist
            file_dir.mkdir(parents=True, exist_ok=True)

            # Install component implementations in lib directory
            self._ensure_component_implementations(project_path, primitive_type)

        # Save the template code
        # For primitives, always save as defs.yaml inside the component folder
        if primitive_type in ["schedule", "job", "sensor", "asset_check"]:
            file_path = file_dir / "defs.yaml"
        else:
            file_path = file_dir / f"{name}{file_extension}"

        file_path.write_text(code)

        return file_path

    def _ensure_component_implementations(self, project_path: Path, primitive_type: PrimitiveType):
        """
        Ensure the Python component implementations exist in the project's lib directory.

        Args:
            project_path: Path to the project directory
            primitive_type: Type of primitive (schedule, job, sensor, asset_check)
        """
        # Map primitive types to component file names
        component_files = {
            "schedule": "schedule_component.py",
            "job": "job_component.py",
            "sensor": "sensor_component.py",
            "asset_check": "asset_check_component.py",
        }

        if primitive_type not in component_files:
            return

        # Get lib directory path
        lib_dir = project_path / "src" / project_path.name / "lib"
        lib_dir.mkdir(parents=True, exist_ok=True)

        # Get dagster_designer_components subdirectory
        components_lib_dir = lib_dir / "dagster_designer_components"
        components_lib_dir.mkdir(parents=True, exist_ok=True)

        # Create __init__.py for lib if it doesn't exist
        lib_init = lib_dir / "__init__.py"
        if not lib_init.exists():
            lib_init.write_text('"""Custom components and utilities."""\n')

        # Get templates directory
        templates_dir = Path(__file__).parent.parent.parent / "templates" / "components"

        # Copy all component implementations if they don't exist
        for component_file in component_files.values():
            src_file = templates_dir / component_file
            dst_file = components_lib_dir / component_file

            if src_file.exists() and not dst_file.exists():
                dst_file.write_text(src_file.read_text())

        # Create/update __init__.py for dagster_designer_components
        init_file = components_lib_dir / "__init__.py"
        init_src = templates_dir / "__init__.py"
        if init_src.exists():
            init_file.write_text(init_src.read_text())

        # Update pyproject.toml to register the components module
        self._register_components_in_pyproject(project_path)

    def _register_components_in_pyproject(self, project_path: Path):
        """
        Update pyproject.toml to register the custom components module.

        Args:
            project_path: Path to the project directory
        """
        pyproject_path = project_path / "pyproject.toml"
        if not pyproject_path.exists():
            return

        try:
            # Load pyproject.toml
            with open(pyproject_path, 'r') as f:
                pyproject_data = toml.load(f)

            # Get the project name from the pyproject.toml
            project_name = pyproject_data.get("tool", {}).get("dg", {}).get("project", {}).get("root_module")
            if not project_name:
                return

            # Add the custom components module to registry_modules if not already present
            components_module = f"{project_name}.lib.dagster_designer_components"

            # Ensure the tool.dg.project.registry_modules list exists
            if "tool" not in pyproject_data:
                pyproject_data["tool"] = {}
            if "dg" not in pyproject_data["tool"]:
                pyproject_data["tool"]["dg"] = {}
            if "project" not in pyproject_data["tool"]["dg"]:
                pyproject_data["tool"]["dg"]["project"] = {}
            if "registry_modules" not in pyproject_data["tool"]["dg"]["project"]:
                pyproject_data["tool"]["dg"]["project"]["registry_modules"] = []

            registry_modules = pyproject_data["tool"]["dg"]["project"]["registry_modules"]

            # Add if not already present
            if components_module not in registry_modules:
                registry_modules.append(components_module)

            # Write back to pyproject.toml
            with open(pyproject_path, 'w') as f:
                toml.dump(pyproject_data, f)

        except Exception as e:
            # Log error but don't fail the operation
            print(f"Warning: Could not update pyproject.toml: {e}")

    def get_template_preview(
        self,
        primitive_type: PrimitiveType,
        params: dict[str, Any],
    ) -> str:
        """
        Get a preview of the generated template without saving.

        Args:
            primitive_type: Type of primitive
            params: Parameters for template generation

        Returns:
            Generated code
        """
        if primitive_type == "python_asset":
            return self.generate_python_asset(**params)
        elif primitive_type == "sql_asset":
            return self.generate_sql_asset(**params)
        elif primitive_type == "schedule":
            return self.generate_schedule(**params)
        elif primitive_type == "job":
            return self.generate_job(**params)
        elif primitive_type == "sensor":
            return self.generate_sensor(**params)
        elif primitive_type == "asset_check":
            return self.generate_asset_check(**params)
        elif primitive_type == "io_manager":
            return self.generate_io_manager(**params)
        elif primitive_type == "resource":
            return self.generate_resource(**params)
        else:
            raise ValueError(f"Unknown primitive type: {primitive_type}")

    def generate_io_manager(
        self,
        io_manager_name: str,
        io_manager_type: Literal[
            "filesystem", "duckdb", "duckdb_pandas", "duckdb_polars", "duckdb_pyspark",
            "snowflake", "snowflake_pandas", "snowflake_polars", "snowflake_pyspark",
            "polars", "deltalake", "deltalake_pandas", "deltalake_polars",
            "iceberg", "custom"
        ],
        description: str = "",
        base_path: str = "",
        database_path: str = "",
        account: str = "",
        user: str = "",
        password: str = "",
        database: str = "",
        schema: str = "",
        warehouse: str = "",
        table_path: str = "",
        config_params: dict[str, str] | None = None,
    ) -> str:
        """
        Generate an IO manager template.

        Args:
            io_manager_name: Name of the IO manager
            io_manager_type: Type of IO manager
            description: IO manager description
            base_path: Base path for filesystem IO manager
            database_path: Database path for DuckDB IO manager
            account: Snowflake account
            user: Database user
            password: Database password
            database: Database name
            schema: Database schema
            warehouse: Snowflake warehouse
            table_path: Path for Delta Lake or Iceberg tables
            config_params: Additional configuration parameters

        Returns:
            Generated Python code
        """
        config_params = config_params or {}

        if io_manager_type == "filesystem":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster import ConfigurableIOManager, InputContext, OutputContext
from pathlib import Path
import pickle


class {io_manager_name.title().replace("_", "")}IOManager(ConfigurableIOManager):
    """{description or f"Filesystem IO manager - {io_manager_name}"}"""

    base_path: str = "{base_path or "data"}"

    def _get_path(self, context) -> Path:
        """Get the path for a given context."""
        return Path(self.base_path) / f"{{context.asset_key.path[-1]}}.pkl"

    def handle_output(self, context: OutputContext, obj):
        """Store the output object."""
        path = self._get_path(context)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "wb") as f:
            pickle.dump(obj, f)

    def load_input(self, context: InputContext):
        """Load the input object."""
        path = self._get_path(context)

        with open(path, "rb") as f:
            return pickle.load(f)


# Create the IO manager instance
{io_manager_name} = {io_manager_name.title().replace("_", "")}IOManager()
'''
        elif io_manager_type == "duckdb":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster import ConfigurableIOManager, InputContext, OutputContext
from dagster_duckdb import DuckDBIOManager


class {io_manager_name.title().replace("_", "")}IOManager(DuckDBIOManager):
    """{description or f"DuckDB IO manager - {io_manager_name}"}"""

    database: str = "{database_path or "data/dagster.duckdb"}"


# Create the IO manager instance
{io_manager_name} = {io_manager_name.title().replace("_", "")}IOManager()
'''
        elif io_manager_type == "duckdb_pandas":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_duckdb_pandas import DuckDBPandasIOManager


# Create the IO manager instance
{io_manager_name} = DuckDBPandasIOManager(
    database="{database_path or "data/dagster.duckdb"}",
    schema="{schema or "public"}",
)
'''
        elif io_manager_type == "duckdb_polars":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_duckdb_polars import DuckDBPolarsIOManager


# Create the IO manager instance
{io_manager_name} = DuckDBPolarsIOManager(
    database="{database_path or "data/dagster.duckdb"}",
    schema="{schema or "public"}",
)
'''
        elif io_manager_type == "duckdb_pyspark":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_duckdb_pyspark import DuckDBPySparkIOManager


# Create the IO manager instance
{io_manager_name} = DuckDBPySparkIOManager(
    database="{database_path or "data/dagster.duckdb"}",
    schema="{schema or "public"}",
)
'''
        elif io_manager_type == "snowflake":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_snowflake import SnowflakeIOManager
from dagster import EnvVar


# Create the IO manager instance
{io_manager_name} = SnowflakeIOManager(
    account="{account}",
    user=EnvVar("SNOWFLAKE_USER"),
    password=EnvVar("SNOWFLAKE_PASSWORD"),
    database="{database}",
    schema="{schema or "public"}",
    warehouse="{warehouse}",
)
'''
        elif io_manager_type == "snowflake_pandas":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_snowflake_pandas import SnowflakePandasIOManager
from dagster import EnvVar


# Create the IO manager instance
{io_manager_name} = SnowflakePandasIOManager(
    account="{account}",
    user=EnvVar("SNOWFLAKE_USER"),
    password=EnvVar("SNOWFLAKE_PASSWORD"),
    database="{database}",
    schema="{schema or "public"}",
    warehouse="{warehouse}",
)
'''
        elif io_manager_type == "snowflake_polars":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_snowflake_polars import SnowflakePolarsIOManager
from dagster import EnvVar


# Create the IO manager instance
{io_manager_name} = SnowflakePolarsIOManager(
    account="{account}",
    user=EnvVar("SNOWFLAKE_USER"),
    password=EnvVar("SNOWFLAKE_PASSWORD"),
    database="{database}",
    schema="{schema or "public"}",
    warehouse="{warehouse}",
)
'''
        elif io_manager_type == "snowflake_pyspark":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_snowflake_pyspark import SnowflakePySparkIOManager
from dagster import EnvVar


# Create the IO manager instance
{io_manager_name} = SnowflakePySparkIOManager(
    account="{account}",
    user=EnvVar("SNOWFLAKE_USER"),
    password=EnvVar("SNOWFLAKE_PASSWORD"),
    database="{database}",
    schema="{schema or "public"}",
    warehouse="{warehouse}",
)
'''
        elif io_manager_type == "polars":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_polars import PolarsParquetIOManager


# Create the IO manager instance
{io_manager_name} = PolarsParquetIOManager(
    base_dir="{base_path or "data"}",
)
'''
        elif io_manager_type == "deltalake":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_deltalake import DeltaLakeIOManager


# Create the IO manager instance
{io_manager_name} = DeltaLakeIOManager(
    root_uri="{table_path or "data/deltalake"}",
    storage_options={{}},
)
'''
        elif io_manager_type == "deltalake_pandas":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_deltalake_pandas import DeltaLakePandasIOManager


# Create the IO manager instance
{io_manager_name} = DeltaLakePandasIOManager(
    root_uri="{table_path or "data/deltalake"}",
    storage_options={{}},
)
'''
        elif io_manager_type == "deltalake_polars":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_deltalake_polars import DeltaLakePolarsIOManager


# Create the IO manager instance
{io_manager_name} = DeltaLakePolarsIOManager(
    root_uri="{table_path or "data/deltalake"}",
    storage_options={{}},
)
'''
        elif io_manager_type == "iceberg":
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster_iceberg import IcebergTableIOManager


# Create the IO manager instance
{io_manager_name} = IcebergTableIOManager(
    name="default",
    config={{
        "catalog": {{
            "uri": "{table_path or "sqlite:///catalog.db"}",
            "warehouse": "file://{table_path or "data/warehouse"}",
        }},
    }},
)
'''
        else:  # custom
            template = f'''"""Generated IO Manager - {io_manager_name}."""

from dagster import ConfigurableIOManager, InputContext, OutputContext
from typing import Any


class {io_manager_name.title().replace("_", "")}IOManager(ConfigurableIOManager):
    """{description or f"Custom IO manager - {io_manager_name}"}"""

    # Add your configuration fields here
    # Example: database_url: str = "postgresql://localhost/mydb"

    def handle_output(self, context: OutputContext, obj: Any):
        """Store the output object."""
        # TODO: Implement output handling logic
        # Example: store obj to database, cloud storage, etc.
        pass

    def load_input(self, context: InputContext) -> Any:
        """Load the input object."""
        # TODO: Implement input loading logic
        # Example: load obj from database, cloud storage, etc.
        return None


# Create the IO manager instance
{io_manager_name} = {io_manager_name.title().replace("_", "")}IOManager()
'''

        return template

    def generate_resource(
        self,
        resource_name: str,
        resource_type: Literal[
            "database", "api_client",
            "airbyte", "fivetran", "census", "hightouch",
            "databricks", "snowflake_resource",
            "aws_s3", "aws_athena", "gcp_bigquery", "gcp_gcs", "azure_blob",
            "dbt", "sling",
            "custom"
        ],
        description: str = "",
        connection_string: str = "",
        api_key: str = "",
        api_url: str = "",
        # Cloud provider fields
        account_id: str = "",
        region: str = "",
        project_id: str = "",
        # Integration specific
        workspace_id: str = "",
        host: str = "",
        token: str = "",
        config_params: dict[str, str] | None = None,
    ) -> str:
        """
        Generate a resource template.

        Args:
            resource_name: Name of the resource
            resource_type: Type of resource
            description: Resource description
            connection_string: Database connection string
            api_key: API key for API client resources
            api_url: API URL for API client resources
            account_id: Cloud account ID
            region: Cloud region
            project_id: GCP project ID
            workspace_id: Workspace ID (Airbyte, Databricks)
            host: Host URL
            token: Access token
            config_params: Additional configuration parameters

        Returns:
            Generated Python code
        """
        config_params = config_params or {}

        if resource_type == "database":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster import ConfigurableResource
from contextlib import contextmanager
from typing import Any
import duckdb  # Or other database library


class {resource_name.title().replace("_", "")}Resource(ConfigurableResource):
    """{description or f"Database resource - {resource_name}"}"""

    connection_string: str = "{connection_string or "data/database.duckdb"}"

    @contextmanager
    def get_connection(self):
        """Get a database connection."""
        conn = duckdb.connect(self.connection_string)
        try:
            yield conn
        finally:
            conn.close()

    def execute_query(self, query: str) -> Any:
        """Execute a SQL query."""
        with self.get_connection() as conn:
            return conn.execute(query).fetchall()


# Create the resource instance
{resource_name} = {resource_name.title().replace("_", "")}Resource()
'''
        elif resource_type == "api_client":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster import ConfigurableResource
import requests
from typing import Any


class {resource_name.title().replace("_", "")}Resource(ConfigurableResource):
    """{description or f"API client resource - {resource_name}"}"""

    api_url: str = "{api_url or "https://api.example.com"}"
    api_key: str = "{api_key}"

    def get(self, endpoint: str, **kwargs) -> Any:
        """Make a GET request."""
        headers = {{"Authorization": f"Bearer {{self.api_key}}"}}
        response = requests.get(f"{{self.api_url}}/{{endpoint}}", headers=headers, **kwargs)
        response.raise_for_status()
        return response.json()

    def post(self, endpoint: str, data: dict, **kwargs) -> Any:
        """Make a POST request."""
        headers = {{"Authorization": f"Bearer {{self.api_key}}"}}
        response = requests.post(f"{{self.api_url}}/{{endpoint}}", json=data, headers=headers, **kwargs)
        response.raise_for_status()
        return response.json()


# Create the resource instance
{resource_name} = {resource_name.title().replace("_", "")}Resource()
'''
        elif resource_type == "airbyte":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_airbyte import AirbyteResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = AirbyteResource(
    host="{host or "localhost"}",
    port="{api_url or "8000"}",
    username=EnvVar("AIRBYTE_USERNAME"),
    password=EnvVar("AIRBYTE_PASSWORD"),
)
'''
        elif resource_type == "fivetran":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_fivetran import FivetranResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = FivetranResource(
    api_key=EnvVar("FIVETRAN_API_KEY"),
    api_secret=EnvVar("FIVETRAN_API_SECRET"),
)
'''
        elif resource_type == "census":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_census import CensusResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = CensusResource(
    api_key=EnvVar("CENSUS_API_KEY"),
)
'''
        elif resource_type == "hightouch":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_hightouch import HightouchResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = HightouchResource(
    api_key=EnvVar("HIGHTOUCH_API_KEY"),
)
'''
        elif resource_type == "databricks":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_databricks import DatabricksClientResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = DatabricksClientResource(
    host="{host or "https://your-workspace.cloud.databricks.com"}",
    token=EnvVar("DATABRICKS_TOKEN"),
)
'''
        elif resource_type == "snowflake_resource":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_snowflake import SnowflakeResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = SnowflakeResource(
    account="{account_id}",
    user=EnvVar("SNOWFLAKE_USER"),
    password=EnvVar("SNOWFLAKE_PASSWORD"),
    database="{connection_string or "analytics"}",
    warehouse="{workspace_id or "compute_wh"}",
)
'''
        elif resource_type == "aws_s3":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_aws.s3 import S3Resource
from dagster import EnvVar


# Create the resource instance
{resource_name} = S3Resource(
    region_name="{region or "us-east-1"}",
    aws_access_key_id=EnvVar("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=EnvVar("AWS_SECRET_ACCESS_KEY"),
)
'''
        elif resource_type == "aws_athena":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_aws.athena import AthenaResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = AthenaResource(
    region_name="{region or "us-east-1"}",
    database="{connection_string or "default"}",
    workgroup="{workspace_id or "primary"}",
    aws_access_key_id=EnvVar("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=EnvVar("AWS_SECRET_ACCESS_KEY"),
)
'''
        elif resource_type == "gcp_bigquery":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_gcp import BigQueryResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = BigQueryResource(
    project="{project_id}",
    location="{region or "US"}",
)
'''
        elif resource_type == "gcp_gcs":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_gcp import GCSResource


# Create the resource instance
{resource_name} = GCSResource(
    project="{project_id}",
)
'''
        elif resource_type == "azure_blob":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_azure.blob import AzureBlobStorageResource
from dagster import EnvVar


# Create the resource instance
{resource_name} = AzureBlobStorageResource(
    storage_account="{account_id}",
    credential=EnvVar("AZURE_STORAGE_KEY"),
)
'''
        elif resource_type == "dbt":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_dbt import DbtCliResource


# Create the resource instance
{resource_name} = DbtCliResource(
    project_dir="{connection_string or "dbt_project"}",
    profiles_dir="{api_url or "~/.dbt"}",
)
'''
        elif resource_type == "sling":
            template = f'''"""Generated Resource - {resource_name}."""

from dagster_sling import SlingResource


# Create the resource instance
{resource_name} = SlingResource(
    connections=[
        # Add your Sling connections here
        # Example:
        # {{
        #     "name": "MY_POSTGRES",
        #     "type": "postgres",
        #     "host": "localhost",
        #     "port": 5432,
        #     "database": "my_database",
        #     "user": "user",
        #     "password": "password",
        # }}
    ],
)
'''
        else:  # custom
            template = f'''"""Generated Resource - {resource_name}."""

from dagster import ConfigurableResource
from typing import Any


class {resource_name.title().replace("_", "")}Resource(ConfigurableResource):
    """{description or f"Custom resource - {resource_name}"}"""

    # Add your configuration fields here
    # Example: api_key: str
    # Example: timeout: int = 30

    def setup(self):
        """Initialize the resource."""
        # TODO: Add initialization logic
        pass

    def teardown(self):
        """Clean up the resource."""
        # TODO: Add cleanup logic
        pass


# Create the resource instance
{resource_name} = {resource_name.title().replace("_", "")}Resource()
'''

        return template
