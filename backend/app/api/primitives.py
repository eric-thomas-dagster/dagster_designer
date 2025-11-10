"""API endpoints for managing Dagster primitives."""

import subprocess
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException

from app.services.primitives_service import PrimitivesService, PrimitiveCategory
from app.core.config import settings

router = APIRouter(prefix="/primitives", tags=["primitives"])
primitives_service = PrimitivesService(str(settings.projects_dir))


@router.get("/list/{project_id}/{category}")
async def list_primitives(project_id: str, category: PrimitiveCategory):
    """
    List primitives of a specific category.

    Args:
        project_id: Project ID
        category: Type of primitive (schedule, job, sensor, asset_check)

    Returns:
        List of primitives
    """
    try:
        primitives = primitives_service.list_primitives(project_id, category)
        return {
            "project_id": project_id,
            "category": category,
            "primitives": primitives,
            "total": len(primitives),
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to list primitives: {str(e)}"
        )


@router.get("/list/{project_id}")
async def list_all_primitives(project_id: str):
    """
    List all primitives in a project.

    Args:
        project_id: Project ID

    Returns:
        Dictionary with all primitive categories
    """
    try:
        primitives = primitives_service.list_all_primitives(project_id)
        return {
            "project_id": project_id,
            "primitives": primitives,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to list primitives: {str(e)}"
        )


@router.get("/details/{project_id}/{category}/{name}")
async def get_primitive_details(project_id: str, category: PrimitiveCategory, name: str):
    """
    Get detailed information about a specific primitive.

    Args:
        project_id: Project ID
        category: Type of primitive
        name: Name of the primitive

    Returns:
        Primitive details including code
    """
    try:
        primitive = primitives_service.get_primitive_details(project_id, category, name)

        if not primitive:
            raise HTTPException(
                status_code=404,
                detail=f"Primitive {name} not found in category {category}",
            )

        return {
            "project_id": project_id,
            "category": category,
            "primitive": primitive,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get primitive details: {str(e)}"
        )


@router.delete("/delete/{project_id}/{category}/{name}")
async def delete_primitive(project_id: str, category: PrimitiveCategory, name: str):
    """
    Delete a primitive from the project.

    Args:
        project_id: Project ID
        category: Type of primitive
        name: Name of the primitive

    Returns:
        Success message
    """
    try:
        success = primitives_service.delete_primitive(project_id, category, name)

        if not success:
            raise HTTPException(
                status_code=404,
                detail=f"Primitive {name} not found in category {category}",
            )

        return {
            "message": f"Successfully deleted {category} '{name}'",
            "project_id": project_id,
            "category": category,
            "name": name,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to delete primitive: {str(e)}"
        )


@router.get("/statistics/{project_id}")
async def get_statistics(project_id: str):
    """
    Get statistics about primitives in the project.

    Args:
        project_id: Project ID

    Returns:
        Statistics about primitive counts
    """
    try:
        stats = primitives_service.get_statistics(project_id)
        return {
            "project_id": project_id,
            "statistics": stats,
        }
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to get statistics: {str(e)}"
        )


def _search_primitive_definition_internal(project_id: str, primitive_type: str, name: str) -> dict:
    """Internal helper for searching primitive definitions."""
    try:
        # Get project path
        project_file = (settings.projects_dir / f"{project_id}.json").resolve()
        if not project_file.exists():
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

        # Read project metadata to get directory name
        with open(project_file, 'r') as f:
            project_data = json.load(f)

        directory_name = project_data.get("directory_name", project_id)
        project_path = (settings.projects_dir / directory_name).resolve()

        if not project_path.exists():
            raise HTTPException(status_code=404, detail=f"Project directory not found")

        # Search patterns based on primitive type
        search_patterns = []
        if primitive_type == "job":
            search_patterns = [
                f'name="{name}"',
                f"name='{name}'",
                f"@job\\(name=\"{name}\"",
                f"@job\\(name='{name}'",
                f"define_asset_job\\([^)]*name=\"{name}\"",
            ]
        elif primitive_type == "schedule":
            search_patterns = [
                f'name="{name}"',
                f"name='{name}'",
                f"@schedule\\([^)]*name=\"{name}\"",
                f"@schedule\\([^)]*name='{name}'",
            ]
        elif primitive_type == "sensor":
            search_patterns = [
                f'name="{name}"',
                f"name='{name}'",
                f"@sensor\\([^)]*name=\"{name}\"",
                f"@sensor\\([^)]*name='{name}'",
                f"def {name}\\(",  # Function definition
            ]
        elif primitive_type == "asset_check":
            # Special handling for dbt tests
            # dbt test names follow patterns like:
            # - not_null_customer_metrics_total_orders
            # - unique_customer_metrics_customer_key
            # - accepted_values_customer_metrics_...
            # - dbt_utils_accepted_range_customer_metrics_...

            # Try to extract the model name from the test name
            # Common patterns: {test_type}_{model_name}_{column_name}
            model_name = None

            # Remove common test prefixes
            test_prefixes = [
                'not_null_', 'unique_', 'accepted_values_', 'relationships_',
                'dbt_utils_accepted_range_', 'dbt_utils_expression_is_true_',
                'dbt_utils_recency_', 'dbt_utils_'
            ]

            name_without_prefix = name
            for prefix in test_prefixes:
                if name.startswith(prefix):
                    name_without_prefix = name[len(prefix):]
                    break

            # The model name is typically the first part after removing the prefix
            # e.g., "customer_metrics_total_orders" -> "customer_metrics"
            parts = name_without_prefix.split('_')

            # Try different lengths to find the model
            # Start with 2 words, then 3, then 1
            for num_parts in [2, 3, 1]:
                if len(parts) >= num_parts:
                    potential_model = '_'.join(parts[:num_parts])

                    # Search for schema.yml files containing this model
                    # Use find + grep to search for the model in yml files
                    find_result = subprocess.run(
                        ["find", ".", "-name", "*.yml", "-type", "f", "-not", "-path", "*/.venv/*", "-not", "-path", "*/dbt_packages/*"],
                        cwd=str(project_path),
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )

                    if find_result.returncode != 0:
                        continue

                    yml_files = find_result.stdout.strip().split('\n')

                    # Search each yml file for the model definition
                    for yml_file in yml_files:
                        if not yml_file:
                            continue

                        grep_result = subprocess.run(
                            ["grep", "-n", "--", f"- name: {potential_model}", yml_file],
                            cwd=str(project_path),
                            capture_output=True,
                            text=True,
                            timeout=5,
                        )

                        if grep_result.returncode == 0:
                            # Found the model in this file
                            line_match = grep_result.stdout.strip().split(':')
                            if len(line_match) >= 1:
                                line_number = int(line_match[0])
                                schema_file = yml_file.lstrip('./')
                                return {
                                    "found": True,
                                    "file_path": schema_file,
                                    "line_number": line_number,
                                    "primitive_type": primitive_type,
                                    "name": name,
                                }

            # Fallback: search for custom asset check definitions in Python
            search_patterns = [
                f'name="{name}"',
                f"name='{name}'",
                f"@asset_check\\([^)]*name=\"{name}\"",
                f"@asset_check\\([^)]*name='{name}'",
                f"def {name}\\(",  # Function definition
            ]
        else:
            search_patterns = []

        # Search for the patterns in Python files
        for pattern in search_patterns:
            result = subprocess.run(
                ["grep", "-rn", "-E", pattern, "--include=*.py", "."],
                cwd=str(project_path),
                capture_output=True,
                text=True,
                timeout=10,
            )

            if result.returncode == 0 and result.stdout:
                # Parse the first match
                lines = result.stdout.strip().split('\n')
                for line in lines:
                    # Skip venv and build directories
                    if '/.venv/' in line or '/__pycache__/' in line or '/build/' in line:
                        continue

                    # Format: ./path/to/file.py:123:code
                    parts = line.split(':', 2)
                    if len(parts) >= 2:
                        file_path = parts[0].lstrip('./')
                        line_number = int(parts[1])

                        return {
                            "found": True,
                            "file_path": file_path,
                            "line_number": line_number,
                            "primitive_type": primitive_type,
                            "name": name,
                        }

        # Not found
        return {
            "found": False,
            "primitive_type": primitive_type,
            "name": name,
        }

    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=500,
            detail="Search timed out"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to search for primitive: {str(e)}"
        )


@router.get("/definitions/{project_id}/search/{primitive_type}/{name}")
async def search_primitive_definition(project_id: str, primitive_type: str, name: str):
    """
    Search for a primitive's definition in the project codebase.

    Args:
        project_id: Project ID
        primitive_type: Type of primitive (job, schedule, sensor, asset_check)
        name: Name of the primitive to search for

    Returns:
        File path and line number if found
    """
    return _search_primitive_definition_internal(project_id, primitive_type, name)


@router.get("/definitions/{project_id}")
async def list_all_definitions(project_id: str):
    """
    List all definitions (jobs, schedules, sensors) from the project using dg list defs.

    This endpoint discovers ALL primitives in the project, not just those created
    through the template system.

    Args:
        project_id: Project ID

    Returns:
        All definitions discovered in the project
    """
    try:
        # Get project path
        project_file = (settings.projects_dir / f"{project_id}.json").resolve()
        if not project_file.exists():
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

        # Read project metadata to get directory name
        with open(project_file, 'r') as f:
            project_data = json.load(f)

        directory_name = project_data.get("directory_name", project_id)
        project_path = (settings.projects_dir / directory_name).resolve()

        if not project_path.exists():
            raise HTTPException(status_code=404, detail=f"Project directory not found")

        # Check for venv
        venv_dg = project_path / ".venv" / "bin" / "dg"
        if not venv_dg.exists():
            raise HTTPException(
                status_code=500,
                detail="Project virtual environment not found. dg command not available."
            )

        # Run dg list defs --json with clean environment
        # Set PATH to prioritize project's venv to avoid conflicts with system packages
        import os
        env = os.environ.copy()
        # Remove VIRTUAL_ENV and other Python paths from parent process
        env.pop('VIRTUAL_ENV', None)
        env.pop('PYTHONPATH', None)
        env.pop('PYTHONHOME', None)
        # Prepend project's venv bin to PATH so dbt command uses correct version
        project_venv_bin = str(project_path / ".venv" / "bin")
        env['PATH'] = f"{project_venv_bin}:{env.get('PATH', '')}"

        result = subprocess.run(
            [str(venv_dg), "list", "defs", "--json"],
            cwd=str(project_path),
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )

        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to list definitions: {result.stderr}"
            )

        # Parse JSON output
        defs = json.loads(result.stdout)

        # Resolve dbt test sources to actual file locations
        asset_checks = defs.get("asset_checks", [])
        for check in asset_checks:
            source = check.get("source", "")
            # Check if this is a dbt test (source points to defs.yaml)
            if source and "defs.yaml" in source and "dbt" in source.lower():
                # Try to find the actual test definition
                try:
                    search_result = _search_primitive_definition_internal(
                        project_id, "asset_check", check["name"]
                    )
                    if search_result["found"] and search_result.get("file_path"):
                        # Update source to point to actual file
                        line_number = search_result.get("line_number", "")
                        check["source"] = f"{search_result['file_path']}" + (f":{line_number}" if line_number else "")
                except Exception as e:
                    # If search fails, keep original source
                    pass

        return {
            "project_id": project_id,
            "jobs": defs.get("jobs", []),
            "schedules": defs.get("schedules", []),
            "sensors": defs.get("sensors", []),
            "asset_checks": asset_checks,
        }

    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=500,
            detail="Command timed out while listing definitions"
        )
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to parse definitions output: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to list definitions: {str(e)}"
        )
