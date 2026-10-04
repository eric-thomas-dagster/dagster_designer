"""API endpoints for file operations."""

import asyncio
import json
import subprocess
import sys
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.file_service import FileService
from app.core.config import settings
from app.core.uv_binary import venv_bin_path

router = APIRouter(prefix="/files", tags=["files"])
file_service = FileService(str(settings.projects_dir))


class WriteFileRequest(BaseModel):
    """Request to write a file."""

    content: str


class CreateDirectoryRequest(BaseModel):
    """Request to create a directory."""

    pass  # Path comes from URL


class RenameFileRequest(BaseModel):
    """Request to rename a file or directory."""

    new_path: str


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


@router.post("/rename/{project_id}/{old_path:path}")
async def rename_file(project_id: str, old_path: str, request: RenameFileRequest):
    """
    Rename a file or directory.

    Args:
        project_id: The project ID
        old_path: Current path of the file/directory
        request: Request containing new path

    Returns:
        Success message with old and new paths
    """
    try:
        result = file_service.rename_file(project_id, old_path, request.new_path)
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to rename file: {str(e)}"
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


@router.get("/execute-stream/{project_id}")
async def execute_command_stream(project_id: str, command: str, request: Request):
    """Execute a command and stream output line-by-line via SSE.

    Each event is a JSON object: {"type": "stdout"|"stderr"|"exit", "data": str|int}
    The stream ends with a {"type": "exit", "data": <return_code>} event.
    When the client disconnects (e.g. Ctrl+C in the terminal), the subprocess
    is killed so long-running processes like `dg dev` actually stop.
    """
    try:
        project_path = file_service._get_project_path(project_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    allowed_commands = [
        "ls", "dir", "cat", "type", "head", "tail", "find", "grep",
        "tree", "pwd", "echo", "more", "less",
        "python", "python3", "pip", "pip3", "uv", "uvx",
        "dg", "dagster",
        "dbt",
        "pytest", "black", "ruff", "mypy", "isort", "flake8", "pylint",
        "pre-commit",
        "git",
        "node", "npm", "npx", "yarn", "pnpm",
        "make", "curl", "wget", "jq",
        "env", "printenv", "set",
    ]

    command_parts = command.strip().split()
    if not command_parts or command_parts[0] not in allowed_commands:
        raise HTTPException(
            status_code=400,
            detail=f"Command not allowed. Allowed commands: {', '.join(allowed_commands)}"
        )

    if sys.platform == "win32" and command_parts[0] == "ls":
        command_parts[0] = "dir"

    cmd_list = command_parts.copy()
    if command_parts[0] in ["dg", "dagster", "python", "python3", "pip", "pip3"]:
        venv_cmd = venv_bin_path(project_path / ".venv", command_parts[0])
        if venv_cmd.exists():
            cmd_list = [str(venv_cmd.absolute())] + command_parts[1:]

    WINDOWS_BUILTINS = {"dir", "type", "tree", "find", "more", "set", "echo", "findstr"}
    if sys.platform == "win32" and cmd_list[0] in WINDOWS_BUILTINS:
        cmd_list = ["cmd", "/c"] + cmd_list

    async def event_stream() -> AsyncGenerator[str, None]:
        def sse(obj: dict) -> str:
            return f"data: {json.dumps(obj)}\n\n"

        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd_list,
                cwd=str(project_path.absolute()),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            assert proc.stdout is not None

            while True:
                # Check if the client disconnected before reading next line
                if await request.is_disconnected():
                    break

                try:
                    raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=0.5)
                except asyncio.TimeoutError:
                    # No output yet — loop back and check disconnect again
                    if proc.returncode is not None:
                        break
                    continue

                if not raw_line:
                    # EOF
                    break

                line = raw_line.decode("utf-8", errors="replace").rstrip("\n\r")
                yield sse({"type": "stdout", "data": line})

            await proc.wait()
            yield sse({"type": "exit", "data": proc.returncode})

        except Exception as e:
            yield sse({"type": "stderr", "data": str(e)})
            yield sse({"type": "exit", "data": 1})
        finally:
            # Always kill the process when the stream ends — covers both
            # normal exit and client disconnect (Ctrl+C in the terminal).
            if proc is not None and proc.returncode is None:
                try:
                    if sys.platform == "win32":
                        # On Windows, terminate() only kills the top-level
                        # process. Use taskkill /F /T to also kill the whole
                        # child process tree (dg dev spawns dagster-webserver
                        # and potentially other children).
                        subprocess.run(
                            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                            capture_output=True,
                        )
                    else:
                        import signal, os
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except Exception:
                    try:
                        proc.terminate()
                    except Exception:
                        pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
