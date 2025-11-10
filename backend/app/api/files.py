"""API endpoints for file operations."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.file_service import FileService
from app.core.config import settings

router = APIRouter(prefix="/files", tags=["files"])
file_service = FileService(str(settings.projects_dir))


class WriteFileRequest(BaseModel):
    """Request to write a file."""

    content: str


class CreateDirectoryRequest(BaseModel):
    """Request to create a directory."""

    pass  # Path comes from URL


class ExecuteCommandRequest(BaseModel):
    """Request to execute a command."""

    command: str
    timeout: int = 30


@router.get("/list/{project_id}")
async def list_files(project_id: str, path: str = ""):
    """
    List files and directories in a project.

    Args:
        project_id: The project ID
        path: Optional subdirectory path (default: root)

    Returns:
        Tree structure of files and directories
    """
    try:
        result = file_service.list_files(project_id, path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list files: {str(e)}")


@router.get("/read/{project_id}/{file_path:path}")
async def read_file(project_id: str, file_path: str):
    """
    Read the contents of a file.

    Args:
        project_id: The project ID
        file_path: Path to the file relative to project root

    Returns:
        File content and metadata
    """
    try:
        result = file_service.read_file(project_id, file_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")


@router.post("/write/{project_id}/{file_path:path}")
async def write_file(project_id: str, file_path: str, request: WriteFileRequest):
    """
    Write content to a file.

    Creates the file if it doesn't exist, including parent directories.

    Args:
        project_id: The project ID
        file_path: Path to the file relative to project root
        request: Request containing file content

    Returns:
        Success message and file metadata
    """
    try:
        result = file_service.write_file(project_id, file_path, request.content)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {str(e)}")


@router.delete("/delete/{project_id}/{file_path:path}")
async def delete_file(project_id: str, file_path: str):
    """
    Delete a file.

    Args:
        project_id: The project ID
        file_path: Path to the file relative to project root

    Returns:
        Success message
    """
    try:
        result = file_service.delete_file(project_id, file_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")


@router.post("/mkdir/{project_id}/{dir_path:path}")
async def create_directory(project_id: str, dir_path: str):
    """
    Create a new directory.

    Args:
        project_id: The project ID
        dir_path: Path to the directory relative to project root

    Returns:
        Success message
    """
    try:
        result = file_service.create_directory(project_id, dir_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to create directory: {str(e)}"
        )


@router.delete("/rmdir/{project_id}/{dir_path:path}")
async def delete_directory(project_id: str, dir_path: str):
    """
    Delete a directory and all its contents.

    Args:
        project_id: The project ID
        dir_path: Path to the directory relative to project root

    Returns:
        Success message
    """
    try:
        result = file_service.delete_directory(project_id, dir_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to delete directory: {str(e)}"
        )


@router.post("/execute/{project_id}")
async def execute_command(project_id: str, request: ExecuteCommandRequest):
    """
    Execute a shell command in the project directory.

    WARNING: Only whitelisted commands are allowed for security.

    Args:
        project_id: The project ID
        request: Request containing command and timeout

    Returns:
        Command output (stdout, stderr, return code)
    """
    try:
        result = file_service.execute_command(
            project_id, request.command, request.timeout
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to execute command: {str(e)}"
        )
