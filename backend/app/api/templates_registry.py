"""API endpoints for community component templates."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import httpx
import yaml
import subprocess
import os
from pathlib import Path
from typing import List, Optional

from ..services.project_service import project_service

router = APIRouter(prefix="/templates", tags=["templates"])

MANIFEST_URL = "https://raw.githubusercontent.com/eric-thomas-dagster/dagster-component-templates/main/manifest.json"


class ComponentTemplate(BaseModel):
    """Community component template metadata."""
    id: str
    name: str
    category: str
    description: str
    version: str
    author: str
    path: str
    tags: List[str]
    dependencies: dict
    readme_url: str
    component_url: str
    schema_url: str
    example_url: str
    requirements_url: Optional[str] = None
    manifest_url: Optional[str] = None


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

        # Determine defs directory
        flat_defs_dir = project_dir / project_name_sanitized / "defs"
        src_defs_dir = project_dir / "src" / project_name_sanitized / "defs"

        defs_dir = None
        if flat_defs_dir.exists():
            defs_dir = flat_defs_dir
        elif src_defs_dir.exists():
            defs_dir = src_defs_dir
        else:
            raise HTTPException(status_code=404, detail="Defs directory not found")

        # Get component manifest to determine component_type
        components_dir = (project_dir / project_name_sanitized / "components"
                         if (project_dir / project_name_sanitized / "components").exists()
                         else project_dir / "src" / project_name_sanitized / "components")

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

        # Create subdirectory for the component instance
        instance_dir = defs_dir / instance_name
        instance_dir.mkdir(parents=True, exist_ok=True)
        yaml_file = instance_dir / "defs.yaml"

        # Use correct YAML format: type + attributes
        yaml_config = {
            "type": component_type,
            "attributes": {k: v for k, v in request.config.items() if k != 'name'}
        }

        with open(yaml_file, 'w') as f:
            yaml.dump(yaml_config, f, default_flow_style=False, sort_keys=False)

        print(f"[Configure] Updated component configuration: {yaml_file}")
        print(f"[Configure] Config: {yaml_config}")

        return {
            "success": True,
            "message": f"Component {instance_name} configured successfully",
            "yaml_file": str(yaml_file.relative_to(project_dir))
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

        # Check for components directory
        # Try both flat and src layouts
        flat_components_dir = project_dir / project_name_sanitized / "components"
        src_components_dir = project_dir / "src" / project_name_sanitized / "components"

        components_dir = None
        if flat_components_dir.exists():
            components_dir = flat_components_dir
        elif src_components_dir.exists():
            components_dir = src_components_dir

        if not components_dir or not components_dir.exists():
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


@router.get("/manifest")
async def get_manifest() -> TemplateManifest:
    """Fetch the component templates manifest from GitHub."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(MANIFEST_URL, timeout=10.0)
            response.raise_for_status()
            data = response.json()
            return TemplateManifest(**data)
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

        # Parse component code to find the class name
        import re
        class_match = re.search(r'class\s+(\w+)\s*\(', component_code)
        if not class_match:
            raise HTTPException(
                status_code=500,
                detail="Could not find class definition in component code"
            )
        class_name = class_match.group(1)

        # 1. Create component directory in project's {project_name}/components/
        # Check if project uses src/ layout or flat layout by checking which exists
        flat_dir = project_dir / project_name_sanitized
        src_dir = project_dir / "src" / project_name_sanitized

        use_src_layout = False

        if flat_dir.exists() and (flat_dir / "defs").exists():
            base_dir = flat_dir
            use_src_layout = False
            print(f"[Install] Using flat layout: {base_dir}")
        elif src_dir.exists() and (src_dir / "defs").exists():
            base_dir = src_dir
            use_src_layout = True
            print(f"[Install] Using src/ layout: {base_dir}")
        elif flat_dir.exists():
            base_dir = flat_dir
            use_src_layout = False
            print(f"[Install] Using flat layout (defs not found, using flat): {base_dir}")
        elif src_dir.exists():
            base_dir = src_dir
            use_src_layout = True
            print(f"[Install] Using src/ layout (defs not found, using src): {base_dir}")
        else:
            # Default to flat layout if neither exists (match most Dagster projects)
            base_dir = flat_dir
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
            basic_manifest = {
                "name": component.name,
                "description": component.description,
                "version": component.version,
                "category": component.category,
                "component_type": f"{project_name_sanitized}.components.{component_id}.{class_name}" if not use_src_layout else f"src.{project_name_sanitized}.components.{component_id}.{class_name}",
            }
            with open(manifest_file, 'w') as f:
                yaml.dump(basic_manifest, f, default_flow_style=False, sort_keys=False)

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

        # 4. Register component instance
        # Strategy: Use dg scaffold defs for newly created projects (is_imported=False)
        # Use manual YAML creation for imported projects (is_imported=True) to avoid structure detection issues
        is_imported_project = project.is_imported

        # Fallback detection for projects imported before is_imported field was added
        # Check if project has git_repo or was imported from disk
        if not is_imported_project and (project.git_repo or "Imported from" in (project.description or "")):
            print(f"[Install] Detected legacy imported project (no is_imported flag)")
            is_imported_project = True
            # Update project metadata for future operations
            project.is_imported = True
            from ..models.project import ProjectUpdate
            project_service.update_project(request.project_id, ProjectUpdate(is_imported=True))

        if use_src_layout:
            component_type = f"src.{project_name_sanitized}.components.{component_id}.{class_name}"
            defs_dir = project_dir / "src" / project_name_sanitized / "defs"
        else:
            component_type = f"{project_name_sanitized}.components.{component_id}.{class_name}"
            defs_dir = project_dir / project_name_sanitized / "defs"

        instance_name = request.config.get('name', component_id)

        print(f"[Install] Component type: {component_type}")
        print(f"[Install] Instance name: {instance_name}")
        print(f"[Install] Defs directory: {defs_dir}")
        print(f"[Install] Is imported project: {is_imported_project}")

        if is_imported_project:
            # Imported project: Use manual YAML creation (more reliable for non-standard structures)
            print(f"[Install] Using manual YAML creation for imported project")

            # Ensure defs directory exists
            if not defs_dir.exists():
                print(f"[Install] WARNING: Defs directory does not exist: {defs_dir}")
                defs_dir.mkdir(parents=True, exist_ok=True)
                print(f"[Install] Created defs directory")

            # Create subdirectory for the component instance
            instance_dir = defs_dir / instance_name
            instance_dir.mkdir(parents=True, exist_ok=True)
            yaml_file = instance_dir / "defs.yaml"
            print(f"[Install] Creating YAML config at: {yaml_file}")

            # Build YAML configuration with correct format: type + attributes
            yaml_config = {
                "type": component_type,
                "attributes": {k: v for k, v in request.config.items() if k != 'name'}
            }

            # Write YAML file
            with open(yaml_file, 'w') as f:
                yaml.dump(yaml_config, f, default_flow_style=False, sort_keys=False)

            print(f"[Install] YAML config created successfully")

            # Verify the file was created
            if yaml_file.exists():
                print(f"[Install] Verified YAML file exists: {yaml_file}")
                with open(yaml_file, 'r') as f:
                    print(f"[Install] YAML content:\n{f.read()}")
            else:
                print(f"[Install] ERROR: YAML file was not created!")
        else:
            # Newly created project: Use dg scaffold defs (follows our scaffolding patterns)
            print(f"[Install] Using dg scaffold defs for newly created project")

            dg_bin = project_dir / ".venv" / "bin" / "dg"
            if not dg_bin.exists():
                raise HTTPException(
                    status_code=500,
                    detail=f"dg command not found at {dg_bin}. Ensure the project has a virtual environment with dagster installed."
                )

            # Build params string from config (excluding 'name')
            params = []
            for key, value in request.config.items():
                if key != 'name':
                    params.append(f"--param")
                    params.append(f"{key}={value}")

            cmd = [
                str(dg_bin),
                "scaffold",
                "defs",
                component_type,
                instance_name,
                *params
            ]

            print(f"[Install] Running dg scaffold command: {' '.join(cmd)}")

            try:
                env = {
                    **os.environ,
                    "VIRTUAL_ENV": str(project_dir / ".venv"),
                    "PATH": f"{project_dir / '.venv' / 'bin'}:{os.environ.get('PATH', '')}",
                }

                result = subprocess.run(
                    cmd,
                    check=True,
                    capture_output=True,
                    cwd=str(project_dir),
                    text=True,
                    env=env
                )
                print(f"[Install] dg scaffold completed successfully")
                print(f"[Install] stdout: {result.stdout}")
            except subprocess.CalledProcessError as e:
                print(f"[Install] dg scaffold failed: {e.stderr}")
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to register component: {e.stderr}"
                )

        print(f"[Install] Installation complete!")
        return {
            "success": True,
            "message": f"Component {component.name} installed successfully",
            "component_type": component_type,
            "instance_name": instance_name,
            "component_dir": str(component_dir.relative_to(project_dir)),
            "files_created": [
                str(component_file_path.relative_to(project_dir)),
                str(init_file.relative_to(project_dir)),
            ]
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
