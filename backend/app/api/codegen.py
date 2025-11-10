"""API endpoints for code generation."""

import shutil
import tempfile
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..services.project_service import project_service
from ..services.codegen_service import codegen_service

router = APIRouter(prefix="/codegen", tags=["codegen"])


class GenerateRequest(BaseModel):
    """Request to generate code."""

    project_id: str
    include_deployment: bool = True


@router.post("/generate")
async def generate_code(request: GenerateRequest):
    """Generate Dagster code from a project.

    Args:
        request: Generation request with project ID
    """
    project = project_service.get_project(request.project_id)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Create temporary directory for generation
    temp_dir = Path(tempfile.mkdtemp())

    try:
        # Generate YAML files
        generated_files = codegen_service.generate_dagster_yaml(project, temp_dir)

        # Generate deployment files if requested
        if request.include_deployment:
            project_name = codegen_service._sanitize_name(project.name)
            deployment_dir = temp_dir / project_name
            deployment_files = codegen_service.generate_deployment_files(
                project, deployment_dir
            )
            generated_files.extend(deployment_files)

        # Create zip archive
        archive_path = temp_dir / "dagster_project"
        shutil.make_archive(str(archive_path), "zip", temp_dir)

        return FileResponse(
            path=f"{archive_path}.zip",
            media_type="application/zip",
            filename=f"{project.name.replace(' ', '_')}.zip",
        )

    except Exception as e:
        # Cleanup temp directory on error
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")


@router.get("/preview/{project_id}")
async def preview_code(project_id: str):
    """Preview generated code for a project.

    Args:
        project_id: Project ID
    """
    project = project_service.get_project(project_id)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Create temporary directory for generation
    temp_dir = Path(tempfile.mkdtemp())

    try:
        # Generate files
        generated_files = codegen_service.generate_dagster_yaml(project, temp_dir)

        # Read and return file contents
        files_content = {}
        for file_path in generated_files:
            relative_path = file_path.relative_to(temp_dir)
            with open(file_path, "r") as f:
                files_content[str(relative_path)] = f.read()

        return {
            "files": files_content,
            "project_name": project.name,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview failed: {e}")

    finally:
        # Cleanup temp directory
        shutil.rmtree(temp_dir, ignore_errors=True)
