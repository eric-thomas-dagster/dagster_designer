"""API endpoints for dbt Cloud integration."""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Dict, Optional, Any

from ..services.dbt_cloud.dbt_cloud_client import DbtCloudClient
from ..services.project_service import project_service
from ..models.project import ProjectCreate
from ..core.config import settings

router = APIRouter(prefix="/dbt-cloud", tags=["dbt-cloud"])


class DbtCloudConnectionRequest(BaseModel):
    """Request model for testing dbt Cloud connection."""
    api_key: str
    account_id: int
    base_url: Optional[str] = None


class DbtCloudProject(BaseModel):
    """dbt Cloud project model."""
    id: int
    name: str
    repository_url: Optional[str] = None
    state: Optional[Any] = None  # Can be int or string depending on dbt Cloud version


class DbtCloudConnectionResponse(BaseModel):
    """Response model for dbt Cloud connection test."""
    success: bool
    projects: List[DbtCloudProject]
    jobs_count: int
    environments_count: int
    message: Optional[str] = None


class DbtCloudImportRequest(BaseModel):
    """Request model for importing dbt Cloud projects."""
    api_key: str
    account_id: int
    base_url: Optional[str] = None
    project_ids: List[int]
    dagster_project_name: str


class DbtCloudImportResponse(BaseModel):
    """Response model for dbt Cloud import."""
    project_id: str
    name: str
    status: str
    message: Optional[str] = None


@router.post("/test-connection", response_model=DbtCloudConnectionResponse)
async def test_dbt_cloud_connection(request: DbtCloudConnectionRequest):
    """
    Test connection to dbt Cloud and list available projects.

    Args:
        request: Connection details (API key, account ID, optional base URL)

    Returns:
        Connection status and list of available projects
    """
    try:
        # Initialize client
        client = DbtCloudClient(
            api_key=request.api_key,
            account_id=request.account_id,
            base_url=request.base_url
        )

        # Test connection
        if not client.test_connection():
            raise HTTPException(
                status_code=401,
                detail="Authentication failed. Please check your API key and account ID."
            )

        # Fetch projects
        projects_data = client.get_projects()
        jobs_data = client.get_jobs()
        environments_data = client.get_environments()

        # Transform projects
        projects = []
        for proj in projects_data:
            # Try to get repository URL
            repo_url = None
            try:
                repo_conn = client.get_repository_connection(proj.get("id"))
                if repo_conn:
                    repo_url = repo_conn.get("url") or repo_conn.get("repository_url")
            except Exception:
                pass

            projects.append(DbtCloudProject(
                id=proj.get("id"),
                name=proj.get("name", f"Project {proj.get('id')}"),
                repository_url=repo_url,
                state=proj.get("state", "unknown")
            ))

        return DbtCloudConnectionResponse(
            success=True,
            projects=projects,
            jobs_count=len(jobs_data),
            environments_count=len(environments_data),
            message=f"Successfully connected to dbt Cloud. Found {len(projects)} project(s)."
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to connect to dbt Cloud: {str(e)}"
        )


@router.post("/import", response_model=DbtCloudImportResponse)
async def import_dbt_cloud_projects(
    request: DbtCloudImportRequest,
    background_tasks: BackgroundTasks
):
    """
    Import selected dbt Cloud projects into a new Dagster Designer project.

    Args:
        request: Import details (credentials, project IDs, Dagster project name)
        background_tasks: FastAPI background tasks

    Returns:
        Created project details
    """
    try:
        # Initialize client
        client = DbtCloudClient(
            api_key=request.api_key,
            account_id=request.account_id,
            base_url=request.base_url
        )

        # Fetch all data
        all_projects = client.get_projects()
        all_jobs = client.get_jobs()
        all_environments = client.get_environments()

        # Filter to selected projects
        selected_projects = [
            proj for proj in all_projects
            if proj.get("id") in request.project_ids
        ]

        if not selected_projects:
            raise HTTPException(
                status_code=404,
                detail="No projects found with the specified IDs"
            )

        # Get repository URLs for selected projects
        project_repos: Dict[int, str] = {}
        for proj in selected_projects:
            proj_id = proj.get("id")
            proj_name = proj.get("name", f"project_{proj_id}")
            print(f"[DEBUG] Processing project {proj_id} ({proj_name})")
            print(f"[DEBUG] Project data keys: {proj.keys()}")
            print(f"[DEBUG] Project data: {proj}")
            try:
                repo_conn = client.get_repository_connection(proj_id)
                print(f"[DEBUG] Repository connection result: {repo_conn}")
                if repo_conn:
                    # Check multiple possible field names for the repository URL
                    repo_url = (
                        repo_conn.get("url") or
                        repo_conn.get("repository_url") or
                        repo_conn.get("remote_url") or
                        repo_conn.get("web_url")
                    )
                    print(f"[DEBUG] Extracted repo URL: {repo_url}")
                    if repo_url:
                        # Convert git:// protocol to https:// for cloning
                        if repo_url.startswith("git://"):
                            repo_url = repo_url.replace("git://", "https://")
                            print(f"[DEBUG] Converted git:// to https://: {repo_url}")
                        project_repos[proj_id] = repo_url
                        print(f"[DEBUG] Added repo URL for project {proj_id}: {repo_url}")
            except Exception as e:
                print(f"[DEBUG] Exception while getting repo connection: {e}")
                import traceback
                traceback.print_exc()

        if not project_repos:
            raise HTTPException(
                status_code=400,
                detail="No git repositories found for the selected projects. Please ensure your dbt Cloud projects have git repositories configured."
            )

        # Detect dbt adapters from connection information
        detected_adapters = set()
        # Always include dbt-duckdb for local development
        detected_adapters.add("dbt-duckdb")

        for dbt_project in selected_projects:
            proj_id = dbt_project.get("id")
            # Get connection info to detect adapter
            try:
                connection_id = dbt_project.get("connection_id")
                if connection_id:
                    # We already have connection info in the project data
                    connection = dbt_project.get("connection", {})
                    adapter_version = connection.get("adapter_version", "")
                    if "bigquery" in adapter_version.lower():
                        detected_adapters.add("dbt-bigquery")
                    elif "snowflake" in adapter_version.lower():
                        detected_adapters.add("dbt-snowflake")
                    elif "redshift" in adapter_version.lower():
                        detected_adapters.add("dbt-redshift")
                    elif "postgres" in adapter_version.lower():
                        detected_adapters.add("dbt-postgres")
                    elif "databricks" in adapter_version.lower():
                        detected_adapters.add("dbt-databricks")
            except Exception as e:
                print(f"[DEBUG] Could not detect adapter for project {proj_id}: {e}")

        # Create Dagster Designer project
        # create_project automatically scaffolds when there's no git_repo
        project_create = ProjectCreate(
            name=request.dagster_project_name,
            description=f"Imported from dbt Cloud with {len(selected_projects)} project(s)"
        )
        project = project_service.create_project(project_create)
        # Project is already scaffolded and saved by create_project

        # Prepare data for background setup
        project_dir = str(settings.projects_dir / project.directory_name)

        # Prepare dbt project data for background tasks
        dbt_projects_to_setup = []
        for dbt_project in selected_projects:
            proj_id = dbt_project.get("id")
            if proj_id not in project_repos:
                continue

            proj_name = dbt_project.get("name", f"project_{proj_id}")
            repo_url = project_repos[proj_id]

            # Get environments for this project
            project_environments = [
                env for env in all_environments
                if env.get("project_id") == proj_id
            ]

            # Prepare dbt project directory
            dbt_project_dir = settings.projects_dir / project.directory_name / "dbt_projects" / proj_name
            dbt_project_dir.parent.mkdir(parents=True, exist_ok=True)

            dbt_projects_to_setup.append({
                "repo_url": repo_url,
                "target_dir": str(dbt_project_dir),
                "proj_name": proj_name,
                "environments": project_environments,
                "dbt_cloud_project": dbt_project
            })

        # Add single background task to handle all setup
        background_tasks.add_task(
            _setup_dbt_cloud_import,
            project.id,
            project_dir,
            list(detected_adapters),
            dbt_projects_to_setup
        )

        return DbtCloudImportResponse(
            project_id=project.id,
            name=project.name,
            status="created",
            message=f"Successfully created project with {len(selected_projects)} dbt project(s). Cloning repositories in background..."
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[ERROR] Failed to import dbt Cloud projects: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(
            status_code=500,
            detail=f"Failed to import dbt Cloud projects: {str(e)}"
        )


async def _setup_dbt_cloud_import(
    project_id: str,
    project_dir: str,
    detected_adapters: List[str],
    dbt_projects_to_setup: List[Dict[str, Any]]
):
    """
    Background task to setup dbt Cloud import (install dependencies and clone projects).

    Args:
        project_id: Dagster Designer project ID
        project_dir: Project directory path
        detected_adapters: List of dbt adapters to install
        dbt_projects_to_setup: List of dbt projects to clone and setup
    """
    import subprocess
    from pathlib import Path

    print(f"[INFO] Starting background setup for dbt Cloud import...")

    # Add dbt dependencies
    print(f"[INFO] Adding dbt dependencies...")

    # Add dagster-dbt
    try:
        subprocess.run(
            ["uv", "add", "dagster-dbt"],
            cwd=project_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=120
        )
        print(f"[INFO] Added dagster-dbt")
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Failed to add dagster-dbt: {e.stderr}")
    except Exception as e:
        print(f"[ERROR] Error adding dagster-dbt: {e}")

    # Add dbt adapters
    for adapter in detected_adapters:
        try:
            subprocess.run(
                ["uv", "add", adapter],
                cwd=project_dir,
                check=True,
                capture_output=True,
                text=True,
                timeout=120
            )
            print(f"[INFO] Added {adapter}")
        except subprocess.CalledProcessError as e:
            print(f"[ERROR] Failed to add {adapter}: {e.stderr}")
        except Exception as e:
            print(f"[ERROR] Error adding {adapter}: {e}")

    # Set up virtual environment
    print(f"[INFO] Setting up virtual environment...")
    try:
        subprocess.run(
            ["uv", "sync"],
            cwd=project_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=300
        )
        print(f"[INFO] Virtual environment setup complete")
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Failed to setup venv: {e.stderr}")
    except Exception as e:
        print(f"[ERROR] Error setting up venv: {e}")

    # Clone and setup each dbt project
    for dbt_project_data in dbt_projects_to_setup:
        await _clone_and_setup_dbt_project(
            dbt_project_data["repo_url"],
            dbt_project_data["target_dir"],
            project_id,
            dbt_project_data["proj_name"],
            dbt_project_data["environments"],
            dbt_project_data["dbt_cloud_project"]
        )

    print(f"[INFO] Background setup for dbt Cloud import complete!")


async def _clone_and_setup_dbt_project(
    repo_url: str,
    target_dir: str,
    project_id: str,
    dbt_project_name: str,
    environments: List[Dict[str, Any]],
    dbt_cloud_project: Dict[str, Any]
):
    """
    Background task to clone and setup a dbt project.

    Args:
        repo_url: Git repository URL
        target_dir: Target directory for cloning
        project_id: Dagster Designer project ID
        dbt_project_name: Name of the dbt project
        environments: List of dbt Cloud environments for this project
        dbt_cloud_project: The dbt Cloud project dictionary
    """
    import subprocess
    from pathlib import Path
    import yaml
    from ..services.dbt_cloud.profiles_generator import generate_profiles_yml

    target_path = Path(target_dir)

    if target_path.exists():
        print(f"[INFO] dbt project already exists at {target_dir}, skipping clone")
        return

    try:
        # Clone repository
        print(f"[INFO] Cloning {dbt_project_name} from {repo_url}...")
        subprocess.run(
            ["git", "clone", repo_url, str(target_path)],
            check=True,
            capture_output=True,
            text=True
        )
        print(f"[INFO] Successfully cloned {dbt_project_name}")

        # Generate profiles.yml
        print(f"[INFO] Generating profiles.yml for {dbt_project_name}...")

        # If no environments, create a minimal profile from project connection
        if not environments:
            print(f"[WARN] No environments found for {dbt_project_name}, creating minimal profile")
            connection = dbt_cloud_project.get("connection", {})
            # Create a synthetic environment with the connection
            environments = [{
                "name": "default",
                "connection": connection
            }]

        try:
            profiles_content = generate_profiles_yml(environments)
            profiles_path = target_path / "profiles.yml"
            with open(profiles_path, "w") as f:
                f.write(profiles_content)
            print(f"[INFO] Created profiles.yml at {profiles_path}")
        except Exception as e:
            print(f"[ERROR] Failed to generate profiles.yml: {e}")
            # Create a minimal placeholder profiles.yml
            print(f"[INFO] Creating placeholder profiles.yml")
            profiles_path = target_path / "profiles.yml"
            with open(profiles_path, "w") as f:
                yaml.dump({
                    dbt_project_name.lower().replace("-", "_").replace(" ", "_"): {
                        "outputs": {
                            "dev": {
                                "type": "bigquery",  # Default to bigquery, user can change
                                "method": "service-account",
                                "project": "{{ env_var('DBT_BIGQUERY_PROJECT') }}",
                                "dataset": "{{ env_var('DBT_BIGQUERY_DATASET', 'analytics') }}",
                                "keyfile": "{{ env_var('DBT_BIGQUERY_KEYFILE') }}"
                            }
                        },
                        "target": "dev"
                    }
                }, f)
            print(f"[INFO] Created placeholder profiles.yml at {profiles_path}")

        # Add dbt component to the project
        project = project_service.get_project(project_id)
        if project:
            # Relative path from Dagster project to dbt project
            relative_path = f"dbt_projects/{dbt_project_name}"

            # Create component
            component_id = f"dbt_{dbt_project_name.replace('-', '_').replace(' ', '_').lower()}"
            component = {
                "id": component_id,
                "component_type": f"{project.directory_name}.dagster_designer_components.DbtProjectWithTranslatorComponent",
                "label": dbt_project_name,
                "attributes": {
                    "project": relative_path
                }
            }

            # Add to project components
            if not project.components:
                project.components = []
            project.components.append(component)

            # Save project
            project_service.update_project(project_id, project)
            print(f"[INFO] Added dbt component '{component_id}' to project {project_id}")

    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Failed to clone {dbt_project_name}: {e.stderr}")
    except Exception as e:
        print(f"[ERROR] Failed to setup dbt project {dbt_project_name}: {e}")
        import traceback
        traceback.print_exc()
