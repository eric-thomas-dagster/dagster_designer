"""API endpoints for community component templates."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import httpx
import yaml
import json
import subprocess
import os
from pathlib import Path
from typing import Any, List, Optional

from ..services.project_service import project_service

router = APIRouter(prefix="/templates", tags=["templates"])

MANIFEST_URL = "https://raw.githubusercontent.com/eric-thomas-dagster/dagster-component-templates/main/manifest.json"


def detect_project_structure(project_dir: Path, project_name_sanitized: str):
    """
    Detect the actual project structure and return paths to key directories.

    Returns:
        tuple: (base_dir, actual_module_name, use_src_layout, defs_dir, components_dir)
    """
    use_src_layout = False
    base_dir = None
    actual_module_name = None

    # First, check for src/ layout (preferred for dg-scaffolded projects)
    src_root = project_dir / "src"
    if src_root.exists() and src_root.is_dir():
        # Find Python modules in src/ (directories with __init__.py and definitions.py)
        for item in src_root.iterdir():
            if item.is_dir() and not item.name.startswith('.') and not item.name.startswith('__'):
                init_file = item / "__init__.py"
                defs_file = item / "definitions.py"
                defs_dir = item / "defs"

                # This is a valid Dagster module if it has __init__.py and either definitions.py or defs/ directory
                if init_file.exists() and (defs_file.exists() or defs_dir.exists()):
                    base_dir = item
                    actual_module_name = item.name
                    use_src_layout = True
                    break

    # If no src/ layout found, check for flat layout
    if not base_dir:
        # Try the sanitized project name first
        flat_dir = project_dir / project_name_sanitized
        if flat_dir.exists() and (flat_dir / "defs").exists():
            base_dir = flat_dir
            actual_module_name = project_name_sanitized
            use_src_layout = False
        else:
            # Scan project root for any directory with defs/ subdirectory
            for item in project_dir.iterdir():
                if item.is_dir() and not item.name.startswith('.') and item.name not in ['src', 'tests', '.venv', '__pycache__']:
                    defs_dir = item / "defs"
                    init_file = item / "__init__.py"
                    if defs_dir.exists() and init_file.exists():
                        base_dir = item
                        actual_module_name = item.name
                        use_src_layout = False
                        break

    # If still no base directory found, raise an error
    if not base_dir or not actual_module_name:
        raise ValueError(f"Could not detect project structure in {project_dir}")

    defs_dir = base_dir / "defs"
    components_dir = base_dir / "components"

    return base_dir, actual_module_name, use_src_layout, defs_dir, components_dir


class ComponentTemplate(BaseModel):
    """Community component template metadata."""
    id: str
    name: str
    category: str
    description: str
    version: str = "0.0.0"  # Manifest drifted — many entries no longer publish a version
    author: str = "community"
    path: str
    tags: List[str] = []
    dependencies: Any = {}  # Manifest drifted: sometimes dict, sometimes list
    readme_url: str
    component_url: str
    schema_url: Optional[str] = None  # Optional - not all components have schema.json
    example_url: str
    requirements_url: Optional[str] = None
    manifest_url: Optional[str] = None
    icon: Optional[str] = "Package"  # Lucide icon name for visual identification
    supports_partitions: Optional[bool] = False  # Whether the component supports partitioned assets
    validation: Optional[dict] = None  # New: validation rules from manifest
    agent_hints: Optional[dict] = None  # New: hints for LLM agents


class TemplateManifest(BaseModel):
    """Manifest of all available templates."""
    version: str
    repository: str
    last_updated: str
    components: List[ComponentTemplate]


class InstallComponentRequest(BaseModel):
    """Request model for installing a component."""
    project_id: str
    config: dict = {}
    # When provided, these get merged into the stub defs.yaml the CLI writes so
    # the caller (e.g. Dagster AI) can install + configure in one shot instead
    # of installing and then leaving the user to hand-edit placeholder values.
    attributes: Optional[dict] = None
    # Optional override for the defs.yaml directory name — useful when a single
    # component_id is being installed multiple times (each instance needs its
    # own defs/<name>/ directory).
    instance_name: Optional[str] = None
    # Explicit "template-only" flag from callers like the Add Data dialog and
    # the Library palette that want to install the component TEMPLATE without
    # dropping a demo instance on the graph. The existing no-attributes
    # heuristic covers this too, but the flag is unambiguous and future-proof
    # against callers that pass attributes={} for other reasons.
    template_only: bool = False


def validate_component_config(component_dir: Path, attributes: dict) -> tuple[dict, list[str]]:
    """Validate component configuration against its schema.

    Args:
        component_dir: Path to the component directory containing schema.json
        attributes: Dictionary of attribute values to validate

    Returns:
        Tuple of (cleaned_attributes, validation_errors)
    """
    schema_file = component_dir / "schema.json"
    validation_errors = []
    cleaned_attributes = {}

    # If no schema file exists, return attributes as-is
    if not schema_file.exists():
        return attributes, []

    try:
        with open(schema_file, 'r') as f:
            schema = json.load(f)
    except Exception as e:
        return attributes, [f"Failed to load schema: {str(e)}"]

    # Get properties and required fields from schema
    # Support both JSON Schema format ('properties') and custom format ('attributes')
    properties = schema.get('properties', schema.get('attributes', {}))
    required_fields = schema.get('required', [])

    print(f"[Validation] Found {len(properties)} properties in schema")
    print(f"[Validation] Validating {len(attributes)} attributes")

    # Check if attributes is empty when component has required fields
    if required_fields and not attributes:
        validation_errors.append(f"Component requires configuration for fields: {', '.join(required_fields)}")
        return cleaned_attributes, validation_errors

    # Validate each attribute
    for key, value in attributes.items():
        if key not in properties:
            # Unknown field - include it but warn
            print(f"[Validation] Unknown field '{key}' - including as-is")
            cleaned_attributes[key] = value
            continue

        prop = properties[key]
        prop_type = prop.get('type')
        print(f"[Validation] Validating field '{key}' of type '{prop_type}'")

        # Handle None values (but preserve empty strings as valid values)
        if value is None:
            # Check if field is required
            if key in required_fields:
                validation_errors.append(f"Required field '{key}' cannot be None")
                continue

            # For optional fields, check if there's a default
            if 'default' in prop:
                # Skip field to use default value
                continue

            # For optional fields without defaults, skip None values
            continue

        # Handle required fields that are empty strings
        if value == '' and key in required_fields:
            validation_errors.append(f"Required field '{key}' cannot be empty")
            continue

        # Type validation
        if prop_type == 'integer':
            if isinstance(value, str):
                try:
                    cleaned_attributes[key] = int(value)
                except ValueError:
                    validation_errors.append(f"Field '{key}' must be an integer, got: '{value}'")
                    continue
            elif isinstance(value, int):
                cleaned_attributes[key] = value
            else:
                validation_errors.append(f"Field '{key}' must be an integer, got type: {type(value).__name__}")
                continue

        elif prop_type == 'number':
            if isinstance(value, str):
                try:
                    cleaned_attributes[key] = float(value)
                except ValueError:
                    validation_errors.append(f"Field '{key}' must be a number, got: '{value}'")
                    continue
            elif isinstance(value, (int, float)):
                cleaned_attributes[key] = value
            else:
                validation_errors.append(f"Field '{key}' must be a number, got type: {type(value).__name__}")
                continue

        elif prop_type == 'boolean':
            if isinstance(value, str):
                if value.lower() in ('true', '1', 'yes'):
                    cleaned_attributes[key] = True
                elif value.lower() in ('false', '0', 'no'):
                    cleaned_attributes[key] = False
                else:
                    validation_errors.append(f"Field '{key}' must be a boolean, got: '{value}'")
                    continue
            elif isinstance(value, bool):
                cleaned_attributes[key] = value
            else:
                validation_errors.append(f"Field '{key}' must be a boolean, got type: {type(value).__name__}")
                continue

        elif prop_type == 'array':
            if not isinstance(value, list):
                validation_errors.append(f"Field '{key}' must be an array, got type: {type(value).__name__}")
                continue
            cleaned_attributes[key] = value

        elif prop_type == 'object':
            if not isinstance(value, dict):
                validation_errors.append(f"Field '{key}' must be an object, got type: {type(value).__name__}")
                continue
            cleaned_attributes[key] = value

        else:
            # String or other types - accept as-is
            cleaned_attributes[key] = value

    # Check for missing required fields
    for required_field in required_fields:
        if required_field not in cleaned_attributes:
            validation_errors.append(f"Required field '{required_field}' is missing")

    print(f"[Validation] Returning {len(cleaned_attributes)} cleaned attributes")
    if cleaned_attributes:
        print(f"[Validation] Cleaned attribute keys: {list(cleaned_attributes.keys())}")

    return cleaned_attributes, validation_errors


@router.get("/check-instance/{project_id}/{component_id}/{instance_name}")
async def check_instance_exists(
    project_id: str,
    component_id: str,
    instance_name: str
):
    """Check if a component instance with the given name already exists."""
    try:
        # Get project
        project = project_service.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        project_dir = project_service._get_project_dir(project)
        project_name_sanitized = project.name.replace(" ", "_").replace("-", "_")

        # Detect project structure
        try:
            base_dir, actual_module_name, use_src_layout, defs_dir, components_dir = detect_project_structure(
                project_dir, project_name_sanitized
            )
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

        # Check if instance directory exists
        instance_dir = defs_dir / instance_name
        exists = instance_dir.exists()

        return {
            "exists": exists,
            "instance_name": instance_name,
            "component_id": component_id
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to check instance: {str(e)}"
        )


@router.post("/configure/{component_id}")
async def configure_component(
    component_id: str,
    request: InstallComponentRequest
):
    """Configure an installed community component by updating its YAML file."""
    try:
        # Get project
        project = project_service.get_project(request.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        project_dir = project_service._get_project_dir(project)
        project_name_sanitized = project.name.replace(" ", "_").replace("-", "_")

        # Detect project structure
        try:
            base_dir, actual_module_name, use_src_layout, defs_dir, components_dir = detect_project_structure(
                project_dir, project_name_sanitized
            )
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

        component_dir = components_dir / component_id
        manifest_file = component_dir / "manifest.yaml"

        if not manifest_file.exists():
            raise HTTPException(status_code=404, detail="Component manifest not found")

        with open(manifest_file, 'r') as f:
            manifest_data = yaml.safe_load(f)

        component_type = manifest_data.get('component_type')
        if not component_type:
            raise HTTPException(status_code=500, detail="Component type not found in manifest")

        # Create/update YAML config file
        instance_name = request.config.get('name', component_id)

        # Extract attributes (excluding 'name')
        raw_attributes = {k: v for k, v in request.config.items() if k != 'name'}

        print(f"[Configure] Instance name: {instance_name}")
        print(f"[Configure] Raw attributes: {json.dumps(raw_attributes, indent=2)[:500]}")

        # Validate component configuration against schema
        validated_attributes, validation_errors = validate_component_config(
            component_dir, raw_attributes
        )

        print(f"[Configure] Validated attributes: {json.dumps(validated_attributes, indent=2)[:500]}")
        print(f"[Configure] Validation errors: {validation_errors}")

        if validation_errors:
            error_message = "Configuration validation failed:\n" + "\n".join(f"  - {err}" for err in validation_errors)
            print(f"[Configure] Validation errors: {error_message}")
            raise HTTPException(
                status_code=400,
                detail=error_message
            )

        # Create subdirectory for the component instance
        instance_dir = defs_dir / instance_name
        instance_dir.mkdir(parents=True, exist_ok=True)
        yaml_file = instance_dir / "defs.yaml"

        # Use correct YAML format: type + attributes
        yaml_config = {
            "type": component_type,
            "attributes": validated_attributes
        }

        with open(yaml_file, 'w') as f:
            yaml.dump(yaml_config, f, default_flow_style=False, sort_keys=False)

        print(f"[Configure] Updated component configuration: {yaml_file}")
        print(f"[Configure] Config: {yaml_config}")

        # Auto-regenerate assets so the new component appears immediately
        try:
            from ..services.asset_introspection_service import AssetIntrospectionService
            asset_introspection_service = AssetIntrospectionService()

            # Clear cache to ensure fresh introspection includes the new component
            asset_introspection_service.clear_cache(project.id)
            print(f"[Configure] Cleared asset cache for project {project.id}")

            print(f"[Configure] Auto-regenerating assets for project {project.id}...")
            asset_nodes, asset_edges = await asset_introspection_service.get_assets_for_project_async(project)

            # Update project graph with new assets
            project.graph.nodes = asset_nodes
            project.graph.edges = asset_edges

            # Save the updated project
            project_service._save_project(project)

            print(f"[Configure] Successfully regenerated {len(asset_nodes)} assets")
        except Exception as e:
            print(f"[Configure] Warning: Failed to auto-regenerate assets: {e}")
            # Don't fail the request if regeneration fails - user can manually regenerate
            import traceback
            traceback.print_exc()

        return {
            "success": True,
            "message": f"Component {instance_name} configured successfully",
            "yaml_file": str(yaml_file.relative_to(project_dir)),
            "assets_regenerated": True
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Error configuring component: {error_details}")
        raise HTTPException(
            status_code=500,
            detail=f"Error configuring component: {str(e)}"
        )


@router.get("/installed/{project_id}")
async def get_installed_components(project_id: str):
    """Get list of installed community components for a project."""
    try:
        # Get project
        project = project_service.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        project_dir = project_service._get_project_dir(project)
        project_name_sanitized = project.name.replace(" ", "_").replace("-", "_")

        # Detect project structure
        try:
            base_dir, actual_module_name, use_src_layout, defs_dir, components_dir = detect_project_structure(
                project_dir, project_name_sanitized
            )
        except ValueError:
            # No valid project structure found, return empty list
            return {"components": []}

        # Check if components directory exists
        if not components_dir.exists():
            return {"components": []}

        # Scan for installed components
        installed_components = []
        for item in components_dir.iterdir():
            if item.is_dir() and not item.name.startswith('_') and not item.name.startswith('.'):
                # Check if it has a manifest.yaml
                manifest_file = item / "manifest.yaml"
                if manifest_file.exists():
                    try:
                        with open(manifest_file, 'r') as f:
                            manifest_data = yaml.safe_load(f)

                        # Get component type from the manifest
                        component_type = manifest_data.get('component_type', '')

                        installed_components.append({
                            "id": item.name,
                            "name": manifest_data.get('name', item.name.replace('_', ' ').title()),
                            "description": manifest_data.get('description', ''),
                            "component_type": component_type,
                            "category": manifest_data.get('category', 'community'),
                            "version": manifest_data.get('version', '1.0.0'),
                        })
                    except Exception as e:
                        print(f"Warning: Could not read manifest for {item.name}: {e}")

        return {"components": installed_components}

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Error fetching installed components: {error_details}")
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching installed components: {str(e)}"
        )


@router.get("/installed/{project_id}/{component_id}/schema")
async def get_installed_component_schema(project_id: str, component_id: str):
    """Get the schema for an installed community component."""
    try:
        # Get project
        project = project_service.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        project_dir = project_service._get_project_dir(project)
        project_name_sanitized = project.name.replace(" ", "_").replace("-", "_")

        # Detect project structure
        try:
            base_dir, actual_module_name, use_src_layout, defs_dir, components_dir = detect_project_structure(
                project_dir, project_name_sanitized
            )
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

        # Find the component
        component_dir = components_dir / component_id
        if not component_dir.exists():
            raise HTTPException(status_code=404, detail=f"Component {component_id} not found")

        # Read schema.json
        schema_file = component_dir / "schema.json"
        if not schema_file.exists():
            raise HTTPException(status_code=404, detail="Schema file not found")

        with open(schema_file, 'r') as f:
            schema = json.load(f)

        return schema

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Error fetching component schema: {error_details}")
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching component schema: {str(e)}"
        )


@router.get("/manifest")
async def get_manifest() -> TemplateManifest:
    """Fetch the component templates manifest from GitHub."""
    try:
        async with httpx.AsyncClient() as client:
            # Add cache-busting headers to ensure fresh content from GitHub
            headers = {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
            response = await client.get(MANIFEST_URL, headers=headers, timeout=10.0)
            response.raise_for_status()
            data = response.json()

            # Components that shouldn't be surfaced in the UI.
            # dependency_graph is an internal fallback we use to persist manual
            # graph edges — users should use each component's own upstream fields
            # (upstream_asset_keys, left_asset_key, etc.) instead.
            HIDDEN_IDS = {"dependency_graph"}

            # Validate components individually to gracefully handle invalid entries
            valid_components = []
            invalid_components = []

            for component_data in data.get('components', []):
                if component_data.get('id') in HIDDEN_IDS:
                    continue
                try:
                    # Validate individual component
                    component = ComponentTemplate(**component_data)
                    valid_components.append(component)
                except Exception as e:
                    # Log warning but don't fail entire manifest
                    component_id = component_data.get('id', 'unknown')
                    print(f"[WARNING] Invalid component '{component_id}' in manifest: {str(e)}")
                    invalid_components.append({
                        'id': component_id,
                        'error': str(e)
                    })

            # Log summary if any components were invalid
            if invalid_components:
                print(f"[WARNING] Filtered out {len(invalid_components)} invalid components from manifest:")
                for invalid in invalid_components:
                    print(f"  - {invalid['id']}: {invalid['error']}")

            # Return manifest with only valid components
            return TemplateManifest(
                version=data.get('version', '1.0.0'),
                repository=data.get('repository', ''),
                last_updated=data.get('last_updated', ''),
                components=valid_components
            )
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch manifest: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error processing manifest: {str(e)}"
        )


@router.get("/component/{component_id}")
async def get_component_details(component_id: str):
    """Get detailed information about a specific component."""
    try:
        # Fetch manifest
        manifest = await get_manifest()

        # Find component
        component = next(
            (c for c in manifest.components if c.id == component_id),
            None
        )

        if not component:
            raise HTTPException(status_code=404, detail="Component not found")

        # Fetch additional files
        async with httpx.AsyncClient() as client:
            readme_response = await client.get(component.readme_url, timeout=10.0)
            schema_response = await client.get(component.schema_url, timeout=10.0)
            example_response = await client.get(component.example_url, timeout=10.0)

            return {
                "component": component.dict(),
                "readme": readme_response.text,
                "schema": schema_response.json(),
                "example": example_response.text,
            }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching component: {str(e)}"
        )


@router.post("/install/{component_id}")
async def install_component(
    component_id: str,
    request: InstallComponentRequest
):
    """
    Install a component template into a project following Dagster's component pattern.

    Steps:
    1. Download component files (component.py, requirements.txt, manifest)
    2. Create component in project's components/ directory
    3. Install requirements.txt dependencies
    4. Use dg scaffold defs to register component instance
    """
    try:
        print(f"[Install] Starting installation of component: {component_id}")
        print(f"[Install] Request config: {request.dict()}")

        # Fetch component metadata
        manifest = await get_manifest()
        print(f"[Install] Manifest fetched with {len(manifest.components)} components")
        component = next(
            (c for c in manifest.components if c.id == component_id),
            None
        )

        if not component:
            raise HTTPException(status_code=404, detail="Component not found")

        # Get project
        project = project_service.get_project(request.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        project_dir = project_service._get_project_dir(project)
        # Ensure absolute path
        if not project_dir.is_absolute():
            project_dir = project_dir.resolve()
        project_name_sanitized = project.name.replace(" ", "_").replace("-", "_")

        print(f"[Install] Project directory: {project_dir}")
        print(f"[Install] Project name sanitized: {project_name_sanitized}")

        # Download component files
        async with httpx.AsyncClient() as client:
            # Download component.py
            component_code_response = await client.get(component.component_url, timeout=10.0)
            component_code = component_code_response.text

            # Download requirements.txt if available
            requirements_txt = None
            if component.requirements_url:
                try:
                    requirements_response = await client.get(component.requirements_url, timeout=10.0)
                    requirements_response.raise_for_status()
                    requirements_txt = requirements_response.text
                except Exception as e:
                    print(f"Warning: Could not download requirements.txt: {e}")

            # Download component manifest if available
            component_manifest = None
            if component.manifest_url:
                try:
                    manifest_response = await client.get(component.manifest_url, timeout=10.0)
                    manifest_response.raise_for_status()
                    component_manifest = manifest_response.text
                except Exception as e:
                    print(f"Warning: Could not download manifest: {e}")

            # Download schema.json if available
            component_schema = None
            if component.schema_url:
                try:
                    schema_response = await client.get(component.schema_url, timeout=10.0)
                    schema_response.raise_for_status()
                    component_schema = schema_response.text
                except Exception as e:
                    print(f"Warning: Could not download schema.json: {e}")

        # Parse component code to find the component class name
        # Look for class that inherits from dg.Component (not just any class, which could be enums, helpers, etc.)
        import re
        class_match = re.search(r'class\s+(\w+)\s*\([^)]*dg\.Component', component_code)
        if not class_match:
            # Fallback: try to find any class with "Component" in the name
            class_match = re.search(r'class\s+(\w+Component[s]?)\s*\(', component_code)
        if not class_match:
            raise HTTPException(
                status_code=500,
                detail="Could not find component class definition in component code"
            )
        class_name = class_match.group(1)

        # 1. Detect actual project layout by discovering the real module directory
        try:
            base_dir, actual_module_name, use_src_layout, _, _ = detect_project_structure(
                project_dir, project_name_sanitized
            )
            print(f"[Install] Detected project structure:")
            print(f"[Install]   - Module name: {actual_module_name}")
            print(f"[Install]   - Base directory: {base_dir}")
            print(f"[Install]   - Uses src/ layout: {use_src_layout}")
        except ValueError:
            # No existing structure found, create a new one (fallback for brand new projects)
            base_dir = project_dir / project_name_sanitized
            actual_module_name = project_name_sanitized
            base_dir.mkdir(parents=True, exist_ok=True)
            use_src_layout = False
            print(f"[Install] Created new flat layout: {base_dir}")

        components_dir = base_dir / "components"
        components_dir.mkdir(parents=True, exist_ok=True)

        component_dir = components_dir / component_id
        component_dir.mkdir(exist_ok=True)

        print(f"[Install] Component directory: {component_dir}")

        # 2. Save component files
        component_file_path = component_dir / f"{component_id}.py"
        component_file_path.write_text(component_code)

        # Save __init__.py to export the component
        init_file = component_dir / "__init__.py"
        init_file.write_text(f"from .{component_id} import {class_name}\n\n__all__ = ['{class_name}']\n")

        # Save requirements.txt if available
        if requirements_txt:
            requirements_file = component_dir / "requirements.txt"
            requirements_file.write_text(requirements_txt)

        # Save manifest (create one if not provided)
        manifest_file = component_dir / "manifest.yaml"
        if component_manifest:
            manifest_file.write_text(component_manifest)
        else:
            # Create a basic manifest from component metadata
            # Component type is always just the module path, regardless of src/ layout
            basic_manifest = {
                "name": component.name,
                "description": component.description,
                "version": component.version,
                "category": component.category,
                "icon": component.icon or "Package",
                "component_type": f"{actual_module_name}.components.{component_id}.{class_name}",
            }
            with open(manifest_file, 'w') as f:
                yaml.dump(basic_manifest, f, default_flow_style=False, sort_keys=False)

        # Save schema.json if available
        if component_schema:
            schema_file = component_dir / "schema.json"
            schema_file.write_text(component_schema)
            print(f"[Install] Saved schema.json to: {schema_file}")

        # 3. Install requirements.txt dependencies using uv add
        # This ensures dependencies are added to pyproject.toml
        if requirements_txt:
            requirements_file = component_dir / "requirements.txt"
            print(f"[Install] Installing requirements from: {requirements_file}")

            # Parse requirements.txt line by line
            requirements_lines = requirements_txt.strip().split('\n')
            packages_to_install = []

            for line in requirements_lines:
                line = line.strip()
                # Skip empty lines and comments
                if not line or line.startswith('#'):
                    continue
                # Handle lines with comments
                if '#' in line:
                    line = line.split('#')[0].strip()
                if line:
                    packages_to_install.append(line)

            if packages_to_install:
                print(f"[Install] Installing {len(packages_to_install)} packages: {packages_to_install}")
                try:
                    # Use uv add to install all packages at once
                    # This will update pyproject.toml automatically
                    result = subprocess.run(
                        ["uv", "add"] + packages_to_install,
                        check=True,
                        capture_output=True,
                        cwd=str(project_dir),
                        text=True,
                        timeout=300
                    )
                    print(f"[Install] Requirements installed successfully and added to pyproject.toml")
                    print(f"[Install] stdout: {result.stdout}")
                except subprocess.CalledProcessError as e:
                    print(f"Warning: Failed to install requirements: {e.stderr}")
                except subprocess.TimeoutExpired:
                    print(f"Warning: Requirements installation timed out")
            else:
                print(f"[Install] No valid packages found in requirements.txt")

        # Component type is always just the module path, regardless of src/ layout
        # The src/ directory is in sys.path, so imports are module_name.components.X
        component_type = f"{actual_module_name}.components.{component_id}.{class_name}"

        print(f"[Install] Component type: {component_type}")
        print(f"[Install] Component installed successfully (no defs.yaml created yet)")
        print(f"[Install] User must configure component to create instance")

        print(f"[Install] Installation complete!")
        print(f"[Install] No assets created yet - user must configure component to create instances")

        return {
            "success": True,
            "message": f"Component {component.name} installed successfully. Configure it to create an instance.",
            "component_type": component_type,
            "component_dir": str(component_dir.relative_to(project_dir)),
            "files_created": [
                str(component_file_path.relative_to(project_dir)),
                str(init_file.relative_to(project_dir)),
            ],
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Error installing component: {error_details}")
        raise HTTPException(
            status_code=500,
            detail=f"Error installing component: {str(e)}\n\nTraceback: {error_details}"
        )


@router.post("/install-via-cli/{component_id}")
async def install_component_via_cli(
    component_id: str,
    request: InstallComponentRequest,
):
    """Install a component using the official dagster-community-components-cli.

    The CLI is the source of truth for install layout: it drops files into
    <project>/src/<module>/components/<id>/ (with a component.py) and writes
    a stub defs.yaml with the canonical `type:` string. We shell out via uvx
    so the user doesn't need it globally installed, then parse the written
    defs.yaml to return the exact type string for the palette to use.
    """
    project = project_service.get_project(request.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project_service._get_project_dir(project)
    if not project_dir.is_absolute():
        project_dir = project_dir.resolve()
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail=f"Project directory not found: {project_dir}")

    cmd = [
        "uvx",
        "--from", "dagster-community-components-cli",
        "dagster-component",
        "add", component_id,
        "--auto-install",
        "--manager", "uv",
        "--force",
    ]
    print(f"[CLI Install] Running: {' '.join(cmd)} (cwd={project_dir})")

    try:
        result = subprocess.run(
            cmd,
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="CLI install timed out after 5 minutes")
    except FileNotFoundError:
        raise HTTPException(
            status_code=500,
            detail="uvx not found. Install `uv` (https://docs.astral.sh/uv/) to enable CLI-based component installs.",
        )

    stdout = result.stdout or ""
    stderr = result.stderr or ""
    print(f"[CLI Install] rc={result.returncode}\nstdout: {stdout}\nstderr: {stderr}")

    if result.returncode != 0:
        detail = (stderr or stdout or "unknown error").strip().splitlines()
        raise HTTPException(status_code=500, detail=f"CLI install failed: {' | '.join(detail[-5:])}")

    # Safety-net dependency install. Some community templates ship a
    # `requirements.txt` (e.g. airtable_ingestion needs dlt[airtable])
    # that `dagster-component add --auto-install` doesn't reliably pick
    # up — we've hit at least one case where the CLI reported success
    # but the deps never made it into the venv, leaving Dagster with a
    # ModuleNotFoundError on the next load. Read the template's
    # requirements.txt and `uv add` anything listed. Errors here are
    # non-fatal so a bad line doesn't kill the whole install.
    try:
        comp_dirs = list(project_dir.glob(f"src/*/components/{component_id}")) + list(project_dir.glob(f"*/components/{component_id}"))
        req_path = None
        for cd in comp_dirs:
            candidate = cd / "requirements.txt"
            if candidate.exists():
                req_path = candidate
                break
        if req_path:
            reqs: list[str] = []
            for line in req_path.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                reqs.append(line)
            if reqs:
                print(f"[CLI Install] Installing template requirements: {reqs}")
                add_result = subprocess.run(
                    ["uv", "add", *reqs],
                    cwd=str(project_dir),
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
                if add_result.returncode != 0:
                    tail = (add_result.stderr or add_result.stdout or "").strip().splitlines()[-5:]
                    print(f"[CLI Install] Warning: `uv add` for template deps failed: {' | '.join(tail)}")
                else:
                    print(f"[CLI Install] Installed template requirements successfully.")
    except Exception as _dep_e:
        print(f"[CLI Install] Warning: could not install template requirements: {_dep_e}")

    # The CLI writes a defs.yaml stub at <project>/src/<module>/defs/<id>/defs.yaml
    # (or the flat-layout equivalent). Find it and pull out the canonical type.
    candidates = [
        *project_dir.glob(f"src/*/defs/{component_id}/defs.yaml"),
        *project_dir.glob(f"*/defs/{component_id}/defs.yaml"),
    ]
    defs_yaml_path = next(iter(candidates), None)
    if defs_yaml_path is None:
        raise HTTPException(
            status_code=500,
            detail=f"CLI reported success but defs.yaml for {component_id} was not found under {project_dir}",
        )

    try:
        parsed = yaml.safe_load(defs_yaml_path.read_text()) or {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse {defs_yaml_path}: {e}")

    component_type = parsed.get("type")
    if not component_type or not isinstance(component_type, str):
        raise HTTPException(
            status_code=500,
            detail=f"defs.yaml at {defs_yaml_path} has no `type:` field to return",
        )

    # If the caller supplied attributes (e.g. Dagster AI's proposed config),
    # merge them into the stub defs.yaml the CLI wrote. LLMs love to guess
    # attribute names (e.g. `path` instead of `file_path`, plural
    # `upstream_asset_keys` instead of singular `upstream_asset_key`) — a
    # blind merge lands both variants in the yaml and schema validation
    # fails ("Additional properties not allowed"). Filter caller attributes
    # against the component's schema.json when it's available so we only
    # keep valid keys.
    if request.attributes:
        existing_attrs = parsed.get("attributes") or {}
        if not isinstance(existing_attrs, dict):
            existing_attrs = {}

        allowed_keys: Optional[set] = None
        # Common name-variant aliases we can rewrite silently so the LLM's
        # near-miss doesn't get dropped when there's an obvious mapping.
        alias_map = {
            'path': 'file_path',
            'upstream_asset_keys': 'upstream_asset_key',
            'upstream_asset_key': 'upstream_asset_keys',  # reverse direction
            'output_path': 'file_path',
            'input_asset': 'upstream_asset_key',
        }
        # Resolve the schema.json under the installed component dir.
        try:
            candidate_dirs = list(project_dir.glob(f"src/*/components/{component_id}/schema.json"))
            if candidate_dirs:
                import json as _json
                schema = _json.loads(candidate_dirs[0].read_text())
                props = schema.get('properties') or schema.get('attributes') or {}
                if isinstance(props, dict):
                    allowed_keys = set(props.keys())
        except Exception as e:
            print(f"[CLI Install] Warning: couldn't read schema.json for {component_id}: {e}")

        merged: dict = {**existing_attrs}
        dropped: list = []
        for k, v in request.attributes.items():
            if allowed_keys is None:
                # No schema — trust the caller.
                merged[k] = v
                continue
            if k in allowed_keys:
                merged[k] = v
                continue
            # Try aliasing.
            aliased = alias_map.get(k)
            if aliased and aliased in allowed_keys:
                merged[aliased] = v
                print(f"[CLI Install] Aliased attribute '{k}' → '{aliased}' for {component_id}")
                continue
            dropped.append(k)
        if dropped:
            print(f"[CLI Install] Dropped unknown attributes for {component_id}: {dropped} (schema keys: {sorted(allowed_keys or [])})")

        parsed["attributes"] = merged
        try:
            defs_yaml_path.write_text(yaml.safe_dump(parsed, sort_keys=False))
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Installed but failed to write attributes to {defs_yaml_path}: {e}",
            )

    # If the caller didn't supply any attributes, they installed the
    # TEMPLATE (Library UI) and did NOT ask to create an instance. The
    # community CLI's stub defs.yaml ships with demo values like
    # `upstream_asset_key: raw_customers` — great for docs, terrible for
    # a real project since Dagster tries to load the demo instance and
    # fails validation ("Input asset raw_customers is not produced by
    # any of the provided asset ops"). Remove the stub so the template
    # is installed but no bogus instance runs. Instances get created
    # explicitly via the graph builder / AI apply path (which DO supply
    # attributes and would land here with a merged, valid config).
    if request.template_only or not request.attributes:
        try:
            import shutil as _sh
            _sh.rmtree(defs_yaml_path.parent)
            print(
                f"[CLI Install] Removed demo defs at {defs_yaml_path.parent} — "
                f"template installed but no instance created "
                f"(template_only={request.template_only}, attributes empty)."
            )
        except Exception as e:
            print(f"[CLI Install] Warning: couldn't remove demo defs: {e}")
        return {
            "success": True,
            "component_id": component_id,
            "component_type": component_type,
            "defs_yaml": None,
        }

    # If the caller wants a different instance directory name (needed when the
    # same component_id is being installed more than once), rename the defs
    # directory now. defs.yaml itself is unchanged.
    final_defs_yaml_path = defs_yaml_path
    final_instance_id = component_id
    if request.instance_name and request.instance_name != component_id:
        target_dir = defs_yaml_path.parent.parent / request.instance_name
        if target_dir.exists():
            # Collision — fall back to a numeric suffix so we don't overwrite.
            i = 2
            while (defs_yaml_path.parent.parent / f"{request.instance_name}_{i}").exists():
                i += 1
            target_dir = defs_yaml_path.parent.parent / f"{request.instance_name}_{i}"
        try:
            defs_yaml_path.parent.rename(target_dir)
            final_defs_yaml_path = target_dir / "defs.yaml"
            final_instance_id = target_dir.name
        except Exception as e:
            print(f"[CLI Install] Rename to {target_dir} failed, leaving default name: {e}")

    # Register this instance on the project so the Project Components sidebar
    # shows it. Previously install-via-cli only wrote defs.yaml on disk, so
    # AI-applied picks (which use this endpoint) never showed up in the
    # sidebar even though they were live in the graph.
    try:
        from ..models.project import ComponentInstance, ProjectUpdate
        existing_ids = {c.id for c in project.components}
        if final_instance_id not in existing_ids:
            new_component = ComponentInstance(
                id=final_instance_id,
                component_type=component_type,
                label=final_instance_id.replace('_', ' ').title(),
                attributes=parsed.get("attributes") or {},
                translation=None,
                post_processing=None,
                is_asset_factory=False,
            )
            updated_components = project.components + [new_component]
            project_service.update_project(
                request.project_id,
                ProjectUpdate(components=updated_components),
            )
            print(f"[CLI Install] Registered component instance '{final_instance_id}' on project.")
    except Exception as e:
        # Non-fatal — the defs.yaml is already written, so the asset will
        # still be introspectable. Just log so the sidebar-miss is visible.
        print(f"[CLI Install] Warning: could not add {final_instance_id} to project.components: {e}")

    return {
        "success": True,
        "component_id": component_id,
        "component_type": component_type,
        "defs_yaml": str(final_defs_yaml_path.relative_to(project_dir)),
    }
