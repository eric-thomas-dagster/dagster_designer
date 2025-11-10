"""API endpoints for template operations."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any, Literal

from app.services.template_service import TemplateService, PrimitiveType

router = APIRouter(prefix="/templates", tags=["templates"])
template_service = TemplateService()


class PythonAssetRequest(BaseModel):
    """Request to generate a Python asset."""

    asset_name: str
    group_name: str = ""
    description: str = ""
    compute_kind: str = "python"
    code: str = ""
    deps: list[str] = []
    owners: list[str] = []
    tags: dict[str, str] = {}


class SQLAssetRequest(BaseModel):
    """Request to generate a SQL asset."""

    asset_name: str
    query: str
    group_name: str = ""
    description: str = ""
    io_manager_key: str = "db_io_manager"
    deps: list[str] = []


class ScheduleRequest(BaseModel):
    """Request to generate a schedule."""

    schedule_name: str
    cron_expression: str
    job_name: str = ""
    asset_selection: list[str] | None = None
    description: str = ""
    timezone: str = "UTC"


class JobRequest(BaseModel):
    """Request to generate a job."""

    job_name: str
    asset_selection: list[str]
    description: str = ""
    tags: dict[str, str] = {}


class SensorRequest(BaseModel):
    """Request to generate a sensor."""

    sensor_name: str
    sensor_type: Literal["file", "run_status", "custom", "s3", "email", "filesystem", "database", "webhook"]
    job_name: str
    description: str = ""
    file_path: str = ""
    minimum_interval_seconds: int = 30
    # S3 sensor params
    bucket_name: str = ""
    prefix: str = ""
    pattern: str = ""
    aws_region: str = ""
    since_key: str = ""
    # Email sensor params
    imap_host: str = ""
    imap_port: int = 993
    email_user: str = ""
    email_password: str = ""
    mailbox: str = "INBOX"
    subject_pattern: str = ""
    from_pattern: str = ""
    mark_as_read: bool = True
    # Filesystem sensor params
    directory_path: str = ""
    file_pattern: str = "*"
    recursive: bool = False
    move_after_processing: bool = False
    archive_directory: str = ""
    # Database sensor params
    connection_string: str = ""
    table_name: str = ""
    timestamp_column: str = ""
    query_condition: str = ""
    batch_size: int = 100
    # Webhook sensor params
    webhook_path: str = ""
    auth_token: str = ""
    validate_signature: bool = False
    signature_header: str = "X-Hub-Signature-256"
    secret_key: str = ""


class AssetCheckRequest(BaseModel):
    """Request to generate an asset check."""

    check_name: str
    asset_name: str
    check_type: Literal["row_count", "freshness", "schema", "custom"]
    description: str = ""
    threshold: int | None = None
    max_age_hours: int | None = None


class IOManagerRequest(BaseModel):
    """Request to generate an IO manager."""

    io_manager_name: str
    io_manager_type: Literal[
        "filesystem", "duckdb", "duckdb_pandas", "duckdb_polars", "duckdb_pyspark",
        "snowflake", "snowflake_pandas", "snowflake_polars", "snowflake_pyspark",
        "polars", "deltalake", "deltalake_pandas", "deltalake_polars",
        "iceberg", "custom"
    ]
    description: str = ""
    base_path: str = ""
    database_path: str = ""
    account: str = ""
    user: str = ""
    password: str = ""
    database: str = ""
    schema: str = ""
    warehouse: str = ""
    table_path: str = ""
    config_params: dict[str, str] = {}


class ResourceRequest(BaseModel):
    """Request to generate a resource."""

    resource_name: str
    resource_type: Literal[
        "database", "api_client",
        "airbyte", "fivetran", "census", "hightouch",
        "databricks", "snowflake_resource",
        "aws_s3", "aws_athena", "gcp_bigquery", "gcp_gcs", "azure_blob",
        "dbt", "sling",
        "custom"
    ]
    description: str = ""
    connection_string: str = ""
    api_key: str = ""
    api_url: str = ""
    account_id: str = ""
    region: str = ""
    project_id: str = ""
    workspace_id: str = ""
    host: str = ""
    token: str = ""
    config_params: dict[str, str] = {}


class TemplatePreviewRequest(BaseModel):
    """Request to preview a template."""

    primitive_type: PrimitiveType
    params: dict[str, Any]


class SaveTemplateRequest(BaseModel):
    """Request to save a template to a project."""

    project_id: str
    primitive_type: PrimitiveType
    name: str
    code: str


@router.post("/preview")
async def preview_template(request: TemplatePreviewRequest):
    """
    Preview a template without saving it.

    Args:
        request: Template preview request

    Returns:
        Generated code
    """
    try:
        code = template_service.get_template_preview(
            request.primitive_type, request.params
        )
        return {"code": code, "primitive_type": request.primitive_type}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate template: {str(e)}"
        )


@router.post("/python-asset")
async def generate_python_asset(request: PythonAssetRequest):
    """
    Generate a Python asset template.

    Args:
        request: Python asset parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_python_asset(
            asset_name=request.asset_name,
            group_name=request.group_name,
            description=request.description,
            compute_kind=request.compute_kind,
            code=request.code,
            deps=request.deps,
            owners=request.owners,
            tags=request.tags,
        )
        return {"code": code, "asset_name": request.asset_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate Python asset: {str(e)}"
        )


@router.post("/sql-asset")
async def generate_sql_asset(request: SQLAssetRequest):
    """
    Generate a SQL asset template.

    Args:
        request: SQL asset parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_sql_asset(
            asset_name=request.asset_name,
            query=request.query,
            group_name=request.group_name,
            description=request.description,
            io_manager_key=request.io_manager_key,
            deps=request.deps,
        )
        return {"code": code, "asset_name": request.asset_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate SQL asset: {str(e)}"
        )


@router.post("/schedule")
async def generate_schedule(request: ScheduleRequest):
    """
    Generate a schedule template.

    Args:
        request: Schedule parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_schedule(
            schedule_name=request.schedule_name,
            cron_expression=request.cron_expression,
            job_name=request.job_name,
            asset_selection=request.asset_selection,
            description=request.description,
            timezone=request.timezone,
        )
        return {"code": code, "schedule_name": request.schedule_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate schedule: {str(e)}"
        )


@router.post("/job")
async def generate_job(request: JobRequest):
    """
    Generate a job template.

    Args:
        request: Job parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_job(
            job_name=request.job_name,
            asset_selection=request.asset_selection,
            description=request.description,
            tags=request.tags,
        )
        return {"code": code, "job_name": request.job_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate job: {str(e)}"
        )


@router.post("/sensor")
async def generate_sensor(request: SensorRequest):
    """
    Generate a sensor template.

    Args:
        request: Sensor parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_sensor(
            sensor_name=request.sensor_name,
            sensor_type=request.sensor_type,
            job_name=request.job_name,
            description=request.description,
            file_path=request.file_path,
            minimum_interval_seconds=request.minimum_interval_seconds,
            # S3 params
            bucket_name=request.bucket_name,
            prefix=request.prefix,
            pattern=request.pattern,
            aws_region=request.aws_region,
            since_key=request.since_key,
            # Email params
            imap_host=request.imap_host,
            imap_port=request.imap_port,
            email_user=request.email_user,
            email_password=request.email_password,
            mailbox=request.mailbox,
            subject_pattern=request.subject_pattern,
            from_pattern=request.from_pattern,
            mark_as_read=request.mark_as_read,
            # Filesystem params
            directory_path=request.directory_path,
            file_pattern=request.file_pattern,
            recursive=request.recursive,
            move_after_processing=request.move_after_processing,
            archive_directory=request.archive_directory,
            # Database params
            connection_string=request.connection_string,
            table_name=request.table_name,
            timestamp_column=request.timestamp_column,
            query_condition=request.query_condition,
            batch_size=request.batch_size,
            # Webhook params
            webhook_path=request.webhook_path,
            auth_token=request.auth_token,
            validate_signature=request.validate_signature,
            signature_header=request.signature_header,
            secret_key=request.secret_key,
        )
        return {"code": code, "sensor_name": request.sensor_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate sensor: {str(e)}"
        )


@router.post("/asset-check")
async def generate_asset_check(request: AssetCheckRequest):
    """
    Generate an asset check template.

    Args:
        request: Asset check parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_asset_check(
            check_name=request.check_name,
            asset_name=request.asset_name,
            check_type=request.check_type,
            description=request.description,
            threshold=request.threshold,
            max_age_hours=request.max_age_hours,
        )
        return {"code": code, "check_name": request.check_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate asset check: {str(e)}"
        )


@router.post("/io-manager")
async def generate_io_manager(request: IOManagerRequest):
    """
    Generate an IO manager template.

    Args:
        request: IO manager parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_io_manager(
            io_manager_name=request.io_manager_name,
            io_manager_type=request.io_manager_type,
            description=request.description,
            base_path=request.base_path,
            database_path=request.database_path,
            account=request.account,
            user=request.user,
            password=request.password,
            database=request.database,
            schema=request.schema,
            warehouse=request.warehouse,
            table_path=request.table_path,
            config_params=request.config_params,
        )
        return {"code": code, "io_manager_name": request.io_manager_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate IO manager: {str(e)}"
        )


@router.post("/resource")
async def generate_resource(request: ResourceRequest):
    """
    Generate a resource template.

    Args:
        request: Resource parameters

    Returns:
        Generated Python code
    """
    try:
        code = template_service.generate_resource(
            resource_name=request.resource_name,
            resource_type=request.resource_type,
            description=request.description,
            connection_string=request.connection_string,
            api_key=request.api_key,
            api_url=request.api_url,
            account_id=request.account_id,
            region=request.region,
            project_id=request.project_id,
            workspace_id=request.workspace_id,
            host=request.host,
            token=request.token,
            config_params=request.config_params,
        )
        return {"code": code, "resource_name": request.resource_name}
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to generate resource: {str(e)}"
        )


class CreatePythonAssetFileRequest(BaseModel):
    """Request to create a Python asset file directly."""
    project_id: str
    asset_name: str
    group_name: str = "default"
    description: str = ""
    deps: list[str] = []


@router.post("/create-python-asset")
async def create_python_asset_file(request: CreatePythonAssetFileRequest):
    """
    Create a Python asset file using dg scaffold defs command.

    Args:
        request: Python asset creation request

    Returns:
        Path to created file
    """
    import subprocess
    from pathlib import Path

    try:
        # Get project path and ensure it's absolute
        project_path = template_service._get_project_path(request.project_id).resolve()

        # Find defs directory - could be in different locations
        defs_dir = None
        is_standard_structure = False
        module_name = None

        # First, try <module>/defs at project root (imported projects)
        # This is checked first to avoid false positives from empty src/ directories
        for item in project_path.iterdir():
            if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', 'dbt_project', '.venv', '__pycache__']:
                potential_defs_dir = item / "defs"
                if potential_defs_dir.exists() and (potential_defs_dir / "__init__.py").exists():
                    # Found a valid defs directory with __init__.py
                    defs_dir = potential_defs_dir
                    module_name = item.name
                    is_standard_structure = False
                    break

        # If not found, check if this is a standard structure (src/module/defs)
        if not defs_dir:
            src_dir = project_path / "src"
            if src_dir.exists() and src_dir.is_dir():
                for item in src_dir.iterdir():
                    if item.is_dir() and not item.name.startswith('.'):
                        potential_defs_dir = item / "defs"
                        if potential_defs_dir.exists() and (potential_defs_dir / "__init__.py").exists():
                            defs_dir = potential_defs_dir
                            module_name = item.name
                            is_standard_structure = True
                            break

        if not defs_dir or not defs_dir.exists():
            raise FileNotFoundError(f"Could not find defs directory in project {project_path}")

        # Create assets directory if it doesn't exist
        assets_dir = defs_dir / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)

        # Create __init__.py if it doesn't exist
        init_file = assets_dir / "__init__.py"
        if not init_file.exists():
            init_file.write_text("")

        created_file = assets_dir / f"{request.asset_name}.py"

        # Use dg scaffold for standard structure projects, manual creation for imported projects
        if is_standard_structure:
            try:
                # Use dg scaffold defs to create the asset
                venv_dg = (project_path / ".venv" / "bin" / "dg").resolve()
                if not venv_dg.exists():
                    # Fallback to manual creation if dg not found
                    raise FileNotFoundError("dg not found in venv")

                asset_path = f"assets/{request.asset_name}.py"
                cmd = [str(venv_dg), "scaffold", "defs", "dagster.asset", asset_path]

                result = subprocess.run(
                    cmd,
                    cwd=str(project_path),
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

                if result.returncode != 0:
                    raise Exception(f"dg scaffold failed: {result.stderr}")

            except Exception as e:
                # Fallback to manual creation if dg scaffold fails
                print(f"dg scaffold failed, creating file manually: {e}")
                asset_template = f'''from dagster import asset


@asset
def {request.asset_name}():
    """A new asset.

    Add your asset logic here.
    """
    # TODO: Implement asset logic
    return None
'''
                created_file.write_text(asset_template)
        else:
            # For imported projects, create the file manually
            asset_template = f'''from dagster import asset


@asset
def {request.asset_name}():
    """A new asset.

    Add your asset logic here.
    """
    # TODO: Implement asset logic
    return None
'''
            created_file.write_text(asset_template)

        if not created_file.exists():
            raise Exception(f"Asset file was not created: {created_file}")

        # Get relative path from project root
        projects_dir_abs = template_service.projects_dir.resolve()
        relative_path = created_file.relative_to(projects_dir_abs)

        return {
            "message": "Python asset created successfully",
            "file_path": str(relative_path),
            "asset_name": request.asset_name,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="dg scaffold command timed out")
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to create Python asset: {str(e)}"
        )


@router.post("/save")
async def save_template(request: SaveTemplateRequest):
    """
    Save a generated template to a project.

    Args:
        request: Save template request

    Returns:
        Path to saved file
    """
    try:
        file_path = template_service.save_template_to_project(
            project_id=request.project_id,
            primitive_type=request.primitive_type,
            name=request.name,
            code=request.code,
        )
        return {
            "message": "Template saved successfully",
            "file_path": str(file_path.relative_to(template_service.projects_dir)),
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to save template: {str(e)}"
        )


@router.get("/examples/{primitive_type}")
async def get_template_examples(primitive_type: PrimitiveType):
    """
    Get example templates for a primitive type.

    Args:
        primitive_type: Type of primitive

    Returns:
        Example templates
    """
    examples = {
        "python_asset": [
            {
                "name": "Simple Asset",
                "params": {
                    "asset_name": "my_asset",
                    "description": "A simple Python asset",
                    "group_name": "default",
                },
            },
            {
                "name": "Asset with Dependencies",
                "params": {
                    "asset_name": "downstream_asset",
                    "description": "Asset that depends on upstream data",
                    "group_name": "analytics",
                    "deps": ["upstream_asset"],
                },
            },
        ],
        "sql_asset": [
            {
                "name": "Simple SQL Asset",
                "params": {
                    "asset_name": "customers_summary",
                    "query": "SELECT customer_id, COUNT(*) as order_count\nFROM orders\nGROUP BY customer_id",
                    "description": "Customer order summary",
                },
            }
        ],
        "schedule": [
            {
                "name": "Daily Schedule",
                "params": {
                    "schedule_name": "daily_refresh",
                    "cron_expression": "0 0 * * *",
                    "job_name": "refresh_assets",
                    "description": "Run daily at midnight",
                },
            },
            {
                "name": "Hourly Schedule",
                "params": {
                    "schedule_name": "hourly_sync",
                    "cron_expression": "0 * * * *",
                    "job_name": "sync_data",
                    "description": "Run every hour",
                },
            },
        ],
        "job": [
            {
                "name": "Analytics Job",
                "params": {
                    "job_name": "analytics_pipeline",
                    "asset_selection": ["raw_data", "transformed_data", "final_report"],
                    "description": "Complete analytics pipeline",
                },
            }
        ],
        "sensor": [
            {
                "name": "File Sensor",
                "params": {
                    "sensor_name": "watch_data_file",
                    "sensor_type": "file",
                    "job_name": "process_file",
                    "file_path": "/data/new_data.csv",
                },
            }
        ],
        "asset_check": [
            {
                "name": "Row Count Check",
                "params": {
                    "check_name": "check_row_count",
                    "asset_name": "customers",
                    "check_type": "row_count",
                    "threshold": 100,
                },
            },
            {
                "name": "Freshness Check",
                "params": {
                    "check_name": "check_freshness",
                    "asset_name": "daily_sales",
                    "check_type": "freshness",
                    "max_age_hours": 24,
                },
            },
        ],
        "io_manager": [
            {
                "name": "Filesystem IO Manager",
                "params": {
                    "io_manager_name": "fs_io_manager",
                    "io_manager_type": "filesystem",
                    "description": "Store assets as pickle files on disk",
                    "base_path": "data/storage",
                },
            },
            {
                "name": "DuckDB IO Manager",
                "params": {
                    "io_manager_name": "duckdb_io_manager",
                    "io_manager_type": "duckdb",
                    "description": "Store assets in DuckDB database",
                    "database_path": "data/dagster.duckdb",
                },
            },
        ],
        "resource": [
            {
                "name": "Database Resource",
                "params": {
                    "resource_name": "db_resource",
                    "resource_type": "database",
                    "description": "Database connection resource",
                    "connection_string": "data/analytics.duckdb",
                },
            },
            {
                "name": "API Client Resource",
                "params": {
                    "resource_name": "api_client",
                    "resource_type": "api_client",
                    "description": "External API client",
                    "api_url": "https://api.example.com",
                    "api_key": "",
                },
            },
        ],
    }

    return {"examples": examples.get(primitive_type, [])}
