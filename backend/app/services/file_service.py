"""Service for file operations within Dagster projects."""

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from ..core.uv_binary import venv_bin_path


class FileService:
    """Service for managing files in Dagster projects."""

    def __init__(self, projects_dir: str = "./projects"):
        self.projects_dir = Path(projects_dir)
        self.projects_dir.mkdir(exist_ok=True)

    def _get_project_path(self, project_id: str) -> Path:
        """Get the path to a project directory, using directory_name if available."""
        from .project_service import project_service

        # Get the project to access directory_name
        project = project_service.get_project(project_id)
        if not project:
            raise FileNotFoundError(f"Project {project_id} not found")

        # Use directory_name if available, otherwise fall back to project_id
        if project.directory_name:
            project_path = self.projects_dir / project.directory_name
        else:
            project_path = self.projects_dir / project_id

        if not project_path.exists():
            raise FileNotFoundError(f"Project directory not found: {project_path}")

        return project_path

    def _is_safe_path(self, base_path: Path, target_path: Path) -> bool:
        """Check if the target path is within the base path (prevent directory traversal)."""
        try:
            target_path.resolve().relative_to(base_path.resolve())
            return True
        except ValueError:
            return False

    def list_files(self, project_id: str, path: str = "") -> dict[str, Any]:
        """
        List files and directories in a project path.

        Returns a tree structure with files and directories.
        """
        project_path = self._get_project_path(project_id)
        target_path = project_path / path if path else project_path

        if not self._is_safe_path(project_path, target_path):
            raise ValueError("Invalid path: directory traversal detected")

        if not target_path.exists():
            raise FileNotFoundError(f"Path not found: {path}")

        def build_tree(dir_path: Path, relative_to: Path) -> dict[str, Any]:
            """Recursively build file tree."""
            items = []

            try:
                for item in sorted(dir_path.iterdir()):
                    # Skip hidden files and common directories to ignore
                    if item.name.startswith(".") or item.name in [
                        "__pycache__",
                        "node_modules",
                        ".venv",
                        "venv",
                        ".dagster",
                        ".pytest_cache",
                        ".tox",
                    ]:
                        continue

                    relative_path = item.relative_to(relative_to).as_posix()

                    if item.is_dir():
                        items.append(
                            {
                                "name": item.name,
                                "path": relative_path,
                                "type": "directory",
                                "children": build_tree(item, relative_to)["children"],
                            }
                        )
                    else:
                        items.append(
                            {
                                "name": item.name,
                                "path": relative_path,
                                "type": "file",
                                "size": item.stat().st_size,
                            }
                        )
            except PermissionError:
                pass

            return {"children": items}

        tree = build_tree(target_path, project_path)
        return {
            "project_id": project_id,
            "path": path,
            "tree": tree,
        }

    def read_file(self, project_id: str, file_path: str) -> dict[str, Any]:
        """
        Read the contents of a file.

        Returns file content and metadata.
        """
        project_path = self._get_project_path(project_id)
        target_file = project_path / file_path

        if not self._is_safe_path(project_path, target_file):
            raise ValueError("Invalid path: directory traversal detected")

        if not target_file.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        if not target_file.is_file():
            raise ValueError(f"Not a file: {file_path}")

        # Detect binary files
        try:
            with open(target_file, "r", encoding="utf-8") as f:
                content = f.read()

            return {
                "project_id": project_id,
                "path": file_path,
                "content": content,
                "size": target_file.stat().st_size,
                "is_binary": False,
            }
        except UnicodeDecodeError:
            # Binary file
            return {
                "project_id": project_id,
                "path": file_path,
                "content": None,
                "size": target_file.stat().st_size,
                "is_binary": True,
                "message": "Binary file cannot be displayed",
            }

    def write_file(
        self, project_id: str, file_path: str, content: str
    ) -> dict[str, Any]:
        """
        Write content to a file.

        Creates the file if it doesn't exist, including parent directories.
        """
        project_path = self._get_project_path(project_id)
        target_file = project_path / file_path

        if not self._is_safe_path(project_path, target_file):
            raise ValueError("Invalid path: directory traversal detected")

        # Create parent directories if they don't exist
        target_file.parent.mkdir(parents=True, exist_ok=True)

        with open(target_file, "w", encoding="utf-8") as f:
            f.write(content)

        return {
            "project_id": project_id,
            "path": file_path,
            "size": target_file.stat().st_size,
            "message": "File saved successfully",
        }

    def delete_file(self, project_id: str, file_path: str) -> dict[str, Any]:
        """Delete a file."""
        project_path = self._get_project_path(project_id)
        target_file = project_path / file_path

        if not self._is_safe_path(project_path, target_file):
            raise ValueError("Invalid path: directory traversal detected")

        if not target_file.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        if target_file.is_dir():
            raise ValueError("Cannot delete directory, use delete_directory instead")

        target_file.unlink()

        return {
            "project_id": project_id,
            "path": file_path,
            "message": "File deleted successfully",
        }

    def create_directory(self, project_id: str, dir_path: str) -> dict[str, Any]:
        """Create a new directory."""
        project_path = self._get_project_path(project_id)
        target_dir = project_path / dir_path

        if not self._is_safe_path(project_path, target_dir):
            raise ValueError("Invalid path: directory traversal detected")

        target_dir.mkdir(parents=True, exist_ok=True)

        return {
            "project_id": project_id,
            "path": dir_path,
            "message": "Directory created successfully",
        }

    def delete_directory(self, project_id: str, dir_path: str) -> dict[str, Any]:
        """Delete a directory and all its contents."""
        import shutil

        project_path = self._get_project_path(project_id)
        target_dir = project_path / dir_path

        if not self._is_safe_path(project_path, target_dir):
            raise ValueError("Invalid path: directory traversal detected")

        if not target_dir.exists():
            raise FileNotFoundError(f"Directory not found: {dir_path}")

        if not target_dir.is_dir():
            raise ValueError(f"Not a directory: {dir_path}")

        # Use shutil.rmtree to recursively delete directory and contents
        shutil.rmtree(target_dir)

        return {
            "project_id": project_id,
            "path": dir_path,
            "message": "Directory deleted successfully",
        }

    def rename_file(
        self, project_id: str, old_path: str, new_path: str
    ) -> dict[str, Any]:
        """
        Rename a file or directory.

        Args:
            project_id: The project ID
            old_path: Current path of the file/directory
            new_path: New path for the file/directory

        Returns:
            Success message with old and new paths
        """
        project_path = self._get_project_path(project_id)
        old_target = project_path / old_path
        new_target = project_path / new_path

        # Security checks
        if not self._is_safe_path(project_path, old_target):
            raise ValueError("Invalid old path: directory traversal detected")

        if not self._is_safe_path(project_path, new_target):
            raise ValueError("Invalid new path: directory traversal detected")

        if not old_target.exists():
            raise FileNotFoundError(f"File or directory not found: {old_path}")

        if new_target.exists():
            raise ValueError(f"Target path already exists: {new_path}")

        # Create parent directories if they don't exist
        new_target.parent.mkdir(parents=True, exist_ok=True)

        # Perform the rename
        old_target.rename(new_target)

        return {
            "project_id": project_id,
            "old_path": old_path,
            "new_path": new_path,
            "message": "File renamed successfully",
        }

    def execute_command(
        self, project_id: str, command: str, timeout: int = 30
    ) -> dict[str, Any]:
        """
        Execute a shell command in the project directory.

        WARNING: This is potentially dangerous. In production, you should:
        1. Whitelist allowed commands
        2. Run in a sandboxed environment
        3. Implement proper authentication/authorization
        4. Add rate limiting
        """
        project_path = self._get_project_path(project_id)

        # Allowlist of commands safe to run in a project terminal.
        # Deliberately excludes destructive system commands (rm -rf /, format,
        # net user, reg delete, etc.) while covering everything a developer
        # needs day-to-day in a Dagster project.
        allowed_commands = [
            # File navigation / inspection
            "ls", "dir", "cat", "type", "head", "tail", "find", "grep",
            "tree", "pwd", "echo", "more", "less",
            # Python / package management
            "python", "python3", "pip", "pip3", "uv", "uvx",
            # Dagster / dg CLI
            "dg", "dagster",
            # dbt
            "dbt",
            # Code quality
            "pytest", "black", "ruff", "mypy", "isort", "flake8", "pylint",
            "pre-commit",
            # Git (read-only and safe write ops)
            "git",
            # Node / JS tooling (for projects with a JS layer)
            "node", "npm", "npx", "yarn", "pnpm",
            # General dev utilities
            "make", "curl", "wget", "jq",
            # Environment inspection
            "env", "printenv", "set",
        ]

        command_parts = command.strip().split()
        if not command_parts or command_parts[0] not in allowed_commands:
            raise ValueError(
                f"Command not allowed. Allowed commands: {', '.join(allowed_commands)}"
            )

        # On Windows, `ls` is a PowerShell alias — not a real executable.
        # Remap it to `dir` so users can type either without thinking about it.
        if sys.platform == "win32" and command_parts[0] == "ls":
            command_parts[0] = "dir"

        # Use project's virtual environment for dg/dagster/python commands
        # Build command as list for subprocess, not shell string
        cmd_list = command_parts.copy()
        if command_parts[0] in ["dg", "dagster", "python", "pip"]:
            venv_cmd = venv_bin_path(project_path / ".venv", command_parts[0])
            if venv_cmd.exists():
                # Use absolute path to venv command
                cmd_list = [str(venv_cmd.absolute())] + command_parts[1:]

        # On Windows, several commands are cmd.exe built-ins rather than
        # standalone executables — wrap them so they resolve correctly.
        WINDOWS_BUILTINS = {"dir", "type", "tree", "find", "more", "set", "echo", "findstr"}
        if sys.platform == "win32" and cmd_list[0] in WINDOWS_BUILTINS:
            cmd_list = ["cmd", "/c"] + cmd_list

        try:
            result = subprocess.run(
                cmd_list,
                cwd=str(project_path.absolute()),
                capture_output=True,
                text=True,
                timeout=timeout,
            )

            return {
                "project_id": project_id,
                "command": " ".join(cmd_list),
                "stdout": result.stdout,
                "stderr": result.stderr,
                "return_code": result.returncode,
                "success": result.returncode == 0,
            }
        except subprocess.TimeoutExpired:
            return {
                "project_id": project_id,
                "command": command,
                "stdout": "",
                "stderr": f"Command timed out after {timeout} seconds",
                "return_code": -1,
                "success": False,
            }
        except Exception as e:
            return {
                "project_id": project_id,
                "command": command,
                "stdout": "",
                "stderr": str(e),
                "return_code": -1,
                "success": False,
            }
