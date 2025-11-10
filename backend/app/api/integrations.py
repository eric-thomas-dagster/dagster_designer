"""API endpoints for Dagster integration management."""

import subprocess
from pathlib import Path
from typing import Dict, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.project_service import project_service

router = APIRouter(prefix="/integrations", tags=["integrations"])


class InstallIntegrationRequest(BaseModel):
    """Request to install a Dagster integration."""
    package: str


class InstallIntegrationResponse(BaseModel):
    """Response from installing an integration."""
    success: bool
    message: str
    stdout: str
    stderr: str


class IntegrationStatusResponse(BaseModel):
    """Response with integration installation status."""
    package: str
    installed: bool
    version: str | None = None


def check_integration_installed(project_dir: Path, package: str) -> tuple[bool, str | None]:
    """Check if a Dagster integration is installed in the project's venv.

    Args:
        project_dir: Path to the project directory
        package: The package name (e.g., 'dagster-dbt', 'dagster-snowflake')

    Returns:
        Tuple of (is_installed, version)
    """
    venv_dir = project_dir / ".venv"
    if not venv_dir.exists():
        return False, None

    try:
        import os
        env = os.environ.copy()
        env["UV_PROJECT_ENVIRONMENT"] = str(venv_dir.absolute())

        result = subprocess.run(
            ["uv", "pip", "show", package],
            cwd=str(project_dir.absolute()),
            capture_output=True,
            text=True,
            timeout=10,
            env=env
        )

        if result.returncode == 0:
            # Parse version from output
            for line in result.stdout.split('\n'):
                if line.startswith('Version:'):
                    version = line.split(':', 1)[1].strip()
                    return True, version
            return True, None

        return False, None
    except Exception as e:
        print(f"Error checking integration installation: {e}")
        return False, None


@router.get("/{project_id}/status/{package}", response_model=IntegrationStatusResponse)
async def get_integration_status(project_id: str, package: str):
    """Get the installation status of a specific integration for a project."""
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project_service._get_project_dir(project)
    is_installed, version = check_integration_installed(project_dir, package)

    return IntegrationStatusResponse(
        package=package,
        installed=is_installed,
        version=version
    )


@router.post("/{project_id}/install", response_model=InstallIntegrationResponse)
async def install_integration(project_id: str, request: InstallIntegrationRequest):
    """Install a Dagster integration in the project's virtual environment.

    This runs uv pip install {package} in the project's venv.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project_service._get_project_dir(project)
    venv_dir = project_dir / ".venv"

    if not venv_dir.exists():
        raise HTTPException(
            status_code=500,
            detail="Project virtual environment not found. Please ensure the project was created successfully."
        )

    package_name = request.package

    try:
        print(f"[install_integration] Installing {package_name} in project {project_id}")

        # Run uv pip install
        import os
        env = os.environ.copy()
        env["UV_PROJECT_ENVIRONMENT"] = str(venv_dir.absolute())

        result = subprocess.run(
            ["uv", "pip", "install", package_name],
            cwd=str(project_dir.absolute()),
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
            env=env
        )

        success = result.returncode == 0
        message = f"Successfully installed {package_name}" if success else f"Failed to install {package_name}"

        print(f"[install_integration] {message}")
        print(f"[install_integration] stdout: {result.stdout[:500]}")
        print(f"[install_integration] stderr: {result.stderr[:500]}")

        return InstallIntegrationResponse(
            success=success,
            message=message,
            stdout=result.stdout,
            stderr=result.stderr
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=408,
            detail=f"Installation of {package_name} timed out after 5 minutes"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to install {package_name}: {str(e)}"
        )
