"""API endpoints for managing Dagster primitives."""

import subprocess
import json
import time
import yaml
from pathlib import Path
from fastapi import APIRouter, HTTPException
from typing import Dict, Tuple, Any, List

from app.services.primitives_service import PrimitivesService, PrimitiveCategory
from app.core.config import settings

router = APIRouter(prefix="/primitives", tags=["primitives"])
primitives_service = PrimitivesService(str(settings.projects_dir))

# Simple in-memory cache for definitions to avoid re-running slow dg list defs
# Cache structure: {project_id: (timestamp, definitions_data)}
_definitions_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
CACHE_TTL_SECONDS = 10  # Cache results for 10 seconds


def _parse_automations_from_yaml(project_path: Path) -> Dict[str, List[Dict[str, Any]]]:
    """
    Parse jobs, schedules, sensors, and asset checks directly from YAML files
    in the defs/ directory.

    This provides a fallback when dg list defs is stale or unavailable — the
    user's newly-created primitives show up immediately after save (which
    writes defs/<name>/defs.yaml).

    Args:
        project_path: Path to the project directory

    Returns:
        Dictionary with 'jobs', 'schedules', 'sensors', 'asset_checks' lists
    """
    import sys
    jobs = []
    schedules = []
    sensors = []
    asset_checks = []

    # Find the defs directory
    defs_dir = None
    for subdir in project_path.glob("src/*/defs"):
        if subdir.is_dir():
            defs_dir = subdir
            break

    if not defs_dir or not defs_dir.exists():
        print(f"[YAML Fallback] No defs directory found in {project_path}", file=sys.stderr, flush=True)
        return {"jobs": [], "schedules": [], "sensors": [], "asset_checks": []}

    print(f"[YAML Fallback] Parsing automations from {defs_dir}", file=sys.stderr, flush=True)

    # Iterate through all subdirectories in defs/
    for item in defs_dir.iterdir():
        if not item.is_dir() or item.name.startswith('.') or item.name == '__pycache__':
            continue

        yaml_file = item / "defs.yaml"
        if not yaml_file.exists():
            continue

        try:
            with open(yaml_file, 'r') as f:
                config = yaml.safe_load(f)

            if not config or 'type' not in config:
                continue

            component_type = config['type']
            attributes = config.get('attributes', {})

            # Determine if it's a job, schedule, or sensor based on type
            if 'JobComponent' in component_type:
                job_data = {
                    "name": attributes.get('job_name', item.name),
                    "description": attributes.get('description'),
                    "tags": attributes.get('tags', {}),
                    "config": attributes.get('config'),
                    "asset_selection": attributes.get('asset_selection', []),
                    "source": str(yaml_file),
                    "_from_yaml": True  # Mark as parsed from YAML
                }
                jobs.append(job_data)
                print(f"[YAML Fallback] Found job: {job_data['name']}", file=sys.stderr, flush=True)

            elif 'ScheduleComponent' in component_type:
                schedule_data = {
                    "name": attributes.get('schedule_name', item.name),
                    "cron_schedule": attributes.get('cron_expression'),
                    "job_name": attributes.get('job_name'),
                    "timezone": attributes.get('timezone', 'UTC'),
                    "default_status": attributes.get('default_status', 'STOPPED'),
                    "description": attributes.get('description'),
                    "source": str(yaml_file),
                    "_from_yaml": True
                }
                schedules.append(schedule_data)
                print(f"[YAML Fallback] Found schedule: {schedule_data['name']}", file=sys.stderr, flush=True)

            elif 'SensorComponent' in component_type:
                sensor_data = {
                    "name": attributes.get('sensor_name', item.name),
                    "job_name": attributes.get('job_name'),
                    "minimum_interval_seconds": attributes.get('minimum_interval_seconds', 30),
                    "description": attributes.get('description'),
                    "default_status": attributes.get('default_status', 'STOPPED'),
                    "source": str(yaml_file),
                    "_from_yaml": True
                }
                sensors.append(sensor_data)
                print(f"[YAML Fallback] Found sensor: {sensor_data['name']}", file=sys.stderr, flush=True)

            elif 'AssetCheckComponent' in component_type:
                check_data = {
                    "name": attributes.get('check_name', item.name),
                    "asset_key": attributes.get('asset_name') or attributes.get('asset_key'),
                    "check_type": attributes.get('check_type'),
                    "description": attributes.get('description'),
                    "source": str(yaml_file),
                    "_from_yaml": True,
                }
                asset_checks.append(check_data)
                print(f"[YAML Fallback] Found asset_check: {check_data['name']}", file=sys.stderr, flush=True)

        except Exception as e:
            print(f"[YAML Fallback] Error parsing {yaml_file}: {e}", file=sys.stderr, flush=True)
            continue

    print(f"[YAML Fallback] Parsed {len(jobs)} jobs, {len(schedules)} schedules, "
          f"{len(sensors)} sensors, {len(asset_checks)} asset_checks",
          file=sys.stderr, flush=True)
    return {"jobs": jobs, "schedules": schedules, "sensors": sensors, "asset_checks": asset_checks}


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
        # First, try to use the shared asset introspection cache
        # This cache is populated when the Assets UI loads and includes dbt tests as asset checks
        from ..services.asset_introspection_service import _assets_cache
        from ..services.project_service import project_service
        import sys

        # Dagster+ (cloud) short-circuit: mirror the list-all endpoint.
        _cloud_project = project_service.get_project(project_id)
        if _cloud_project and getattr(_cloud_project, "is_dagster_plus", False):
            dp = _cloud_project.discovered_primitives or {}
            if category == "asset_check":
                items: list[dict] = []
                for node in (_cloud_project.graph.nodes if _cloud_project.graph else []):
                    if node.node_kind != "asset":
                        continue
                    for check in (node.data.get("checks") or []):
                        items.append({
                            "name": check.get("name", ""),
                            "key": check.get("key", ""),
                            "description": check.get("description", ""),
                            "asset_key": node.data.get("asset_key", ""),
                            "file": check.get("source", ""),
                        })
            else:
                cat_map = {"schedule": "schedules", "sensor": "sensors", "job": "jobs"}
                items = list(dp.get(cat_map.get(category, ""), []))
            return {
                "project_id": project_id,
                "category": category,
                "primitives": items,
                "total": len(items),
            }

        current_time = time.time()
        if project_id in _assets_cache:
            cache_time, cached_defs = _assets_cache[project_id]
            age = current_time - cache_time
            if age < 60:  # 60 second cache from asset introspection
                print(f"[Primitives/{category}] Using shared asset cache for project {project_id} (age: {age:.1f}s)", file=sys.stderr, flush=True)

                # Map category to cache key
                cache_key_map = {
                    "schedule": "schedules",
                    "job": "jobs",
                    "sensor": "sensors",
                    "asset_check": "asset_checks",
                }
                cache_key = cache_key_map.get(category)

                if cache_key and cache_key in cached_defs:
                    primitives = cached_defs[cache_key]
                    return {
                        "project_id": project_id,
                        "category": category,
                        "primitives": primitives,
                        "total": len(primitives),
                    }

        # Second fallback: Read from stored project data (instant, no dg list defs)
        print(f"[Primitives/{category}] Cache miss, reading from stored project for {project_id}", file=sys.stderr, flush=True)

        project = project_service.get_project(project_id)

        if category == "asset_check":
            # Extract asset checks from stored graph
            if project and project.graph and project.graph.nodes:
                asset_checks = []
                for node in project.graph.nodes:
                    if node.node_kind == "asset":
                        checks = node.data.get("checks", [])
                        for check in checks:
                            check_data = {
                                "name": check.get("name", ""),
                                "key": check.get("key", ""),
                                "description": check.get("description", ""),
                                "asset_key": node.data.get("asset_key", ""),
                                "file": check.get("source", ""),
                            }
                            asset_checks.append(check_data)

                if asset_checks:
                    print(f"[Primitives/asset_check] Found {len(asset_checks)} checks in stored graph", file=sys.stderr, flush=True)
                    return {
                        "project_id": project_id,
                        "category": category,
                        "primitives": asset_checks,
                        "total": len(asset_checks),
                        "source": "stored_graph"
                    }
        elif category in ["schedule", "sensor", "job"]:
            # Extract schedules/sensors/jobs from discovered_primitives
            if project and project.discovered_primitives:
                category_map = {
                    "schedule": "schedules",
                    "sensor": "sensors",
                    "job": "jobs",
                }
                primitives_key = category_map[category]
                primitives = project.discovered_primitives.get(primitives_key, [])

                if primitives:
                    print(f"[Primitives/{category}] Found {len(primitives)} {category}s in stored project", file=sys.stderr, flush=True)
                    return {
                        "project_id": project_id,
                        "category": category,
                        "primitives": primitives,
                        "total": len(primitives),
                        "source": "stored_primitives"
                    }

        # Final fallback: YAML file discovery (for template-created primitives)
        print(f"[Primitives/{category}] Using YAML fallback for project {project_id}", file=sys.stderr, flush=True)
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
        # First, try to use the shared asset introspection cache
        # This cache is populated when the Assets UI loads and includes dbt tests as asset checks
        from ..services.asset_introspection_service import _assets_cache
        from ..services.project_service import project_service
        import sys

        # Dagster+ (cloud) short-circuit: never touch the local FS or
        # dg CLI. Everything is populated by _hydrate_cloud_graph via
        # GraphQL and stored on project.discovered_primitives + graph.
        _cloud_project = project_service.get_project(project_id)
        if _cloud_project and getattr(_cloud_project, "is_dagster_plus", False):
            dp = _cloud_project.discovered_primitives or {}
            asset_checks: list[dict] = []
            for node in (_cloud_project.graph.nodes if _cloud_project.graph else []):
                if node.node_kind != "asset":
                    continue
                for check in (node.data.get("checks") or []):
                    asset_checks.append({
                        "name": check.get("name", ""),
                        "key": check.get("key", ""),
                        "description": check.get("description", ""),
                        "asset_key": node.data.get("asset_key", ""),
                        "file": check.get("source", ""),
                    })
            return {
                "project_id": project_id,
                "primitives": {
                    "schedules": list(dp.get("schedules", [])),
                    "sensors": list(dp.get("sensors", [])),
                    "jobs": list(dp.get("jobs", [])),
                    "asset_checks": asset_checks,
                    "freshness_policies": [],
                },
                "source": "dagster_plus",
            }

        current_time = time.time()
        if project_id in _assets_cache:
            cache_time, cached_defs = _assets_cache[project_id]
            age = current_time - cache_time
            if age < 60:  # 60 second cache from asset introspection
                print(f"[Primitives/all] Using shared asset cache for project {project_id} (age: {age:.1f}s)", file=sys.stderr, flush=True)

                primitives = {
                    "schedules": list(cached_defs.get("schedules", [])),
                    "jobs": list(cached_defs.get("jobs", [])),
                    "sensors": list(cached_defs.get("sensors", [])),
                    "asset_checks": list(cached_defs.get("asset_checks", [])),
                    "freshness_policies": list(cached_defs.get("freshness_policies", [])),
                }

                # Merge freshly-parsed YAML so post-save primitives always show
                # up, even during the 60s asset-cache window.
                try:
                    project = project_service.get_project(project_id)
                    if project:
                        project_dir = project_service._get_project_dir(project)
                        yaml_parsed = _parse_automations_from_yaml(project_dir)
                        for category in ("schedules", "jobs", "sensors", "asset_checks"):
                            existing_names = {p.get("name") for p in primitives[category] if p.get("name")}
                            for p in yaml_parsed.get(category, []):
                                if p.get("name") and p["name"] not in existing_names:
                                    primitives[category].append(p)
                except Exception as e:
                    print(f"[Primitives/all] Fresh YAML merge failed: {e}", file=sys.stderr, flush=True)

                return {
                    "project_id": project_id,
                    "primitives": primitives,
                }

        # Second fallback: Read from stored project data (instant)
        # This includes schedules/sensors/jobs from discovered_primitives and asset checks from graph
        print(f"[Primitives/all] Cache miss, reading from stored project for {project_id}", file=sys.stderr, flush=True)

        project = project_service.get_project(project_id)

        # Start with discovered primitives (from dg list defs — may be stale).
        primitives = {
            "schedules": project.discovered_primitives.get("schedules", []) if project and project.discovered_primitives else [],
            "sensors": project.discovered_primitives.get("sensors", []) if project and project.discovered_primitives else [],
            "jobs": project.discovered_primitives.get("jobs", []) if project and project.discovered_primitives else [],
            "asset_checks": [],
            "freshness_policies": primitives_service.list_primitives(project_id, "freshness_policy"),
        }

        # Merge in freshly-parsed YAML so newly-saved schedules/jobs/sensors/checks
        # show up immediately (before dg list defs re-runs and refreshes the
        # discovered_primitives snapshot).
        if project:
            project_dir = project_service._get_project_dir(project)
            yaml_parsed = _parse_automations_from_yaml(project_dir)
            for category in ("schedules", "jobs", "sensors", "asset_checks"):
                existing_names = {p.get("name") for p in primitives.get(category, []) if p.get("name")}
                for p in yaml_parsed.get(category, []):
                    if p.get("name") and p["name"] not in existing_names:
                        primitives.setdefault(category, []).append(p)

        # Add asset checks from stored graph
        if project and project.graph and project.graph.nodes:
            asset_checks = []
            for node in project.graph.nodes:
                if node.node_kind == "asset":
                    checks = node.data.get("checks", [])
                    for check in checks:
                        check_data = {
                            "name": check.get("name", ""),
                            "key": check.get("key", ""),
                            "description": check.get("description", ""),
                            "asset_key": node.data.get("asset_key", ""),
                            "file": check.get("source", ""),
                        }
                        asset_checks.append(check_data)

            primitives["asset_checks"] = asset_checks

        print(f"[Primitives/all] Found {len(primitives['schedules'])} schedules, "
              f"{len(primitives['sensors'])} sensors, {len(primitives['jobs'])} jobs, "
              f"{len(primitives['asset_checks'])} asset checks, "
              f"{len(primitives['freshness_policies'])} freshness policies from stored project", file=sys.stderr, flush=True)

        return {
            "project_id": project_id,
            "primitives": primitives,
            "source": "stored_graph"
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


@router.post("/attach-asset/{project_id}/{category}/{name}")
async def attach_asset_to_primitive(project_id: str, category: PrimitiveCategory, name: str, request: dict):
    """Append an asset to an existing schedule or job's asset_selection.

    Body: { "asset_key": str }

    Only meaningful for categories that target multiple assets:
    - schedule (via its scheduleType='assets' branch, or directly)
    - job (asset_selection)
    """
    asset_key = (request or {}).get("asset_key")
    if not asset_key:
        raise HTTPException(status_code=400, detail="asset_key is required")

    if category not in ("schedule", "job"):
        raise HTTPException(
            status_code=400,
            detail=f"attach-asset only supported for schedule and job; got '{category}'",
        )

    from app.services.project_service import project_service
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project_service._get_project_dir(project)

    # Find the primitive's defs.yaml by scanning defs/ folders.
    found_path: Path | None = None
    found_data: dict | None = None
    for defs_yaml in project_dir.rglob("defs.yaml"):
        try:
            with open(defs_yaml, 'r') as f:
                data = yaml.safe_load(f) or {}
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        attrs = data.get("attributes", {}) or {}
        comp_type = str(data.get("type") or "")
        matches = False
        if category == "schedule" and "Schedule" in comp_type:
            if attrs.get("schedule_name") == name or defs_yaml.parent.name == name:
                matches = True
        elif category == "job" and "Job" in comp_type:
            if attrs.get("job_name") == name or defs_yaml.parent.name == name:
                matches = True
        if matches:
            found_path = defs_yaml
            found_data = data
            break

    if not found_path or not found_data:
        raise HTTPException(status_code=404, detail=f"{category} '{name}' not found")

    attrs = found_data.get("attributes") or {}
    existing = attrs.get("asset_selection") or []
    if isinstance(existing, str):
        existing = [s.strip() for s in existing.split(",") if s.strip()]
    if asset_key in existing:
        return {"message": f"Asset already in {category}", "updated": False}
    existing.append(asset_key)
    attrs["asset_selection"] = existing
    found_data["attributes"] = attrs

    with open(found_path, 'w') as f:
        yaml.dump(found_data, f, default_flow_style=False, sort_keys=False)

    return {"message": f"Added to {category} '{name}'", "updated": True, "asset_selection": existing}


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
            # First, check if this is a community component check defined in defs.yaml
            # Search for "name: {check_name}" in defs.yaml files
            find_result = subprocess.run(
                ["find", ".", "-name", "defs.yaml", "-type", "f", "-not", "-path", "*/.venv/*"],
                cwd=str(project_path),
                capture_output=True,
                text=True,
                timeout=10,
            )

            if find_result.returncode == 0 and find_result.stdout:
                yaml_files = find_result.stdout.strip().split('\n')

                for yaml_file in yaml_files:
                    if not yaml_file:
                        continue

                    # Search for "name: {check_name}" in the YAML file
                    grep_result = subprocess.run(
                        ["grep", "-n", "--", f"name: {name}", yaml_file],
                        cwd=str(project_path),
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )

                    if grep_result.returncode == 0:
                        # Found the check in this file
                        line_match = grep_result.stdout.strip().split(':')
                        if len(line_match) >= 1:
                            line_number = int(line_match[0])
                            yaml_path = yaml_file.lstrip('./')
                            return {
                                "found": True,
                                "file_path": yaml_path,
                                "line_number": line_number,
                                "primitive_type": primitive_type,
                                "name": name,
                            }

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


def _build_asset_check_index(project_path: Path) -> Dict[str, Tuple[str, int]]:
    """
    Build an index of asset check names to their file locations.
    This is much faster than running find/grep for each check individually.

    Returns:
        Dict mapping check names to (file_path, line_number) tuples
    """
    import sys
    check_index = {}

    try:
        # Find all defs.yaml files (for community components)
        find_result = subprocess.run(
            ["find", ".", "-name", "defs.yaml", "-type", "f", "-not", "-path", "*/.venv/*"],
            cwd=str(project_path),
            capture_output=True,
            text=True,
            timeout=10,
        )

        if find_result.returncode == 0 and find_result.stdout:
            yaml_files = [f for f in find_result.stdout.strip().split('\n') if f]

            # Read each yaml file and index check names
            for yaml_file in yaml_files:
                try:
                    full_path = project_path / yaml_file.lstrip('./')
                    with open(full_path, 'r') as f:
                        for line_num, line in enumerate(f, 1):
                            # Look for "name: check_name" pattern
                            if 'name:' in line:
                                parts = line.split('name:', 1)
                                if len(parts) == 2:
                                    check_name = parts[1].strip().strip('"').strip("'")
                                    if check_name and check_name not in check_index:
                                        check_index[check_name] = (yaml_file.lstrip('./'), line_num)
                except Exception as e:
                    continue

        # Find all schema.yml files (for dbt tests)
        find_result = subprocess.run(
            ["find", ".", "-name", "*.yml", "-type", "f", "-not", "-path", "*/.venv/*", "-not", "-path", "*/dbt_packages/*"],
            cwd=str(project_path),
            capture_output=True,
            text=True,
            timeout=10,
        )

        if find_result.returncode == 0 and find_result.stdout:
            yml_files = [f for f in find_result.stdout.strip().split('\n') if f]

            # For yml files, we need to extract model names and potential test patterns
            # This is a heuristic - we index model names that could match test name patterns
            for yml_file in yml_files:
                try:
                    full_path = project_path / yml_file.lstrip('./')
                    with open(full_path, 'r') as f:
                        content = f.read()
                        # Use yaml to parse and find model names
                        import yaml
                        data = yaml.safe_load(content)
                        if data and isinstance(data, dict):
                            models = data.get('models', [])
                            for model in models:
                                if isinstance(model, dict) and 'name' in model:
                                    model_name = model['name']
                                    # Store yml file for this model - tests will reference it
                                    # We'll use this as a fallback when exact check name isn't found
                                    check_index[f"_model_{model_name}"] = (yml_file.lstrip('./'), 1)
                except Exception as e:
                    continue

        print(f"[Check Index] Built index with {len(check_index)} entries", file=sys.stderr, flush=True)
        return check_index

    except Exception as e:
        print(f"[Check Index] Error building index: {e}", file=sys.stderr, flush=True)
        return {}


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


@router.delete("/definitions/cache/{project_id}")
async def clear_definitions_cache(project_id: str):
    """
    Clear all backend caches for a specific project so the next fetch is fresh.

    Historically only cleared _definitions_cache (10s TTL). The 60s asset_cache
    (populated by asset introspection) was leaking stale data after saves — a
    newly-created schedule wouldn't appear on the Automation page or in the
    per-asset "Add to existing" dropdown until the cache expired. This now
    wipes both so post-save refetches immediately reflect on-disk state.
    """
    cleared: list[str] = []
    if project_id in _definitions_cache:
        del _definitions_cache[project_id]
        cleared.append("definitions")
    try:
        from ..services.asset_introspection_service import _assets_cache
        if project_id in _assets_cache:
            del _assets_cache[project_id]
            cleared.append("assets")
    except Exception:
        pass
    if not cleared:
        return {"message": f"No cache found for project {project_id}"}
    return {"message": f"Cleared caches ({', '.join(cleared)}) for {project_id}"}


@router.get("/definitions/{project_id}")
async def list_all_definitions(project_id: str):
    """
    List all definitions (jobs, schedules, sensors) from the project using dg list defs.

    This endpoint discovers ALL primitives in the project, not just those created
    through the template system.

    Results are cached and shared with asset introspection for optimal performance.
    Uses a lock to prevent multiple simultaneous dg list defs calls.

    Args:
        project_id: Project ID

    Returns:
        All definitions discovered in the project
    """
    try:
        # First, try to use the shared asset introspection service
        # This service uses locking to prevent multiple simultaneous dg list defs calls
        from ..services.asset_introspection_service import asset_introspection_service, _assets_cache
        from ..services.project_service import project_service
        import sys

        # Dagster+ (cloud) short-circuit: no local codebase to introspect
        # with `dg list defs`. Return primitives already hydrated from
        # GraphQL by _hydrate_cloud_graph.
        _cloud_project = project_service.get_project(project_id)
        if _cloud_project and getattr(_cloud_project, "is_dagster_plus", False):
            dp = _cloud_project.discovered_primitives or {}
            asset_checks: list[dict] = []
            for node in (_cloud_project.graph.nodes if _cloud_project.graph else []):
                if node.node_kind != "asset":
                    continue
                for check in (node.data.get("checks") or []):
                    asset_checks.append({
                        "name": check.get("name", ""),
                        "key": check.get("key", ""),
                        "description": check.get("description", ""),
                        "asset_key": node.data.get("asset_key", ""),
                        "file": check.get("source", ""),
                    })
            return {
                "project_id": project_id,
                "jobs": list(dp.get("jobs", [])),
                "schedules": list(dp.get("schedules", [])),
                "sensors": list(dp.get("sensors", [])),
                "asset_checks": asset_checks,
            }

        current_time = time.time()

        # Check if cache exists and is fresh
        if project_id in _assets_cache:
            cache_time, cached_defs = _assets_cache[project_id]
            age = current_time - cache_time
            if age < 60:  # 60 second cache from asset introspection
                print(f"[Definitions] Using shared asset cache for project {project_id} (age: {age:.1f}s)", file=sys.stderr, flush=True)

                # Extract definitions from cached data
                result_data = {
                    "project_id": project_id,
                    "jobs": cached_defs.get("jobs", []),
                    "schedules": cached_defs.get("schedules", []),
                    "sensors": cached_defs.get("sensors", []),
                    "asset_checks": cached_defs.get("asset_checks", []),
                }

                # Also cache in local definitions cache for consistency
                _definitions_cache[project_id] = (cache_time, result_data)
                return result_data

        # Check local cache if not in shared cache
        if project_id in _definitions_cache:
            cache_time, cached_data = _definitions_cache[project_id]
            age = current_time - cache_time
            if age < CACHE_TTL_SECONDS:
                print(f"[Definitions] Returning cached data for project {project_id} (age: {age:.1f}s)", file=sys.stderr, flush=True)
                return cached_data

        # No cache found - need to run dg list defs
        # Use the asset introspection service which has locking to prevent simultaneous calls
        print(f"[Definitions] Cache miss for project {project_id}, using asset introspection service with locking", file=sys.stderr, flush=True)

        # Get project to pass to asset introspection service
        from ..services.project_service import project_service
        project = project_service.get_project(project_id)

        if not project:
            raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

        # Get project path
        project_path = settings.projects_dir / project.directory_name if project.directory_name else settings.projects_dir / project_id

        if not project_path.exists():
            raise HTTPException(status_code=404, detail=f"Project directory not found")

        # Check for venv
        venv_dg = project_path / ".venv" / "bin" / "dg"
        if not venv_dg.exists():
            # FALLBACK: Parse YAML files directly
            print(f"[Definitions] No venv found, using YAML fallback", file=sys.stderr, flush=True)
            yaml_data = _parse_automations_from_yaml(project_path)

            result_data = {
                "project_id": project_id,
                "jobs": yaml_data.get("jobs", []),
                "schedules": yaml_data.get("schedules", []),
                "sensors": yaml_data.get("sensors", []),
                "asset_checks": [],
                "validation_error": "Project virtual environment not found",
                "using_fallback": True
            }

            # Cache the fallback results
            _definitions_cache[project_id] = (time.time(), result_data)
            return result_data

        # Use the asset introspection service's async method with locking
        try:
            print(f"[Definitions] Calling asset_introspection_service._run_dg_list_defs_async for project {project_id}...", file=sys.stderr, flush=True)
            defs = await asset_introspection_service._run_dg_list_defs_async(project, project_path)
            print(f"[Definitions] Successfully got definitions from asset introspection service", file=sys.stderr, flush=True)
        except Exception as e:
            # FALLBACK: Parse YAML files directly to show what user created
            print(f"[Definitions] dg list defs failed, using YAML fallback: {e}", file=sys.stderr, flush=True)
            yaml_data = _parse_automations_from_yaml(project_path)

            result_data = {
                "project_id": project_id,
                "jobs": yaml_data.get("jobs", []),
                "schedules": yaml_data.get("schedules", []),
                "sensors": yaml_data.get("sensors", []),
                "asset_checks": [],
                "validation_error": str(e),
                "using_fallback": True
            }

            # Cache the fallback results too
            _definitions_cache[project_id] = (time.time(), result_data)
            return result_data

        # Resolve sources to actual file locations for checks that point to defs.yaml
        # This includes both dbt tests and community component checks
        # OPTIMIZED: Build index once, then lookup each check (much faster than individual find/grep)
        asset_checks = defs.get("asset_checks", [])

        # Build the check index once for all checks
        checks_to_resolve = [c for c in asset_checks if c.get("source", "") and "defs.yaml" in c.get("source", "")]

        if checks_to_resolve:
            print(f"[Definitions] Building check index for {len(checks_to_resolve)} checks...", file=sys.stderr, flush=True)
            start_time = time.time()

            check_index = _build_asset_check_index(project_path)

            elapsed = time.time() - start_time
            print(f"[Definitions] Check index built in {elapsed:.2f}s, resolving sources...", file=sys.stderr, flush=True)

            # Now resolve each check using the index (fast lookup)
            resolved_count = 0
            for check in checks_to_resolve:
                check_name = check["name"]

                # Direct lookup in index
                if check_name in check_index:
                    file_path, line_number = check_index[check_name]
                    check["source"] = f"{file_path}:{line_number}"
                    resolved_count += 1
                else:
                    # Try to find model name from test name pattern (for dbt tests)
                    # e.g., "not_null_customer_metrics_total_orders" -> look for model "customer_metrics"
                    test_prefixes = [
                        'not_null_', 'unique_', 'accepted_values_', 'relationships_',
                        'dbt_utils_accepted_range_', 'dbt_utils_expression_is_true_',
                        'dbt_utils_recency_', 'dbt_utils_'
                    ]

                    name_without_prefix = check_name
                    for prefix in test_prefixes:
                        if check_name.startswith(prefix):
                            name_without_prefix = check_name[len(prefix):]
                            break

                    # Try to extract model name (first 1-3 words)
                    parts = name_without_prefix.split('_')
                    for num_parts in [2, 3, 1]:
                        if len(parts) >= num_parts:
                            potential_model = '_'.join(parts[:num_parts])
                            model_key = f"_model_{potential_model}"

                            if model_key in check_index:
                                file_path, _ = check_index[model_key]
                                check["source"] = f"{file_path}:1"
                                resolved_count += 1
                                break

            elapsed_total = time.time() - start_time
            print(f"[Definitions] Resolved {resolved_count}/{len(checks_to_resolve)} check sources in {elapsed_total:.2f}s total", file=sys.stderr, flush=True)

        result_data = {
            "project_id": project_id,
            "jobs": defs.get("jobs", []),
            "schedules": defs.get("schedules", []),
            "sensors": defs.get("sensors", []),
            "asset_checks": asset_checks,
        }

        # Cache the results
        _definitions_cache[project_id] = (time.time(), result_data)
        print(f"[Definitions] Cached results for project {project_id}", file=sys.stderr, flush=True)

        return result_data

    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        # FALLBACK: For any other error, try YAML parsing
        print(f"[Definitions] Unexpected error: {e}, attempting YAML fallback...", file=sys.stderr, flush=True)
        try:
            # Get project path for fallback
            from ..services.project_service import project_service
            project = project_service.get_project(project_id)
            if project:
                project_path = settings.projects_dir / project.directory_name if project.directory_name else settings.projects_dir / project_id
                if project_path.exists():
                    yaml_data = _parse_automations_from_yaml(project_path)
                    return {
                        "project_id": project_id,
                        "jobs": yaml_data.get("jobs", []),
                        "schedules": yaml_data.get("schedules", []),
                        "sensors": yaml_data.get("sensors", []),
                        "asset_checks": [],
                        "validation_error": f"Error listing definitions: {str(e)}",
                        "using_fallback": True
                    }
        except Exception as fallback_error:
            print(f"[Definitions] Fallback also failed: {fallback_error}", file=sys.stderr, flush=True)

        raise HTTPException(
            status_code=500,
            detail=f"Failed to list definitions: {str(e)}"
        )
