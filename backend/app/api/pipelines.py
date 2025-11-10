"""API endpoints for managing Dagster pipelines (Jobs + Schedules/Sensors)."""

import json
from pathlib import Path
from typing import List, Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.config import settings

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


class PipelineCreateRequest(BaseModel):
    """Request model for creating a pipeline."""
    name: str
    description: str
    asset_selection: List[str]
    trigger_type: Literal["manual", "schedule", "sensor"]
    cron_schedule: str | None = None
    sensor_config: dict | None = None


class PipelineResponse(BaseModel):
    """Response model for pipeline operations."""
    id: str
    name: str
    description: str
    asset_selection: List[str]
    trigger_type: str
    cron_schedule: str | None = None
    files_created: List[str]


def generate_defs_yaml(
    pipeline_name: str,
    description: str,
    asset_selection: List[str],
    project_module: str,
    trigger_type: str,
    cron_schedule: str | None = None,
    sensor_config: dict | None = None
) -> str:
    """Generate defs.yaml with job component and optional schedule/sensor."""
    components = []

    # Add job component
    asset_list_lines = "\n".join([f"    - {asset}" for asset in asset_selection])
    job_component = f"""type: {project_module}.dagster_designer_components.JobComponent
attributes:
  job_name: {pipeline_name}
  description: "{description}"
  asset_selection:
{asset_list_lines}
"""
    components.append(job_component)

    # Add schedule component if schedule trigger
    if trigger_type == "schedule" and cron_schedule:
        schedule_component = f"""type: {project_module}.dagster_designer_components.ScheduleComponent
attributes:
  schedule_name: {pipeline_name}_schedule
  cron_expression: "{cron_schedule}"
  job_name: {pipeline_name}
  description: "Schedule for {description}"
  default_status: RUNNING
"""
        components.append(schedule_component)

    # Add sensor component if sensor trigger
    elif trigger_type == "sensor" and sensor_config:
        sensor_type = sensor_config.get("sensor_type", "custom")
        is_primitive = sensor_config.get("component_type", "primitive") == "primitive"

        if is_primitive:
            # Use primitive SensorComponent
            sensor_attrs = [
                f"  sensor_name: {pipeline_name}_sensor",
                f"  sensor_type: {sensor_type}",
                f"  job_name: {pipeline_name}",
                f"  description: \"Sensor for {description}\"",
                f"  minimum_interval_seconds: 30",
                f"  default_status: RUNNING"
            ]

            # Add type-specific attributes
            if sensor_type == "file" and "file_path" in sensor_config:
                sensor_attrs.append(f"  file_path: \"{sensor_config['file_path']}\"")
            elif sensor_type == "run_status":
                if "monitored_job_name" in sensor_config:
                    sensor_attrs.append(f"  monitored_job_name: {sensor_config['monitored_job_name']}")
                if "run_status" in sensor_config:
                    sensor_attrs.append(f"  run_status: {sensor_config['run_status']}")
            elif sensor_type == "s3":
                if "bucket_name" in sensor_config:
                    sensor_attrs.append(f"  bucket_name: \"{sensor_config['bucket_name']}\"")
                if "prefix" in sensor_config and sensor_config["prefix"]:
                    sensor_attrs.append(f"  prefix: \"{sensor_config['prefix']}\"")
                if "pattern" in sensor_config and sensor_config["pattern"]:
                    sensor_attrs.append(f"  pattern: \"{sensor_config['pattern']}\"")
                if "aws_region" in sensor_config and sensor_config["aws_region"]:
                    sensor_attrs.append(f"  aws_region: \"{sensor_config['aws_region']}\"")
            elif sensor_type == "email":
                for key in ["imap_host", "email_user", "email_password"]:
                    if key in sensor_config:
                        sensor_attrs.append(f"  {key}: \"{sensor_config[key]}\"")
                if "imap_port" in sensor_config and sensor_config["imap_port"]:
                    sensor_attrs.append(f"  imap_port: {sensor_config['imap_port']}")
                if "subject_pattern" in sensor_config and sensor_config["subject_pattern"]:
                    sensor_attrs.append(f"  subject_pattern: \"{sensor_config['subject_pattern']}\"")
            elif sensor_type == "filesystem":
                if "directory_path" in sensor_config:
                    sensor_attrs.append(f"  directory_path: \"{sensor_config['directory_path']}\"")
                if "file_pattern" in sensor_config and sensor_config["file_pattern"]:
                    sensor_attrs.append(f"  file_pattern: \"{sensor_config['file_pattern']}\"")
                if "recursive" in sensor_config and sensor_config["recursive"]:
                    sensor_attrs.append(f"  recursive: {sensor_config['recursive']}")
            elif sensor_type == "database":
                for key in ["connection_string", "table_name", "timestamp_column"]:
                    if key in sensor_config:
                        sensor_attrs.append(f"  {key}: \"{sensor_config[key]}\"")
                if "query_condition" in sensor_config and sensor_config["query_condition"]:
                    sensor_attrs.append(f"  query_condition: \"{sensor_config['query_condition']}\"")
            elif sensor_type == "webhook":
                if "webhook_path" in sensor_config:
                    sensor_attrs.append(f"  webhook_path: \"{sensor_config['webhook_path']}\"")
                if "auth_token" in sensor_config and sensor_config["auth_token"]:
                    sensor_attrs.append(f"  auth_token: \"{sensor_config['auth_token']}\"")

            sensor_component = f"type: {project_module}.dagster_designer_components.SensorComponent\nattributes:\n" + "\n".join(sensor_attrs)
            components.append(sensor_component)

        else:
            # Use installed sensor component
            component_type_full = sensor_config.get("component_type_full", "")

            # Build attributes from sensor_config, excluding internal fields
            sensor_attrs = [
                f"  sensor_name: {pipeline_name}_sensor",
                f"  job_name: {pipeline_name}",
                f"  description: \"Sensor for {description}\"",
            ]

            # Add all other config attributes
            for key, value in sensor_config.items():
                if key not in ["sensor_type", "component_type", "component_id", "component_type_full"]:
                    if isinstance(value, str):
                        sensor_attrs.append(f"  {key}: \"{value}\"")
                    elif isinstance(value, bool):
                        sensor_attrs.append(f"  {key}: {str(value).lower()}")
                    elif isinstance(value, (int, float)):
                        sensor_attrs.append(f"  {key}: {value}")
                    else:
                        sensor_attrs.append(f"  {key}: \"{value}\"")

            sensor_component = f"type: {component_type_full}\nattributes:\n" + "\n".join(sensor_attrs)
            components.append(sensor_component)

    # Join with --- separator
    return "---\n".join(components)


def generate_job_code(
    job_name: str,
    description: str,
    asset_selection: List[str]
) -> str:
    """Generate Dagster Job code."""
    # Create asset key strings
    asset_keys = ", ".join([f'"{asset}"' for asset in asset_selection])

    code = f'''"""
{description}
"""
from dagster import define_asset_job, AssetSelection

# Job definition for {job_name}
{job_name} = define_asset_job(
    name="{job_name}",
    description="""{description}""",
    selection=AssetSelection.keys({asset_keys}),
)
'''
    return code


def generate_schedule_code(
    schedule_name: str,
    job_name: str,
    cron_schedule: str,
    description: str
) -> str:
    """Generate Dagster Schedule code."""
    code = f'''"""
Schedule for {job_name}
"""
from dagster import ScheduleDefinition
from .job import {job_name}

# Schedule definition for {schedule_name}
{schedule_name} = ScheduleDefinition(
    name="{schedule_name}",
    job={job_name},
    cron_schedule="{cron_schedule}",
    description="""{description}""",
)
'''
    return code


@router.post("/create/{project_id}")
async def create_pipeline(
    project_id: str,
    pipeline: PipelineCreateRequest
) -> PipelineResponse:
    """
    Create a new pipeline (Job + optional Schedule/Sensor).

    Args:
        project_id: Project ID
        pipeline: Pipeline configuration

    Returns:
        Pipeline details with generated files
    """
    try:
        # Get project path
        project_file = (settings.projects_dir / f"{project_id}.json").resolve()
        if not project_file.exists():
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

        # Read project metadata
        with open(project_file, 'r') as f:
            project_data = json.load(f)

        directory_name = project_data.get("directory_name", project_id)
        project_path = (settings.projects_dir / directory_name).resolve()

        if not project_path.exists():
            raise HTTPException(status_code=404, detail="Project directory not found")

        # Detect project structure and find defs directory
        # Check for src layout first
        src_module_dir = project_path / "src" / directory_name
        if src_module_dir.exists():
            # Src layout
            defs_dir = src_module_dir / "defs"
            project_module = directory_name
        else:
            # Non-src layout - module is directly in project
            module_dir = project_path / directory_name
            if module_dir.exists():
                defs_dir = module_dir / "defs"
                project_module = directory_name
            else:
                # Fallback to flat layout
                defs_dir = project_path / "defs"
                project_module = directory_name

        if not defs_dir.exists():
            raise HTTPException(
                status_code=500,
                detail=f"Could not find defs directory. Checked: {defs_dir}"
            )

        # Create pipelines component directory
        pipeline_dir = defs_dir / "pipelines" / pipeline.name
        pipeline_dir.mkdir(parents=True, exist_ok=True)

        files_created = []

        # Generate defs.yaml with asset references, job, and optional schedule/sensor
        defs_yaml_content = generate_defs_yaml(
            pipeline_name=pipeline.name,
            description=pipeline.description,
            asset_selection=pipeline.asset_selection,
            project_module=project_module,
            trigger_type=pipeline.trigger_type,
            cron_schedule=pipeline.cron_schedule,
            sensor_config=pipeline.sensor_config
        )

        defs_yaml_file = pipeline_dir / "defs.yaml"
        defs_yaml_file.write_text(defs_yaml_content)
        files_created.append(str(defs_yaml_file.relative_to(project_path)))

        return PipelineResponse(
            id=f"pipeline_{pipeline.name}",
            name=pipeline.name,
            description=pipeline.description,
            asset_selection=pipeline.asset_selection,
            trigger_type=pipeline.trigger_type,
            cron_schedule=pipeline.cron_schedule,
            files_created=files_created
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to create pipeline: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create pipeline: {str(e)}"
        )


@router.get("/details/{project_id}/{pipeline_name}")
async def get_pipeline_details(project_id: str, pipeline_name: str):
    """
    Get detailed information about a specific pipeline.

    Args:
        project_id: Project ID
        pipeline_name: Pipeline name

    Returns:
        Pipeline details including asset selection and triggers
    """
    try:
        # Get project path
        project_file = (settings.projects_dir / f"{project_id}.json").resolve()
        if not project_file.exists():
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

        # Read project metadata
        with open(project_file, 'r') as f:
            project_data = json.load(f)

        directory_name = project_data.get("directory_name", project_id)
        project_path = (settings.projects_dir / directory_name).resolve()

        if not project_path.exists():
            raise HTTPException(status_code=404, detail="Project directory not found")

        # Detect project structure and find defs directory
        src_module_dir = project_path / "src" / directory_name
        if src_module_dir.exists():
            defs_dir = src_module_dir / "defs"
        else:
            module_dir = project_path / directory_name
            if module_dir.exists():
                defs_dir = module_dir / "defs"
            else:
                defs_dir = project_path / "defs"

        # Find the pipeline folder
        pipeline_dir = defs_dir / "pipelines" / pipeline_name
        if not pipeline_dir.exists():
            raise HTTPException(status_code=404, detail=f"Pipeline {pipeline_name} not found")

        defs_yaml_file = pipeline_dir / "defs.yaml"
        if not defs_yaml_file.exists():
            raise HTTPException(status_code=404, detail=f"Pipeline defs.yaml not found")

        # Parse the defs.yaml to extract asset_selection and trigger info
        import yaml
        content = defs_yaml_file.read_text()

        # Split by --- to get individual components
        yaml_docs = content.split('---\n')

        asset_selection = []
        trigger_type = "manual"
        cron_schedule = None
        description = ""

        for doc in yaml_docs:
            if not doc.strip():
                continue

            try:
                component = yaml.safe_load(doc)
                if not component:
                    continue

                # Check if this is a JobComponent
                if 'JobComponent' in component.get('type', ''):
                    attrs = component.get('attributes', {})
                    asset_selection = attrs.get('asset_selection', [])
                    description = attrs.get('description', '')

                # Check if this is a ScheduleComponent
                elif 'ScheduleComponent' in component.get('type', ''):
                    trigger_type = "schedule"
                    attrs = component.get('attributes', {})
                    cron_schedule = attrs.get('cron_expression', '')

                # Check if this is a SensorComponent
                elif 'SensorComponent' in component.get('type', ''):
                    trigger_type = "sensor"
            except Exception as e:
                print(f"Error parsing YAML doc: {e}")
                continue

        return {
            "project_id": project_id,
            "name": pipeline_name,
            "description": description,
            "asset_selection": asset_selection,
            "trigger_type": trigger_type,
            "cron_schedule": cron_schedule,
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to get pipeline details: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(
            status_code=500,
            detail=f"Failed to get pipeline details: {str(e)}"
        )


@router.get("/sensor-types/{project_id}")
async def list_sensor_types(project_id: str):
    """
    List all available sensor component types.

    Returns primitive sensor types plus any installed sensor components in the project.
    """
    # Start with primitive sensor types (always available)
    sensor_types = [
        {
            "id": "primitive_file",
            "name": "File Monitor (Primitive)",
            "description": "Monitor file paths and trigger when files exist/change",
            "type": "primitive",
            "sensor_type": "file",
            "config_schema": {
                "file_path": {"type": "string", "required": True, "description": "File path to monitor"}
            }
        },
        {
            "id": "primitive_run_status",
            "name": "Run Status Monitor (Primitive)",
            "description": "Monitor another job and trigger when it completes with a specific status",
            "type": "primitive",
            "sensor_type": "run_status",
            "config_schema": {
                "monitored_job_name": {"type": "string", "required": True, "description": "Job name to monitor"},
                "run_status": {"type": "select", "required": True, "options": ["SUCCESS", "FAILURE", "CANCELED"], "description": "Status to trigger on"}
            }
        },
        {
            "id": "primitive_custom",
            "name": "Custom Sensor (Primitive)",
            "description": "Custom sensor logic - customize code after creation",
            "type": "primitive",
            "sensor_type": "custom",
            "config_schema": {}
        },
        {
            "id": "s3",
            "name": "S3 Bucket Monitor",
            "description": "Monitor S3 buckets for new files and trigger jobs",
            "type": "primitive",
            "sensor_type": "s3",
            "config_schema": {
                "bucket_name": {"type": "string", "required": True, "description": "S3 bucket name"},
                "prefix": {"type": "string", "required": False, "description": "Key prefix to filter (optional)"},
                "pattern": {"type": "string", "required": False, "description": "Regex pattern to match keys (optional)"},
                "aws_region": {"type": "string", "required": False, "description": "AWS region (optional)"}
            }
        },
        {
            "id": "email",
            "name": "Email Monitor",
            "description": "Monitor email inbox and trigger jobs based on incoming emails",
            "type": "primitive",
            "sensor_type": "email",
            "config_schema": {
                "imap_host": {"type": "string", "required": True, "description": "IMAP server host"},
                "imap_port": {"type": "string", "required": False, "description": "IMAP port (default: 993)"},
                "email_user": {"type": "string", "required": True, "description": "Email username"},
                "email_password": {"type": "string", "required": True, "description": "Email password"},
                "subject_pattern": {"type": "string", "required": False, "description": "Subject regex pattern (optional)"}
            }
        },
        {
            "id": "filesystem",
            "name": "Filesystem Monitor",
            "description": "Monitor directories for new files with advanced options",
            "type": "primitive",
            "sensor_type": "filesystem",
            "config_schema": {
                "directory_path": {"type": "string", "required": True, "description": "Directory path to monitor"},
                "file_pattern": {"type": "string", "required": False, "description": "Regex pattern to match files (optional)"},
                "recursive": {"type": "select", "required": False, "options": ["true", "false"], "description": "Monitor subdirectories (optional)"}
            }
        },
        {
            "id": "database",
            "name": "Database Monitor",
            "description": "Monitor database tables for new rows and trigger jobs",
            "type": "primitive",
            "sensor_type": "database",
            "config_schema": {
                "connection_string": {"type": "string", "required": True, "description": "Database connection string"},
                "table_name": {"type": "string", "required": True, "description": "Table name to monitor"},
                "timestamp_column": {"type": "string", "required": True, "description": "Timestamp column for tracking"},
                "query_condition": {"type": "string", "required": False, "description": "WHERE clause condition (optional)"}
            }
        },
        {
            "id": "webhook",
            "name": "Webhook Sensor",
            "description": "Trigger jobs via HTTP webhooks with authentication",
            "type": "primitive",
            "sensor_type": "webhook",
            "config_schema": {
                "webhook_path": {"type": "string", "required": True, "description": "Webhook URL path (e.g., /webhooks/my-sensor)"},
                "auth_token": {"type": "string", "required": False, "description": "Authentication token (optional)"}
            }
        }
    ]

    # Add installed sensor components from the project
    try:
        from pathlib import Path
        import yaml
        from app.services.project_service import project_service

        project = project_service.get_project(project_id)
        if project:
            project_dir = project_service._get_project_dir(project)
            project_name_sanitized = project.name.replace(" ", "_").replace("-", "_")

            # Check for components directory (both flat and src layouts)
            flat_components_dir = project_dir / project_name_sanitized / "components"
            src_components_dir = project_dir / "src" / project_name_sanitized / "components"

            components_dir = None
            if flat_components_dir.exists():
                components_dir = flat_components_dir
            elif src_components_dir.exists():
                components_dir = src_components_dir

            if components_dir and components_dir.exists():
                # Scan for installed sensor components
                for item in components_dir.iterdir():
                    if item.is_dir() and not item.name.startswith('_') and not item.name.startswith('.'):
                        manifest_file = item / "manifest.yaml"
                        if manifest_file.exists():
                            try:
                                with open(manifest_file, 'r') as f:
                                    manifest_data = yaml.safe_load(f)

                                # Check if this is a sensor component
                                category = manifest_data.get('category', '')
                                component_type = manifest_data.get('component_type', '')

                                if category == 'sensors' or 'sensor' in component_type.lower():
                                    # Load schema if available
                                    schema_file = item / "schema.json"
                                    config_schema = {}
                                    if schema_file.exists():
                                        import json
                                        with open(schema_file, 'r') as f:
                                            schema_data = json.load(f)
                                            # Convert JSON schema to our config_schema format
                                            properties = schema_data.get('properties', {})
                                            for prop_name, prop_def in properties.items():
                                                config_schema[prop_name] = {
                                                    "type": prop_def.get("type", "string"),
                                                    "required": prop_name in schema_data.get('required', []),
                                                    "description": prop_def.get("description", "")
                                                }

                                    sensor_types.append({
                                        "id": item.name,
                                        "name": manifest_data.get('name', item.name.replace('_', ' ').title()),
                                        "description": manifest_data.get('description', ''),
                                        "type": "component",
                                        "sensor_type": item.name,
                                        "component_type": component_type,
                                        "config_schema": config_schema
                                    })
                            except Exception as e:
                                print(f"Warning: Could not read sensor manifest for {item.name}: {e}")
    except Exception as e:
        print(f"Error loading installed sensor components: {e}")

    return {
        "sensor_types": sensor_types
    }


@router.get("/list/{project_id}")
async def list_pipelines(project_id: str):
    """
    List all pipelines in a project.

    This returns jobs that were created through the pipeline builder.

    Args:
        project_id: Project ID

    Returns:
        List of pipelines
    """
    try:
        # Get project path
        project_file = (settings.projects_dir / f"{project_id}.json").resolve()
        if not project_file.exists():
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

        # Read project metadata
        with open(project_file, 'r') as f:
            project_data = json.load(f)

        directory_name = project_data.get("directory_name", project_id)
        project_path = (settings.projects_dir / directory_name).resolve()

        if not project_path.exists():
            raise HTTPException(status_code=404, detail="Project directory not found")

        # Detect project structure and find defs directory
        src_module_dir = project_path / "src" / directory_name
        if src_module_dir.exists():
            defs_dir = src_module_dir / "defs"
        else:
            module_dir = project_path / directory_name
            if module_dir.exists():
                defs_dir = module_dir / "defs"
            else:
                defs_dir = project_path / "defs"

        pipelines = []

        # Check new component-based pipelines directory
        pipelines_dir = defs_dir / "pipelines"
        if pipelines_dir.exists():
            for pipeline_folder in pipelines_dir.iterdir():
                if not pipeline_folder.is_dir():
                    continue

                # Look for defs.yaml in the pipeline folder
                defs_yaml_file = pipeline_folder / "defs.yaml"
                if defs_yaml_file.exists():
                    content = defs_yaml_file.read_text()
                    job_name = pipeline_folder.name

                    # Extract description from JobComponent in YAML
                    description = ""
                    if 'description:' in content:
                        # Simple extraction - look for description after JobComponent
                        lines = content.split('\n')
                        for i, line in enumerate(lines):
                            if 'description:' in line and 'JobComponent' in content:
                                # Extract the description value
                                desc_line = line.split('description:', 1)[1].strip()
                                description = desc_line.strip('"').strip("'")
                                break

                    pipelines.append({
                        "id": f"pipeline_{job_name}",
                        "name": job_name,
                        "description": description,
                        "folder": str(pipeline_folder.relative_to(project_path))
                    })

        # Also check legacy jobs directory for backwards compatibility
        jobs_dir = defs_dir / "jobs"
        if jobs_dir.exists():
            for job_file in jobs_dir.glob("*.py"):
                if job_file.name == "__init__.py":
                    continue

                content = job_file.read_text()
                job_name = job_file.stem

                # Extract description (simple parsing)
                description = ""
                if 'description="""' in content:
                    start = content.index('description="""') + len('description="""')
                    end = content.index('"""', start)
                    description = content[start:end].strip()

                pipelines.append({
                    "id": f"pipeline_{job_name}",
                    "name": job_name,
                    "description": description,
                    "file": str(job_file.relative_to(project_path))
                })

        return {
            "project_id": project_id,
            "pipelines": pipelines,
            "total": len(pipelines)
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list pipelines: {str(e)}"
        )
