"""Detect dbt adapters and environment variables from dbt Cloud environments"""

from typing import List, Dict, Any, Set, Optional


# Mapping of dbt Cloud connection types to dbt adapter packages
# Based on: https://docs.getdbt.com/docs/cloud/connect-data-platform/about-connections
ADAPTER_MAPPING = {
    "snowflake": "dbt-snowflake",
    "bigquery": "dbt-bigquery",
    "postgres": "dbt-postgres",
    "alloydb": "dbt-postgres",  # AlloyDB uses PostgreSQL adapter
    "redshift": "dbt-redshift",
    "databricks": "dbt-databricks",
    "spark": "dbt-spark",
    "apache_spark": "dbt-spark",
    "duckdb": "dbt-duckdb",
    "sqlserver": "dbt-sqlserver",
    "synapse": "dbt-sqlserver",  # Azure Synapse uses SQL Server adapter
    "azure_synapse": "dbt-sqlserver",
    "fabric": "dbt-sqlserver",  # Microsoft Fabric uses SQL Server adapter
    "microsoft_fabric": "dbt-sqlserver",
    "oracle": "dbt-oracle",
    "athena": "dbt-athena",
    "trino": "dbt-trino",
    "starburst": "dbt-trino",  # Starburst uses Trino adapter
    "clickhouse": "dbt-clickhouse",
    "dremio": "dbt-dremio",
    "exasol": "dbt-exasol",
    "firebolt": "dbt-firebolt",
    "materialize": "dbt-materialize",
    "mysql": "dbt-mysql",
    "teradata": "dbt-teradata",
    "vertica": "dbt-vertica",
}


def detect_adapters(environments: List[Dict[str, Any]]) -> Set[str]:
    """
    Detect required dbt adapters from dbt Cloud environments

    Args:
        environments: List of dbt Cloud environment dictionaries

    Returns:
        Set of required dbt adapter package names
    """
    adapters = set()

    for env in environments:
        # Check connection details
        connection = env.get("connection", {})
        if connection:
            # Try to get connection type from various possible fields
            connection_type = (
                connection.get("type")
                or connection.get("connection_type")
                or connection.get("adapter_type")
            )

            if connection_type:
                # Normalize to lowercase
                connection_type = connection_type.lower()

                # Map to adapter package
                adapter = ADAPTER_MAPPING.get(connection_type)
                if adapter:
                    adapters.add(adapter)
                else:
                    # Try direct match if not in mapping
                    if connection_type.startswith("dbt-"):
                        adapters.add(connection_type)
                    else:
                        # Try common patterns
                        potential_adapter = f"dbt-{connection_type}"
                        adapters.add(potential_adapter)

        # Also check project-level adapter if available
        project = env.get("project")
        if project:
            adapter_type = project.get("adapter_type")
            if adapter_type:
                adapter_type = adapter_type.lower()
                adapter = ADAPTER_MAPPING.get(adapter_type)
                if adapter:
                    adapters.add(adapter)

    return adapters


def extract_environment_variables(
    environments: List[Dict[str, Any]], jobs: List[Dict[str, Any]]
) -> Dict[str, str]:
    """
    Extract environment variables from dbt Cloud environments and jobs

    Args:
        environments: List of dbt Cloud environment dictionaries
        jobs: List of dbt Cloud job dictionaries

    Returns:
        Dictionary of environment variable names to values (or placeholders)
    """
    env_vars = {}

    for env in environments:
        env_name = env.get("name", "").upper().replace(" ", "_").replace("-", "_")

        # Extract connection credentials (we'll use placeholders for security)
        connection = env.get("connection", {})
        if connection:
            # Extract connection details - they can be in different formats:
            # 1. Direct format: connection.type, connection.host, etc.
            # 2. Nested format: connection.connection_details.fields.{field}.value
            connection_details = connection.get("connection_details", {})
            fields = connection_details.get("fields", {}) if connection_details else {}
            
            # Helper function to get field value (handles both formats)
            def get_field_value(field_name: str, default=None):
                # Try nested format first (connection_details.fields)
                if fields:
                    field_data = fields.get(field_name, {})
                    if isinstance(field_data, dict):
                        return field_data.get("value", default)
                # Try direct format
                return connection.get(field_name, default)
            
            # Get connection type
            connection_type = (
                get_field_value("type")
                or connection.get("type")
                or connection.get("connection_type")
                or "postgres"
            )
            if connection_type:
                connection_type = connection_type.lower()
            
            # Common connection variables (extract from nested structure if available)
            account = get_field_value("account") or connection.get("account")
            database = get_field_value("database") or connection.get("database")
            schema = get_field_value("schema") or connection.get("schema")
            warehouse = get_field_value("warehouse") or connection.get("warehouse")
            user = get_field_value("user") or connection.get("user") or connection.get("username")
            host = get_field_value("host") or connection.get("host")
            port = get_field_value("port") or connection.get("port")
            project_id = get_field_value("project_id") or connection.get("project_id") or connection.get("project")
            
            # Add common variables
            if account:
                env_vars[f"DBT_{env_name}_ACCOUNT"] = account
            if database:
                env_vars[f"DBT_{env_name}_DATABASE"] = database
            if schema:
                env_vars[f"DBT_{env_name}_SCHEMA"] = schema
            if warehouse:
                env_vars[f"DBT_{env_name}_WAREHOUSE"] = warehouse
            if user:
                env_vars[f"DBT_{env_name}_USER"] = user
            if host:
                env_vars[f"DBT_{env_name}_HOST"] = host
            if port:
                env_vars[f"DBT_{env_name}_PORT"] = str(port)
            
            # Password/token should be set manually (never extract actual values)
            if get_field_value("password") or connection.get("password"):
                env_vars[f"DBT_{env_name}_PASSWORD"] = "<SET_MANUALLY>"
            if get_field_value("token") or connection.get("token"):
                env_vars[f"DBT_{env_name}_TOKEN"] = "<SET_MANUALLY>"
            if get_field_value("private_key") or connection.get("private_key"):
                env_vars[f"DBT_{env_name}_PRIVATE_KEY"] = "<SET_MANUALLY>"

            # Connection-specific variables
            if connection_type == "snowflake":
                role = get_field_value("role") or connection.get("role")
                if role:
                    env_vars[f"DBT_{env_name}_ROLE"] = role
            elif connection_type == "bigquery":
                if project_id:
                    env_vars[f"DBT_{env_name}_PROJECT"] = project_id
                # BigQuery uses service account JSON keyfile
                env_vars[f"DBT_{env_name}_KEYFILE"] = "<SET_MANUALLY>"
                location = get_field_value("location") or connection.get("location")
                if location:
                    env_vars[f"DBT_{env_name}_LOCATION"] = location
            elif connection_type == "databricks":
                http_path = get_field_value("http_path") or connection.get("http_path")
                if http_path:
                    env_vars[f"DBT_{env_name}_HTTP_PATH"] = http_path
            elif connection_type == "redshift":
                # Redshift uses same structure as postgres
                pass  # Already handled above
            elif connection_type == "spark" or connection_type == "apache_spark":
                method = get_field_value("method") or connection.get("method")
                if method:
                    env_vars[f"DBT_{env_name}_METHOD"] = method
            elif connection_type == "athena":
                s3_staging_dir = get_field_value("s3_staging_dir") or connection.get("s3_staging_dir")
                region_name = get_field_value("region_name") or connection.get("region_name")
                if s3_staging_dir:
                    env_vars[f"DBT_{env_name}_S3_STAGING_DIR"] = s3_staging_dir
                if region_name:
                    env_vars[f"DBT_{env_name}_REGION"] = region_name
            elif connection_type == "trino" or connection_type == "starburst":
                catalog = get_field_value("catalog") or connection.get("catalog")
                if catalog:
                    env_vars[f"DBT_{env_name}_CATALOG"] = catalog
            elif connection_type == "synapse" or connection_type == "azure_synapse":
                server = get_field_value("server") or connection.get("server") or host
                if server:
                    env_vars[f"DBT_{env_name}_SERVER"] = server
            elif connection_type == "fabric" or connection_type == "microsoft_fabric":
                server = get_field_value("server") or connection.get("server") or host
                if server:
                    env_vars[f"DBT_{env_name}_SERVER"] = server
            elif connection_type == "teradata":
                # Teradata uses standard host/user/database
                pass  # Already handled above
            elif connection_type == "alloydb":
                # AlloyDB uses PostgreSQL structure
                pass  # Already handled above

        # Extract custom environment variables if available
        custom_env_vars = env.get("custom_environment_variables", {})
        if custom_env_vars:
            for key, value in custom_env_vars.items():
                env_vars[key] = value

    # Extract job-level environment variables
    for job in jobs:
        job_env_vars = job.get("environment_variables", {})
        if job_env_vars:
            for key, value in job_env_vars.items():
                # Use job name as prefix if not already set
                if key not in env_vars:
                    env_vars[key] = value

    # Add common dbt variables
    # Note: DBT_PROFILES_DIR is not added - Dagster dbt component
    # automatically finds profiles.yml in ~/.dbt (default location)

    return env_vars

