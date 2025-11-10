"""Component registry service for discovering and introspecting Dagster components."""

import importlib
import inspect
import pkgutil
import sys
from typing import Any
from pydantic import BaseModel

from ..models.component import ComponentSchema


class ComponentRegistry:
    """Registry of available Dagster components."""

    # Mapping of component types to their required dependencies
    COMPONENT_DEPENDENCIES = {
        "dagster_dbt.DbtProjectComponent": ["dagster-dbt>=0.25.0", "dbt-duckdb>=1.8.0"],
        "dagster_fivetran.FivetranConnector": ["dagster-fivetran>=0.25.0"],
        "dagster_sling.SlingReplication": ["dagster-sling>=0.25.0"],
        "dagster_dlt.DltPipeline": ["dagster-dlt>=0.25.0"],
        "dagster_airbyte.AirbyteResource": ["dagster-airbyte>=0.25.0"],
        "dagster_snowflake.SnowflakeIOManager": ["dagster-snowflake>=0.25.0"],
        "dagster_tableau.TableauResource": ["dagster-tableau"],
        "dagster_looker.LookerResource": ["dagster-looker"],
        "dagster_powerbi.PowerBIResource": ["dagster-powerbi"],
        "dagster_sigma.SigmaResource": ["dagster-sigma"],
        "dagster_omni.OmniResource": ["dagster-omni"],
        "dagster_hex.HexResource": ["dagster-hex"],
        "dagster_cube.CubeResource": ["dagster-cube"],
        "dagster_census.CensusResource": ["dagster-census"],
        "dagster_hightouch.HightouchResource": ["dagster-hightouch"],
        "dagster_meltano.MeltanoResource": ["dagster-meltano"],
    }

    def __init__(self):
        self._components: dict[str, ComponentSchema] = {}
        self._initialized = False

    def initialize(self):
        """Discover and register all available Dagster components."""
        if self._initialized:
            return

        # Try to use Dagster's built-in component registry
        try:
            from dagster._core.definitions.component_def import get_registered_component_types

            registered_types = get_registered_component_types()
            for component_type in registered_types:
                self._register_from_type(component_type)

        except (ImportError, AttributeError):
            # Fallback to manual registration
            pass

        # Dynamically discover components from installed dagster packages
        self._discover_installed_components()

        # Also register known component types manually (as fallback)
        self._register_known_components()

        self._initialized = True

    def _discover_installed_components(self):
        """Dynamically discover components from all installed dagster-* packages."""
        # Get all installed packages
        installed_packages = {}
        for module_info in pkgutil.iter_modules():
            if module_info.name.startswith('dagster_') or module_info.name == 'dagster':
                installed_packages[module_info.name] = module_info

        # Known component-based integration packages to scan
        # This maps package names to their typical component classes
        component_patterns = {
            'dagster_dbt': ['DbtProjectComponent', 'DbtProject'],
            'dagster_fivetran': ['FivetranResource', 'FivetranConnector'],
            'dagster_sling': ['SlingResource', 'SlingReplication'],
            'dagster_dlt': ['DltResource', 'DltPipeline'],
            'dagster_airbyte': ['AirbyteResource', 'AirbyteConnection'],
            'dagster_snowflake': ['SnowflakeResource', 'SnowflakeIOManager'],
            'dagster_tableau': ['TableauResource', 'TableauWorkbook'],
            'dagster_looker': ['LookerResource', 'LookerView'],
            'dagster_powerbi': ['PowerBIResource', 'PowerBIWorkspace'],
            'dagster_sigma': ['SigmaResource', 'SigmaWorkbook'],
            'dagster_omni': ['OmniResource'],
            'dagster_hex': ['HexResource'],
            'dagster_cube': ['CubeResource'],
            'dagster_census': ['CensusResource'],
            'dagster_hightouch': ['HightouchResource'],
            'dagster_meltano': ['MeltanoResource'],
        }

        # Scan each installed dagster package
        for package_name, patterns in component_patterns.items():
            if package_name not in installed_packages:
                continue

            # Determine category from package name
            category = package_name.replace('dagster_', '')

            # Try to import and scan the module
            try:
                module = importlib.import_module(package_name)

                # Look for known component class patterns
                for pattern in patterns:
                    if hasattr(module, pattern):
                        component_class = getattr(module, pattern)
                        if self._is_dagster_component(component_class):
                            self._register_component(component_class, package_name, category)

                # Also scan all members for components
                for name, obj in inspect.getmembers(module):
                    if self._is_dagster_component(obj) and not name.startswith('_'):
                        self._register_component(obj, package_name, category)

            except (ImportError, AttributeError) as e:
                # Package installed but can't import - skip
                continue

    def _register_known_components(self):
        """Register known Dagster components manually."""
        known_components = [
            {
                "name": "dbt",
                "type": "dagster_dbt.DbtProjectComponent",
                "module": "dagster_dbt",
                "category": "dbt",
                "description": "dbt project component for materializing models and tests",
                "icon": "database",
                "schema": {
                    "properties": {
                        "project_path": {
                            "type": "string",
                            "description": "Path to your dbt project directory relative to the Dagster project root",
                        },
                        "select": {
                            "type": "string",
                            "description": "dbt selection string to filter which models to materialize (e.g., 'customers' or 'tag:daily')",
                        },
                        "exclude": {
                            "type": "string",
                            "description": "dbt exclusion string to exclude specific models from materialization",
                        },
                        "cli_args": {
                            "type": "array",
                            "description": "Additional command-line arguments to pass to dbt commands",
                        },
                    },
                    "required": ["project_path"],
                },
            },
            {
                "name": "fivetran",
                "type": "dagster_fivetran.FivetranConnector",
                "module": "dagster_fivetran",
                "category": "fivetran",
                "description": "Fivetran connector component for syncing data from 150+ sources",
                "icon": "sync",
                "schema": {
                    "properties": {
                        "connector_id": {
                            "type": "string",
                            "description": "The unique identifier for your Fivetran connector",
                        },
                        "api_key": {
                            "type": "string",
                            "description": "Fivetran API key (use {{ env.FIVETRAN_API_KEY }} for environment variable)",
                        },
                        "api_secret": {
                            "type": "string",
                            "description": "Fivetran API secret (use {{ env.FIVETRAN_API_SECRET }} for environment variable)",
                        },
                    },
                    "required": ["connector_id"],
                },
            },
            {
                "name": "sling",
                "type": "dagster_sling.SlingReplication",
                "module": "dagster_sling",
                "category": "sling",
                "description": "Sling replication component for data sync and replication",
                "icon": "arrow-right",
                "schema": {
                    "properties": {
                        "replication_config": {
                            "type": "string",
                            "description": "Path to your Sling replication YAML configuration file",
                        },
                        "source_connection": {
                            "type": "string",
                            "description": "Source database connection string or name",
                        },
                        "target_connection": {
                            "type": "string",
                            "description": "Target database connection string or name",
                        },
                    },
                    "required": ["replication_config"],
                },
            },
            {
                "name": "dlt",
                "type": "dagster_dlt.DltPipeline",
                "module": "dagster_dlt",
                "category": "dlt",
                "description": "Data Load Tool (dlt) pipeline component",
                "icon": "download",
                "schema": {
                    "properties": {
                        "pipeline_name": {
                            "type": "string",
                            "description": "Name of your dlt pipeline",
                        },
                        "source": {
                            "type": "string",
                            "description": "dlt source function or module path",
                        },
                        "destination": {
                            "type": "string",
                            "description": "Target destination for data (e.g., 'duckdb', 'bigquery', 'snowflake')",
                        },
                    },
                    "required": ["pipeline_name", "source", "destination"],
                },
            },
            {
                "name": "airbyte",
                "type": "dagster_airbyte.AirbyteResource",
                "module": "dagster_airbyte",
                "category": "airbyte",
                "description": "Airbyte connector component for syncing data with open-source connectors",
                "icon": "sync",
                "schema": {
                    "properties": {
                        "connection_id": {
                            "type": "string",
                            "description": "The unique identifier for your Airbyte connection",
                        },
                        "host": {
                            "type": "string",
                            "description": "Airbyte server host (e.g., 'localhost' or your cloud instance)",
                        },
                        "port": {
                            "type": "string",
                            "description": "Airbyte server port (default: '8000')",
                        },
                    },
                    "required": ["connection_id", "host"],
                },
            },
            {
                "name": "snowflake",
                "type": "dagster_snowflake.SnowflakeIOManager",
                "module": "dagster_snowflake",
                "category": "snowflake",
                "description": "Snowflake data warehouse I/O manager for reading and writing data",
                "icon": "database",
                "schema": {
                    "properties": {
                        "account": {
                            "type": "string",
                            "description": "Your Snowflake account identifier",
                        },
                        "user": {
                            "type": "string",
                            "description": "Snowflake username (use {{ env.SNOWFLAKE_USER }} for environment variable)",
                        },
                        "password": {
                            "type": "string",
                            "description": "Snowflake password (use {{ env.SNOWFLAKE_PASSWORD }} for environment variable)",
                        },
                        "database": {
                            "type": "string",
                            "description": "Snowflake database name",
                        },
                        "schema": {
                            "type": "string",
                            "description": "Snowflake schema name",
                        },
                        "warehouse": {
                            "type": "string",
                            "description": "Snowflake warehouse to use for compute",
                        },
                    },
                    "required": ["account", "user", "database"],
                },
            },
            {
                "name": "Python Script",
                "type": "dagster.PythonScriptComponent",
                "module": "dagster",
                "category": "primitives",
                "description": "Execute a Python script with dagster-pipes subprocess",
                "icon": "code",
                "schema": {
                    "properties": {
                        "execution": {
                            "type": "object",
                            "description": "Script execution configuration",
                            "properties": {
                                "path": {
                                    "type": "string",
                                    "description": "Path to Python script file (e.g., 'scripts/update_table.py')",
                                },
                                "args": {
                                    "type": "array",
                                    "description": "Command-line arguments to pass to the script",
                                    "items": {"type": "string"},
                                },
                                "name": {
                                    "type": "string",
                                    "description": "Name for the op that runs the script",
                                },
                            },
                        },
                        "assets": {
                            "type": "array",
                            "description": "Assets produced by this script",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "key": {
                                        "type": "string",
                                        "description": "Asset key (e.g., 'my_table')",
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "Asset description",
                                    },
                                    "group_name": {
                                        "type": "string",
                                        "description": "Asset group for organization",
                                    },
                                    "owners": {
                                        "type": "array",
                                        "description": "Asset owners (e.g., 'team:analytics', 'user@company.com')",
                                        "items": {"type": "string"},
                                    },
                                    "tags": {
                                        "type": "object",
                                        "description": "Asset tags for metadata",
                                    },
                                },
                            },
                        },
                    },
                    "required": ["execution"],
                },
            },
            {
                "name": "Templated SQL",
                "type": "dagster.TemplatedSqlComponent",
                "module": "dagster",
                "category": "primitives",
                "description": "Execute templated SQL from a string or file",
                "icon": "database",
                "schema": {
                    "properties": {
                        "connection": {
                            "type": "string",
                            "description": "The SQL connection to use for executing the SQL content",
                        },
                        "sql_template": {
                            "type": "string",
                            "description": "The SQL template to execute (can use Jinja2 templating)",
                            "multiline": True,
                        },
                        "sql_template_vars": {
                            "type": "object",
                            "description": "Variables to pass to the SQL template (key-value pairs)",
                        },
                        "execution": {
                            "type": "object",
                            "description": "Execution configuration for the SQL op",
                            "properties": {
                                "name": {
                                    "type": "string",
                                    "description": "Name for the op that runs the SQL",
                                },
                                "tags": {
                                    "type": "object",
                                    "description": "Tags for the op",
                                },
                                "description": {
                                    "type": "string",
                                    "description": "Description of the op",
                                },
                            },
                        },
                        "assets": {
                            "type": "array",
                            "description": "Assets produced by this SQL execution",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "key": {
                                        "type": "string",
                                        "description": "Asset key (e.g., 'my_table')",
                                    },
                                    "description": {
                                        "type": "string",
                                        "description": "Asset description",
                                    },
                                    "group_name": {
                                        "type": "string",
                                        "description": "Asset group for organization",
                                    },
                                    "owners": {
                                        "type": "array",
                                        "description": "Asset owners (e.g., 'team:analytics', 'user@company.com')",
                                        "items": {"type": "string"},
                                    },
                                    "tags": {
                                        "type": "object",
                                        "description": "Asset tags for metadata",
                                    },
                                },
                            },
                        },
                    },
                    "required": ["connection", "sql_template"],
                },
            },
            {
                "name": "Job",
                "type": "job",
                "module": "dagster_designer_components",
                "category": "primitives",
                "description": "Create a job to execute a selection of assets",
                "icon": "play",
                "schema": {
                    "properties": {
                        "job_name": {
                            "type": "string",
                            "description": "Unique name for the job",
                        },
                        "asset_selection": {
                            "type": "array",
                            "description": "Assets to include in this job (multi-select or Dagster filter)",
                        },
                        "description": {
                            "type": "string",
                            "description": "Description of what this job does",
                        },
                        "tags": {
                            "type": "object",
                            "description": "Key-value tags for metadata",
                        },
                        "config": {
                            "type": "object",
                            "description": "Job configuration (advanced)",
                        },
                    },
                    "required": ["job_name", "asset_selection"],
                },
            },
            {
                "name": "Schedule",
                "type": "schedule",
                "module": "dagster_designer_components",
                "category": "primitives",
                "description": "Create a schedule to run jobs or assets on a cron schedule",
                "icon": "clock",
                "schema": {
                    "properties": {
                        "schedule_name": {
                            "type": "string",
                            "description": "Unique name for the schedule",
                        },
                        "cron_expression": {
                            "type": "string",
                            "description": "Cron expression (e.g., '0 0 * * *' for daily at midnight)",
                        },
                        "job_name": {
                            "type": "string",
                            "description": "Name of the job to run (leave empty to select assets directly)",
                        },
                        "asset_selection": {
                            "type": "array",
                            "description": "Assets to materialize (alternative to job_name)",
                        },
                        "description": {
                            "type": "string",
                            "description": "Description of when/why this schedule runs",
                        },
                        "timezone": {
                            "type": "string",
                            "description": "Timezone for the schedule (e.g., 'UTC', 'America/New_York')",
                        },
                    },
                    "required": ["schedule_name", "cron_expression"],
                },
            },
            {
                "name": "Sensor",
                "type": "sensor",
                "module": "dagster_designer_components",
                "category": "primitives",
                "description": "Create a sensor to trigger jobs based on events",
                "icon": "radar",
                "schema": {
                    "properties": {
                        "sensor_name": {
                            "type": "string",
                            "description": "Unique name for the sensor",
                        },
                        "sensor_type": {
                            "type": "string",
                            "description": "Type of sensor (file, run_status, custom)",
                        },
                        "job_name": {
                            "type": "string",
                            "description": "Name of the job to trigger",
                        },
                        "description": {
                            "type": "string",
                            "description": "Description of what this sensor monitors",
                        },
                        "file_path": {
                            "type": "string",
                            "description": "File path to monitor (for file sensors)",
                        },
                        "monitored_job_name": {
                            "type": "string",
                            "description": "Name of the job to monitor (for run_status sensors)",
                        },
                        "run_status": {
                            "type": "string",
                            "description": "Run status to monitor: SUCCESS, FAILURE, or CANCELED (for run_status sensors, default: SUCCESS)",
                        },
                        "minimum_interval_seconds": {
                            "type": "number",
                            "description": "Minimum interval between sensor evaluations (default: 30)",
                        },
                    },
                    "required": ["sensor_name", "sensor_type", "job_name"],
                },
            },
            {
                "name": "S3 Bucket Sensor",
                "type": "dagster_designer_components.S3SensorComponent",
                "module": "dagster_designer_components",
                "category": "sensors",
                "description": "Monitors an S3 bucket for new or modified objects matching a pattern",
                "icon": "cloud",
                "schema": {
                    "properties": {
                        "sensor_name": {
                            "type": "string",
                            "description": "Unique name for the sensor",
                        },
                        "bucket_name": {
                            "type": "string",
                            "description": "S3 bucket name to monitor",
                        },
                        "prefix": {
                            "type": "string",
                            "description": "Object key prefix filter (e.g., 'uploads/')",
                        },
                        "pattern": {
                            "type": "string",
                            "description": "Regex pattern to match object keys (e.g., '.*\\.csv$')",
                        },
                        "job_name": {
                            "type": "string",
                            "description": "Name of the job to trigger when new objects are found",
                        },
                        "minimum_interval_seconds": {
                            "type": "number",
                            "description": "How often to check for new objects (default: 30)",
                        },
                        "aws_region": {
                            "type": "string",
                            "description": "AWS region (e.g., 'us-east-1')",
                        },
                    },
                    "required": ["sensor_name", "bucket_name", "job_name"],
                },
            },
            {
                "name": "Email Inbox Sensor",
                "type": "dagster_designer_components.EmailSensorComponent",
                "module": "dagster_designer_components",
                "category": "sensors",
                "description": "Monitors an email inbox (IMAP) for new emails matching criteria",
                "icon": "mail",
                "schema": {
                    "properties": {
                        "sensor_name": {
                            "type": "string",
                            "description": "Unique name for the sensor",
                        },
                        "imap_host": {
                            "type": "string",
                            "description": "IMAP server hostname (e.g., 'imap.gmail.com')",
                        },
                        "imap_port": {
                            "type": "number",
                            "description": "IMAP server port (default: 993)",
                        },
                        "email_user": {
                            "type": "string",
                            "description": "Email username (use ${EMAIL_USER} for env var)",
                        },
                        "email_password": {
                            "type": "string",
                            "description": "Email password (use ${EMAIL_PASSWORD} for env var)",
                        },
                        "mailbox": {
                            "type": "string",
                            "description": "Mailbox/folder to monitor (default: 'INBOX')",
                        },
                        "subject_pattern": {
                            "type": "string",
                            "description": "Regex pattern to match email subjects",
                        },
                        "from_pattern": {
                            "type": "string",
                            "description": "Regex pattern to match sender email addresses",
                        },
                        "job_name": {
                            "type": "string",
                            "description": "Name of the job to trigger when matching emails are found",
                        },
                        "minimum_interval_seconds": {
                            "type": "number",
                            "description": "How often to check for new emails (default: 60)",
                        },
                        "mark_as_read": {
                            "type": "boolean",
                            "description": "Mark processed emails as read (default: true)",
                        },
                    },
                    "required": ["sensor_name", "imap_host", "email_user", "email_password", "job_name"],
                },
            },
            {
                "name": "File System Sensor",
                "type": "dagster_designer_components.FileSystemSensorComponent",
                "module": "dagster_designer_components",
                "category": "sensors",
                "description": "Monitors a local or network file system directory for new files",
                "icon": "folder",
                "schema": {
                    "properties": {
                        "sensor_name": {
                            "type": "string",
                            "description": "Unique name for the sensor",
                        },
                        "directory_path": {
                            "type": "string",
                            "description": "Path to the directory to monitor (e.g., '/data/incoming')",
                        },
                        "file_pattern": {
                            "type": "string",
                            "description": "Glob pattern to match files (e.g., '*.csv', '*.json')",
                        },
                        "recursive": {
                            "type": "boolean",
                            "description": "Monitor subdirectories recursively (default: false)",
                        },
                        "job_name": {
                            "type": "string",
                            "description": "Name of the job to trigger when new files are detected",
                        },
                        "minimum_interval_seconds": {
                            "type": "number",
                            "description": "How often to check for new files (default: 30)",
                        },
                        "move_after_processing": {
                            "type": "boolean",
                            "description": "Move files to archive directory after processing (default: false)",
                        },
                        "archive_directory": {
                            "type": "string",
                            "description": "Directory to move processed files to",
                        },
                    },
                    "required": ["sensor_name", "directory_path", "job_name"],
                },
            },
            {
                "name": "Database Table Sensor",
                "type": "dagster_designer_components.DatabaseSensorComponent",
                "module": "dagster_designer_components",
                "category": "sensors",
                "description": "Monitors a database table for new rows or changes",
                "icon": "database",
                "schema": {
                    "properties": {
                        "sensor_name": {
                            "type": "string",
                            "description": "Unique name for the sensor",
                        },
                        "connection_string": {
                            "type": "string",
                            "description": "SQLAlchemy connection string (use ${DATABASE_URL} for env var)",
                        },
                        "table_name": {
                            "type": "string",
                            "description": "Name of the table to monitor",
                        },
                        "timestamp_column": {
                            "type": "string",
                            "description": "Column name for tracking new rows (e.g., 'created_at')",
                        },
                        "query_condition": {
                            "type": "string",
                            "description": "Additional SQL WHERE condition",
                        },
                        "job_name": {
                            "type": "string",
                            "description": "Name of the job to trigger when new rows are detected",
                        },
                        "minimum_interval_seconds": {
                            "type": "number",
                            "description": "How often to check for new rows (default: 60)",
                        },
                        "batch_size": {
                            "type": "number",
                            "description": "Maximum number of rows to process per run (default: 100)",
                        },
                    },
                    "required": ["sensor_name", "connection_string", "table_name", "timestamp_column", "job_name"],
                },
            },
            {
                "name": "Webhook Sensor",
                "type": "dagster_designer_components.WebhookSensorComponent",
                "module": "dagster_designer_components",
                "category": "sensors",
                "description": "Listens for HTTP webhook callbacks and triggers jobs",
                "icon": "link",
                "schema": {
                    "properties": {
                        "sensor_name": {
                            "type": "string",
                            "description": "Unique name for the sensor",
                        },
                        "webhook_path": {
                            "type": "string",
                            "description": "URL path for the webhook endpoint (e.g., '/webhooks/my-webhook')",
                        },
                        "job_name": {
                            "type": "string",
                            "description": "Name of the job to trigger when webhook is called",
                        },
                        "auth_token": {
                            "type": "string",
                            "description": "Optional bearer token for authentication (use ${WEBHOOK_TOKEN} for env var)",
                        },
                        "validate_signature": {
                            "type": "boolean",
                            "description": "Validate webhook signature (GitHub style, default: false)",
                        },
                        "signature_header": {
                            "type": "string",
                            "description": "HTTP header containing the signature (default: 'X-Hub-Signature-256')",
                        },
                        "secret_key": {
                            "type": "string",
                            "description": "Secret key for signature validation (use ${WEBHOOK_SECRET} for env var)",
                        },
                    },
                    "required": ["sensor_name", "webhook_path", "job_name"],
                },
            },
            {
                "name": "Asset Check",
                "type": "asset_check",
                "module": "dagster_designer_components",
                "category": "primitives",
                "description": "Create a data quality check for an asset",
                "icon": "check-circle",
                "schema": {
                    "properties": {
                        "check_name": {
                            "type": "string",
                            "description": "Unique name for the check",
                        },
                        "asset_name": {
                            "type": "string",
                            "description": "Asset to check",
                        },
                        "check_type": {
                            "type": "string",
                            "description": "Type of check (row_count, freshness, schema, custom)",
                        },
                        "description": {
                            "type": "string",
                            "description": "Description of what this check validates",
                        },
                        "threshold": {
                            "type": "number",
                            "description": "Threshold value (for row_count checks)",
                        },
                        "max_age_hours": {
                            "type": "number",
                            "description": "Maximum age in hours (for freshness checks)",
                        },
                    },
                    "required": ["check_name", "asset_name", "check_type"],
                },
            },
        ]

        for comp_def in known_components:
            # Built-in components (custom, primitives, and sensors categories) don't need module import check
            is_builtin = comp_def["category"] in ("custom", "primitives", "sensors")

            # Check if the module is installed (skip for built-in components)
            if not is_builtin:
                try:
                    importlib.import_module(comp_def["module"])
                except ImportError:
                    # Module not installed, skip
                    continue

            # Register the component
            if comp_def["type"] not in self._components:
                self._components[comp_def["type"]] = ComponentSchema(
                    name=comp_def["name"],
                    module=comp_def["module"],
                    type=comp_def["type"],
                    description=comp_def["description"],
                    category=comp_def["category"],
                    icon=comp_def["icon"],
                    schema=comp_def["schema"],
                )

    def _register_from_type(self, component_type: str):
        """Register a component from its type string."""
        try:
            module_name, class_name = component_type.rsplit(".", 1)
            module = importlib.import_module(module_name)
            component_class = getattr(module, class_name, None)

            if component_class:
                category = module_name.split("_")[-1] if "_" in module_name else "other"
                self._register_component(component_class, module_name, category)
        except Exception:
            # Skip if unable to import
            pass

    def _scan_module(self, module_name: str, category: str):
        """Scan a module for Dagster components."""
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            # Module not installed, skip
            return

        # Look for Component classes
        for name, obj in inspect.getmembers(module):
            if self._is_dagster_component(obj):
                self._register_component(obj, module_name, category)

    def _is_dagster_component(self, obj: Any) -> bool:
        """Check if an object is a Dagster component."""
        if not inspect.isclass(obj):
            return False

        # Check if it has the Component base and build_defs method
        base_names = [base.__name__ for base in inspect.getmro(obj)]
        has_component = "Component" in base_names
        has_build_defs = hasattr(obj, "build_defs")

        return has_component and has_build_defs

    def _register_component(self, component_class: type, module_name: str, category: str):
        """Register a component class."""
        class_name = component_class.__name__

        # Skip if already registered
        component_type = f"{module_name}.{class_name}"
        if component_type in self._components:
            return

        # Extract schema from Pydantic model
        schema = self._extract_schema(component_class)
        if not schema:
            return

        # Get docstring
        description = inspect.getdoc(component_class)

        # Determine icon based on category
        icon_map = {
            "dbt": "database",
            "fivetran": "sync",
            "sling": "arrow-right",
            "dlt": "download",
            "airbyte": "sync",
            "snowflake": "database",
            "tableau": "file-text",
            "looker": "file-text",
            "powerbi": "file-text",
            "sigma": "file-text",
            "omni": "file-text",
            "hex": "code",
            "cube": "cube",
            "census": "sync",
            "hightouch": "sync",
            "meltano": "sync",
        }

        component_schema = ComponentSchema(
            name=class_name,
            module=module_name,
            type=component_type,
            description=description,
            schema=schema,
            category=category,
            icon=icon_map.get(category, "cube"),
        )

        self._components[component_type] = component_schema

    def _extract_schema(self, component_class: type) -> dict[str, Any] | None:
        """Extract JSON schema from a component's Pydantic model."""
        try:
            # Check if it's a Pydantic model
            if issubclass(component_class, BaseModel):
                return component_class.model_json_schema()
        except (TypeError, AttributeError):
            pass

        return None

    def get_all_components(self) -> list[ComponentSchema]:
        """Get all registered components."""
        self.initialize()
        return list(self._components.values())

    def get_component(self, component_type: str) -> ComponentSchema | None:
        """Get a specific component by type."""
        self.initialize()
        return self._components.get(component_type)

    def get_components_by_category(self, category: str) -> list[ComponentSchema]:
        """Get all components in a category."""
        self.initialize()
        return [c for c in self._components.values() if c.category == category]

    def get_dependencies(self, component_type: str) -> list[str]:
        """Get the required dependencies for a component type.

        Args:
            component_type: The component type (e.g., "dagster_dbt.DbtProject")

        Returns:
            List of dependency strings (e.g., ["dagster-dbt>=0.25.0"])
        """
        return self.COMPONENT_DEPENDENCIES.get(component_type, [])


# Global registry instance
component_registry = ComponentRegistry()
