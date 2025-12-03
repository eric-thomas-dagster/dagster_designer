"""API endpoints for dependency management."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.dependency_manager import dependency_manager
from ..services.project_service import project_service

router = APIRouter(prefix="/dependencies", tags=["dependencies"])


class DependencyAnalysisResponse(BaseModel):
    """Response from dependency analysis."""
    required_packages: list[str]
    already_installed: list[str]
    needs_installation: list[str]


class DependencySyncResponse(BaseModel):
    """Response from dependency sync operation."""
    dependencies_added: bool
    added_packages: list[str]
    message: str


@router.get("/{project_id}/analyze", response_model=DependencyAnalysisResponse)
async def analyze_dependencies(project_id: str):
    """
    Analyze all components in a project and return required packages.

    This is a read-only operation that shows what packages would be needed
    without actually installing anything.

    Args:
        project_id: Project ID

    Returns:
        DependencyAnalysisResponse with required packages
    """
    try:
        # Get required packages from components
        required_packages = dependency_manager.analyze_all_components(project_id)

        # Get currently installed packages from pyproject.toml
        project = project_service.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        project_dir = project_service._get_project_dir(project)
        pyproject_path = project_dir / "pyproject.toml"

        already_installed = []
        if pyproject_path.exists():
            import toml
            with open(pyproject_path) as f:
                pyproject = toml.load(f)

            current_deps = pyproject.get("project", {}).get("dependencies", [])

            # Check which required packages are already present
            for package in required_packages:
                base_package = package.split("[")[0]
                if any(base_package in dep for dep in current_deps):
                    already_installed.append(package)

        needs_installation = [
            pkg for pkg in required_packages
            if pkg not in already_installed
        ]

        return DependencyAnalysisResponse(
            required_packages=required_packages,
            already_installed=already_installed,
            needs_installation=needs_installation
        )

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to analyze dependencies: {str(e)}"
        )


@router.post("/{project_id}/sync", response_model=DependencySyncResponse)
async def sync_dependencies(project_id: str):
    """
    Sync dependencies for all components in a project.

    Analyzes all component configurations, adds missing packages to pyproject.toml,
    and triggers background installation.

    Args:
        project_id: Project ID

    Returns:
        DependencySyncResponse with sync results
    """
    try:
        dependencies_added, added_packages = dependency_manager.sync_project_dependencies(
            project_id,
            auto_install=True
        )

        if dependencies_added:
            message = f"Added {len(added_packages)} package(s) and triggered background installation"
        else:
            message = "All required dependencies already present"

        return DependencySyncResponse(
            dependencies_added=dependencies_added,
            added_packages=added_packages,
            message=message
        )

    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to sync dependencies: {str(e)}"
        )


@router.get("/destination-packages")
async def list_destination_packages():
    """
    List all dlt destination packages and their package names.

    Returns a mapping of destination names to pip package specifiers.

    Returns:
        Dict mapping destination names to package specifiers
    """
    from ..services.dependency_manager import DLT_DESTINATION_PACKAGES

    return {
        "destinations": DLT_DESTINATION_PACKAGES,
        "total": len(DLT_DESTINATION_PACKAGES)
    }
