"""API endpoints for DBT adapter management."""

import subprocess
from pathlib import Path
from typing import Dict, Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.project_service import project_service

router = APIRouter(prefix="/dbt-adapters", tags=["dbt-adapters"])


class AdapterInfo(BaseModel):
    """Information about a DBT adapter."""
    adapter_type: str
    required: bool
    installed: bool
    package_name: str
    version: str | None = None


class AdapterStatusResponse(BaseModel):
    """Response with adapter status for a project."""
    project_id: str
    adapters: list[AdapterInfo]
    dbt_project_path: str | None = None


class InstallAdapterRequest(BaseModel):
    """Request to install a DBT adapter."""
    adapter_type: str


class InstallAdapterResponse(BaseModel):
    """Response from installing an adapter."""
    success: bool
    message: str
    stdout: str
    stderr: str


def detect_required_adapter(dbt_project_path: Path) -> str | None:
    """Detect which DBT adapter is required by reading profiles.yml.

    Args:
        dbt_project_path: Path to the dbt project directory

    Returns:
        The adapter type (e.g., 'duckdb', 'snowflake', 'postgres') or None
    """
    # First try profiles.yml in the dbt project
    profiles_path = dbt_project_path / "profiles.yml"

    if profiles_path.exists():
        try:
            import yaml
            with open(profiles_path) as f:
                profiles = yaml.safe_load(f)

            # profiles.yml structure:
            # profile_name:
            #   target: dev
            #   outputs:
            #     dev:
            #       type: duckdb  <- this is what we need

            if profiles and isinstance(profiles, dict):
                for profile_name, profile_config in profiles.items():
                    if isinstance(profile_config, dict) and 'outputs' in profile_config:
                        outputs = profile_config['outputs']
                        if isinstance(outputs, dict):
                            for output_name, output_config in outputs.items():
                                if isinstance(output_config, dict) and 'type' in output_config:
                                    return output_config['type']
        except Exception as e:
            print(f"Error reading profiles.yml: {e}")

    # Try ~/.dbt/profiles.yml as fallback
    home_profiles = Path.home() / ".dbt" / "profiles.yml"
    if home_profiles.exists():
        try:
            import yaml
            with open(home_profiles) as f:
                profiles = yaml.safe_load(f)

            # Get profile name from dbt_project.yml
            dbt_project_yml = dbt_project_path / "dbt_project.yml"
            if dbt_project_yml.exists():
                with open(dbt_project_yml) as f:
                    dbt_config = yaml.safe_load(f)
                    profile_name = dbt_config.get('profile')

                    if profile_name and profile_name in profiles:
                        profile_config = profiles[profile_name]
                        if isinstance(profile_config, dict) and 'outputs' in profile_config:
                            outputs = profile_config['outputs']
                            if isinstance(outputs, dict):
                                # Get the target output
                                target = profile_config.get('target', 'dev')
                                if target in outputs:
                                    output_config = outputs[target]
                                    if isinstance(output_config, dict) and 'type' in output_config:
                                        return output_config['type']
        except Exception as e:
            print(f"Error reading home profiles.yml: {e}")

    return None


def check_adapter_installed(project_dir: Path, adapter_type: str) -> tuple[bool, str | None]:
    """Check if a DBT adapter is installed in the project's venv.

    Args:
        project_dir: Path to the project directory
        adapter_type: The adapter type (e.g., 'duckdb', 'snowflake')

    Returns:
        Tuple of (is_installed, version)
    """
    package_name = f"dbt-{adapter_type}"

    # Check if using uv (modern Dagster projects)
    venv_dir = project_dir / ".venv"
    if not venv_dir.exists():
        return False, None

    try:
        # Try using uv pip (for projects created with uv)
        import os
        env = os.environ.copy()
        env["UV_PROJECT_ENVIRONMENT"] = str(venv_dir.absolute())

        result = subprocess.run(
            ["uv", "pip", "show", package_name],
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
        print(f"Error checking adapter installation: {e}")
        return False, None


@router.get("/{project_id}/status", response_model=AdapterStatusResponse)
async def get_adapter_status(project_id: str):
    """Get the status of DBT adapters for a project.

    This detects which adapter is required and checks if it's installed.
    """
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project_service._get_project_dir(project)

    # Find dbt project within the Dagster project
    print(f"[dbt_adapters] Project has {len(project.components)} components")
    for c in project.components:
        print(f"[dbt_adapters]   - {c.id}: {c.component_type}")

    dbt_components = [c for c in project.components if 'dbt' in c.component_type.lower()]
    print(f"[dbt_adapters] Found {len(dbt_components)} dbt components")

    if not dbt_components:
        return AdapterStatusResponse(
            project_id=project_id,
            adapters=[],
            dbt_project_path=None
        )

    # Get the dbt project path from the first dbt component
    # Can be 'project_path' (created by tool) or 'project' (imported projects)
    dbt_component = dbt_components[0]
    dbt_project_path_str = dbt_component.attributes.get('project_path') or dbt_component.attributes.get('project', '')
    print(f"[dbt_adapters] dbt_project_path_str: {dbt_project_path_str}")

    if not dbt_project_path_str:
        print(f"[dbt_adapters] No dbt project path found")
        return AdapterStatusResponse(
            project_id=project_id,
            adapters=[],
            dbt_project_path=None
        )

    # Resolve the dbt project path
    # If it's an absolute path, use it as-is; otherwise treat as relative
    from pathlib import Path as PathlibPath
    dbt_path = PathlibPath(dbt_project_path_str)
    if dbt_path.is_absolute():
        dbt_project_path = dbt_path
    else:
        # Relative to the Dagster project
        dbt_project_path = project_dir / dbt_project_path_str

    print(f"[dbt_adapters] dbt_project_path: {dbt_project_path}, exists: {dbt_project_path.exists()}")

    if not dbt_project_path.exists():
        print(f"[dbt_adapters] dbt project path does not exist")
        return AdapterStatusResponse(
            project_id=project_id,
            adapters=[],
            dbt_project_path=str(dbt_project_path)
        )

    # Detect required adapter
    adapter_type = detect_required_adapter(dbt_project_path)
    print(f"[dbt_adapters] Detected adapter type: {adapter_type}")

    adapters = []
    if adapter_type:
        package_name = f"dbt-{adapter_type}"
        is_installed, version = check_adapter_installed(project_dir, adapter_type)

        adapters.append(AdapterInfo(
            adapter_type=adapter_type,
            required=True,
            installed=is_installed,
            package_name=package_name,
            version=version
        ))

    return AdapterStatusResponse(
        project_id=project_id,
        adapters=adapters,
        dbt_project_path=str(dbt_project_path)
    )


@router.post("/{project_id}/install", response_model=InstallAdapterResponse)
async def install_adapter(project_id: str, request: InstallAdapterRequest):
    """Install a DBT adapter in the project's virtual environment.

    This runs uv pip install dbt-{adapter_type} in the project's venv.
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

    package_name = f"dbt-{request.adapter_type}"

    try:
        print(f"[install_adapter] Installing {package_name} in project {project_id}")

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

        print(f"[install_adapter] {message}")
        print(f"[install_adapter] stdout: {result.stdout[:500]}")
        print(f"[install_adapter] stderr: {result.stderr[:500]}")

        return InstallAdapterResponse(
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
