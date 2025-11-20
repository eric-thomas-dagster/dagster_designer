"""API endpoints for dbt Cloud integration."""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import List, Dict, Optional, Any

from ..services.dbt_cloud.dbt_cloud_client import DbtCloudClient
from ..services.project_service import project_service
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
    state: Optional[str] = None


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
            try:
                repo_conn = client.get_repository_connection(proj_id)
                if repo_conn:
                    repo_url = repo_conn.get("url") or repo_conn.get("repository_url")
                    if repo_url:
                        project_repos[proj_id] = repo_url
            except Exception:
                pass

        if not project_repos:
            raise HTTPException(
                status_code=400,
                detail="No git repositories found for the selected projects. Please ensure your dbt Cloud projects have git repositories configured."
            )

        # Create Dagster Designer project
        # We'll use the existing project creation flow
        project = project_service.create_project(
            name=request.dagster_project_name,
            template="blank"  # Start with blank, we'll add dbt components
        )

        # Add dbt components for each selected project
        for dbt_project in selected_projects:
            proj_id = dbt_project.get("id")
            if proj_id not in project_repos:
                continue

            proj_name = dbt_project.get("name", f"project_{proj_id}")
            repo_url = project_repos[proj_id]

            # Clone the dbt project repository
            dbt_project_dir = settings.projects_dir / project.directory_name / "dbt_projects" / proj_name
            dbt_project_dir.parent.mkdir(parents=True, exist_ok=True)

            # Add as background task to avoid blocking
            background_tasks.add_task(
                _clone_and_setup_dbt_project,
                repo_url,
                str(dbt_project_dir),
                project.id,
                proj_name
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


async def _clone_and_setup_dbt_project(
    repo_url: str,
    target_dir: str,
    project_id: str,
    dbt_project_name: str
):
    """
    Background task to clone and setup a dbt project.

    Args:
        repo_url: Git repository URL
        target_dir: Target directory for cloning
        project_id: Dagster Designer project ID
        dbt_project_name: Name of the dbt project
    """
    import subprocess
    from pathlib import Path

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
