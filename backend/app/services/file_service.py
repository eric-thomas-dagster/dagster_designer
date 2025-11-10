"""Service for file operations within Dagster projects."""

import os
import subprocess
from pathlib import Path
from typing import Any


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

                    relative_path = str(item.relative_to(relative_to))

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

        # Basic command validation - whitelist common safe commands
        allowed_commands = [
            "ls",
            "dg",
            "dagster",
            "uv",
            "python",
            "pip",
            "pytest",
            "black",
            "ruff",
            "mypy",
        ]

        command_parts = command.strip().split()
        if not command_parts or command_parts[0] not in allowed_commands:
            raise ValueError(
                f"Command not allowed. Allowed commands: {', '.join(allowed_commands)}"
            )

        try:
            result = subprocess.run(
                command,
                shell=True,
                cwd=project_path,
                capture_output=True,
                text=True,
                timeout=timeout,
            )

            return {
                "project_id": project_id,
                "command": command,
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
