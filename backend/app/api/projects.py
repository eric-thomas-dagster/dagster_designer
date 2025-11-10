"""API endpoints for project management."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..models.project import (
    Project,
    ProjectCreate,
    ProjectUpdate,
    ProjectListResponse,
)
from ..services.project_service import project_service
from ..services.asset_introspection_service import asset_introspection_service

router = APIRouter(prefix="/projects", tags=["projects"])


class CloneRepoRequest(BaseModel):
    """Request to clone a git repository."""
    git_repo: str
    git_branch: str = "main"


class CloneRepoResponse(BaseModel):
    """Response from cloning a repository."""
    project: Project
    repo_name: str


class ProjectImportRequest(BaseModel):
    """Request to import an existing Dagster project."""
    path: str = Field(..., description="Absolute path to existing Dagster project directory")


@router.post("", response_model=Project, status_code=201)
async def create_project(project_create: ProjectCreate):
    """Create a new pipeline project."""
    project = project_service.create_project(project_create)

    # Auto-regenerate assets if project has components
    if project.components:
        print(f"🔄 Auto-regenerating assets for new project...")
        try:
            nodes, edges = asset_introspection_service.get_assets_for_project(project)
            project.graph.nodes = nodes
            project.graph.edges = edges
            # Save the updated project with assets
            project_service._save_project(project)
            print(f"✅ Assets regenerated: {len(nodes)} nodes, {len(edges)} edges")
        except Exception as e:
            print(f"⚠️  Failed to auto-regenerate assets: {e}")
            # Continue anyway - user can manually regenerate later

    return project


@router.post("/import", response_model=Project, status_code=201)
async def import_project(request: ProjectImportRequest):
    """Import an existing Dagster project from disk.

    This will:
    1. Validate the path is a valid Dagster project
    2. Copy the project to the projects directory
    3. Create a project record in the backend
    4. Run asset introspection to discover assets
    """
    try:
        project = project_service.import_project(request.path)

        # Auto-regenerate assets to discover existing assets
        print(f"🔄 Discovering assets from imported project...")
        try:
            nodes, edges = asset_introspection_service.get_assets_for_project(project)
            project.graph.nodes = nodes
            project.graph.edges = edges
            # Save the updated project with assets
            project_service._save_project(project)
            print(f"✅ Assets discovered: {len(nodes)} nodes, {len(edges)} edges")
        except Exception as e:
            print(f"⚠️  Failed to discover assets: {e}")
            # Continue anyway - user can manually regenerate later

        return project
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to import project: {str(e)}")


@router.get("", response_model=ProjectListResponse)
async def list_projects():
    """List all projects."""
    projects = project_service.list_projects()
    return ProjectListResponse(projects=projects, total=len(projects))


@router.get("/{project_id}", response_model=Project)
async def get_project(project_id: str):
    """Get a project by ID."""
    project = project_service.get_project(project_id)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return project


@router.put("/{project_id}", response_model=Project)
async def update_project(project_id: str, project_update: ProjectUpdate):
    """Update a project."""
    import sys

    print(f"\n[API PUT /projects/{project_id}] Received update request", flush=True)
    print(f"[API] ProjectUpdate fields set: {project_update.model_dump(exclude_unset=True).keys()}", flush=True)
    sys.stdout.flush()

    project = project_service.update_project(project_id, project_update)

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    print(f"[API PUT /projects/{project_id}] Update completed successfully", flush=True)
    sys.stdout.flush()
    return project


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str):
    """Delete a project."""
    success = project_service.delete_project(project_id)

    if not success:
        raise HTTPException(status_code=404, detail="Project not found")

    return None


@router.post("/{project_id}/clone-repo", response_model=CloneRepoResponse)
async def clone_repo(project_id: str, request: CloneRepoRequest):
    """Clone a git repository for a project."""
    result = project_service.clone_repo_for_project(
        project_id,
        request.git_repo,
        request.git_branch
    )

    if not result:
        raise HTTPException(status_code=404, detail="Project not found")

    project, repo_name = result
    return CloneRepoResponse(project=project, repo_name=repo_name)


@router.post("/{project_id}/regenerate-assets", response_model=Project)
async def regenerate_assets(project_id: str):
    """Regenerate assets for a project by running dg list defs.

    This introspects the Dagster components and updates the project graph
    with the actual assets that will be generated.
    """
    import sys
    print(f"\n[regenerate_assets] ====== START ======", flush=True)
    print(f"[regenerate_assets] project_id: {project_id}", flush=True)
    sys.stdout.flush()

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        # Get assets from dg list defs
        asset_nodes, asset_edges = asset_introspection_service.get_assets_for_project(project)
        print(f"[regenerate_assets] Got {len(asset_nodes)} nodes, {len(asset_edges)} edges from introspection", flush=True)
        sys.stdout.flush()

        # Update project graph with assets (preserving any non-asset nodes)
        non_asset_nodes = [n for n in project.graph.nodes if n.node_kind != "asset"]
        project.graph.nodes = non_asset_nodes + asset_nodes

        # Merge introspected edges with custom lineage edges
        from ..models.graph import GraphEdge

        # Create a map of edge IDs for quick lookup
        edge_map = {edge.id: edge for edge in asset_edges}

        # Process custom lineage edges
        custom_edges_added = 0
        for custom_lineage in project.custom_lineage:
            edge_id = f"{custom_lineage.source}_to_{custom_lineage.target}"

            if edge_id in edge_map:
                # Edge already exists from introspection, just mark it as custom
                edge_map[edge_id].is_custom = True
                print(f"[regenerate_assets] Marked existing edge as custom: {edge_id}", flush=True)
            else:
                # Edge doesn't exist, create a new custom edge
                edge_map[edge_id] = GraphEdge(
                    id=edge_id,
                    source=custom_lineage.source,
                    target=custom_lineage.target,
                    is_custom=True
                )
                custom_edges_added += 1
                print(f"[regenerate_assets] Added new custom edge: {edge_id}", flush=True)

        # Convert edge map back to list
        project.graph.edges = list(edge_map.values())

        print(f"[regenerate_assets] Updated project.graph: {len(project.graph.nodes)} nodes, {len(asset_edges)} introspected edges + {custom_edges_added} new custom edges = {len(project.graph.edges)} total", flush=True)
        print(f"[regenerate_assets] Calling update_project to save...", flush=True)
        sys.stdout.flush()

        # Save updated project
        updated_project = project_service.update_project(project_id, ProjectUpdate(graph=project.graph))

        print(f"[regenerate_assets] update_project returned project with {len(updated_project.graph.nodes if updated_project else 0)} nodes", flush=True)
        print(f"[regenerate_assets] ====== END ======\n", flush=True)
        sys.stdout.flush()

        return updated_project if updated_project else project

    except Exception as e:
        print(f"[regenerate_assets] ERROR: {e}", flush=True)
        sys.stdout.flush()
        raise HTTPException(status_code=500, detail=f"Failed to regenerate assets: {str(e)}")


@router.post("/{project_id}/discover-components", response_model=Project)
async def discover_components(project_id: str):
    """Discover components from YAML files in an existing project.

    This scans the project's defs directory for component YAML files and
    adds them to the project. Useful for imported projects or when components
    are manually added outside of the designer.
    """
    try:
        project = project_service.discover_components_for_project(project_id)

        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        return project

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to discover components: {str(e)}")


@router.post("/{project_id}/validate")
async def validate_project(project_id: str):
    """Validate a project by running dg list defs and checking for errors.

    This checks if the project's component definitions are valid and can be loaded by Dagster.
    """
    import subprocess
    from pathlib import Path

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project_dir = project_service._get_project_dir(project)
    venv_dg = project_dir / ".venv" / "bin" / "dg"

    if not venv_dg.exists():
        return {
            "valid": False,
            "error": f"Project virtual environment not found at {venv_dg}. Please recreate the project.",
            "details": None
        }

    try:
        # Run dg list defs to validate the project
        result = subprocess.run(
            [str(venv_dg.absolute()), "list", "defs"],
            cwd=str(project_dir.absolute()),
            capture_output=True,
            text=True,
            timeout=30
        )

        # If return code is 0, project is valid (even if there are warnings in stderr)
        if result.returncode == 0:
            # Count assets from output (look for the Assets section)
            has_assets = "Assets" in result.stdout and "│" in result.stdout

            # Return full output (no truncation)
            stdout_full = result.stdout if result.stdout else "No output"

            return {
                "valid": True,
                "message": "Project validation successful! All component definitions are valid." +
                         (f"\n\nFound assets in the project." if has_assets else ""),
                "details": {
                    "stdout": stdout_full,
                    "warnings": result.stderr if result.stderr else None  # Show full warnings
                }
            }
        else:
            # Extract error message from stderr
            error_lines = result.stderr.split('\n')

            # Look for validation error
            validation_error = None
            for i, line in enumerate(error_lines):
                if "ValidationError" in line or "Error" in line:
                    # Get surrounding context
                    start = max(0, i - 2)
                    end = min(len(error_lines), i + 10)
                    validation_error = '\n'.join(error_lines[start:end])
                    break

            return {
                "valid": False,
                "error": "Project validation failed. Component definitions have errors.",
                "details": {
                    "stderr": result.stderr,  # Full error output
                    "validation_error": validation_error
                }
            }

    except subprocess.TimeoutExpired:
        return {
            "valid": False,
            "error": "Validation timed out after 30 seconds",
            "details": None
        }
    except Exception as e:
        return {
            "valid": False,
            "error": f"Validation error: {str(e)}",
            "details": None
        }


class MaterializeRequest(BaseModel):
    """Request to materialize assets."""
    asset_keys: list[str] | None = None  # If None, materialize all assets


class MaterializeResponse(BaseModel):
    """Response from materializing assets."""
    success: bool
    message: str
    stdout: str
    stderr: str


@router.post("/{project_id}/materialize", response_model=MaterializeResponse)
async def materialize_assets(project_id: str, request: MaterializeRequest):
    """Materialize assets using dg launch command.

    This executes the dg launch command to materialize one or more assets.
    If no asset_keys are provided, all assets will be materialized.
    """
    import subprocess
    from pathlib import Path

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Get project path - construct it the same way as during project creation
    project_name_sanitized = project.name.lower().replace(" ", "_").replace("-", "_")
    project_dir_name = f"project_{project_id.split('-')[0]}_{project_name_sanitized}"
    project_path = Path("./projects") / project_dir_name
    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project directory not found: {project_path}")

    try:
        # Build dg launch command using project's venv
        venv_python = project_path / ".venv" / "bin" / "python"
        venv_dg = project_path / ".venv" / "bin" / "dg"

        if not venv_dg.exists():
            raise HTTPException(
                status_code=500,
                detail="Project virtual environment not found. Please ensure the project was created successfully."
            )

        # Build the command - use absolute path to dg binary
        cmd = [str(venv_dg.absolute()), "launch"]

        # Add asset selection if provided
        if request.asset_keys:
            cmd.extend(["--assets", ",".join(request.asset_keys)])
        else:
            # Materialize all assets - get all asset keys from project
            asset_keys = [node.data.get("asset_key", node.id) for node in project.graph.nodes if node.node_kind == "asset"]
            if asset_keys:
                cmd.extend(["--assets", ",".join(asset_keys)])
            else:
                return MaterializeResponse(
                    success=False,
                    message="No assets found to materialize",
                    stdout="",
                    stderr=""
                )

        print(f"[materialize] Running command: {' '.join(cmd)}")
        print(f"[materialize] Working directory: {project_path}")

        # Set up environment to use project's venv (use absolute paths)
        import os
        project_path_abs = project_path.absolute()
        venv_path_abs = project_path_abs / ".venv"

        env = os.environ.copy()
        env['VIRTUAL_ENV'] = str(venv_path_abs)
        env['PATH'] = f"{venv_path_abs / 'bin'}:{env.get('PATH', '')}"
        # Remove any parent venv variables that might confuse dg
        env.pop('PYTHONHOME', None)

        print(f"[materialize] Using venv: {venv_path_abs}")

        # Run command
        result = subprocess.run(
            cmd,
            cwd=str(project_path),
            env=env,
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )

        print(f"[materialize] Return code: {result.returncode}")
        print(f"[materialize] stdout: {result.stdout[:500]}")  # First 500 chars
        print(f"[materialize] stderr: {result.stderr[:500]}")  # First 500 chars

        success = result.returncode == 0
        message = "Materialization completed successfully" if success else "Materialization failed"

        return MaterializeResponse(
            success=success,
            message=message,
            stdout=result.stdout,
            stderr=result.stderr
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail="Materialization timed out after 5 minutes")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to materialize assets: {str(e)}")


class CustomLineageRequest(BaseModel):
    """Request to add or remove custom lineage."""
    source: str  # Source asset key
    target: str  # Target asset key


@router.post("/{project_id}/custom-lineage", response_model=Project)
async def add_custom_lineage(project_id: str, request: CustomLineageRequest):
    """Add a custom lineage edge between two assets.

    This creates a dependency that will be injected into the asset specs
    via map_asset_specs in definitions.py.
    """
    from ..models.project import CustomLineageEdge, ProjectUpdate
    import traceback

    try:
        project = project_service.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        # Add the custom lineage edge if it doesn't already exist
        new_edge = CustomLineageEdge(source=request.source, target=request.target)

        # Check if edge already exists
        exists = any(
            edge.source == new_edge.source and edge.target == new_edge.target
            for edge in project.custom_lineage
        )

        if not exists:
            updated_lineage = project.custom_lineage + [new_edge]
            updated_project = project_service.update_project(
                project_id,
                ProjectUpdate(custom_lineage=updated_lineage)
            )

            # Write custom_lineage.json to project directory
            try:
                project_service._write_custom_lineage_file(updated_project)
            except Exception as write_err:
                print(f"⚠️  Warning: Failed to write custom_lineage.json: {write_err}", flush=True)
                # Continue anyway - the lineage is saved in the DB

            return updated_project

        return project
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error adding custom lineage: {e}", flush=True)
        print(traceback.format_exc(), flush=True)
        raise HTTPException(status_code=500, detail=f"Failed to add custom lineage: {str(e)}")


@router.delete("/{project_id}/custom-lineage", response_model=Project)
async def remove_custom_lineage(project_id: str, request: CustomLineageRequest):
    """Remove a custom lineage edge between two assets."""
    from ..models.project import ProjectUpdate
    import traceback

    try:
        project = project_service.get_project(project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        # Remove the custom lineage edge
        updated_lineage = [
            edge for edge in project.custom_lineage
            if not (edge.source == request.source and edge.target == request.target)
        ]

        updated_project = project_service.update_project(
            project_id,
            ProjectUpdate(custom_lineage=updated_lineage)
        )

        # Update custom_lineage.json file
        try:
            project_service._write_custom_lineage_file(updated_project)
        except Exception as write_err:
            print(f"⚠️  Warning: Failed to write custom_lineage.json: {write_err}", flush=True)
            # Continue anyway - the lineage is saved in the DB

        return updated_project
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error removing custom lineage: {e}", flush=True)
        print(traceback.format_exc(), flush=True)
        raise HTTPException(status_code=500, detail=f"Failed to remove custom lineage: {str(e)}")


class YAMLExportResponse(BaseModel):
    """Response from YAML export."""
    yaml_content: str
    filename: str


class YAMLImportRequest(BaseModel):
    """Request to import YAML pipeline."""
    yaml_content: str


@router.get("/{project_id}/export-yaml", response_model=YAMLExportResponse)
async def export_project_yaml(project_id: str):
    """Export project components as multi-document YAML.

    This generates a single YAML file with all components separated by `---`.
    Includes:
    - All component definitions
    - DependencyGraphComponent with edge information
    - Component attributes and configuration

    The exported YAML can be version controlled and imported back later.
    """
    import yaml

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Generate YAML documents for each component
    yaml_docs = []

    for component in project.components:
        doc = {
            'type': component.component_type,
            'attributes': component.attributes
        }

        # Add optional fields if present
        if component.label and component.label != component.id:
            doc['label'] = component.label
        if component.description:
            doc['description'] = component.description
        if hasattr(component, 'translation') and component.translation:
            doc['translation'] = component.translation
        if hasattr(component, 'post_processing') and component.post_processing:
            doc['post_processing'] = component.post_processing

        yaml_docs.append(yaml.dump(doc, default_flow_style=False, sort_keys=False))

    # Combine with --- separators
    yaml_content = "\n---\n\n".join(yaml_docs)

    # Generate filename
    project_name = project.name.replace(" ", "_").lower()
    filename = f"{project_name}_pipeline.yaml"

    return YAMLExportResponse(
        yaml_content=yaml_content,
        filename=filename
    )


@router.post("/{project_id}/import-yaml", response_model=Project)
async def import_project_yaml(project_id: str, request: YAMLImportRequest):
    """Import pipeline components from multi-document YAML.

    This replaces the project's components with those defined in the YAML.
    The YAML should contain documents separated by `---`, where each document defines a component.

    After import:
    - Existing components are replaced
    - Assets are regenerated from the new components
    - Graph is updated with new nodes and edges

    Example YAML format:
    ```yaml
    type: dagster_component_templates.RestApiFetcherComponent
    attributes:
      asset_name: api_data
      api_url: https://api.example.com/data

    ---

    type: dagster_component_templates.DependencyGraphComponent
    attributes:
      edges:
        - source: api_data
          target: cleaned_data
    ```
    """
    import yaml

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    try:
        # Parse multi-document YAML
        documents = list(yaml.safe_load_all(request.yaml_content))

        if not documents:
            raise HTTPException(status_code=400, detail="No YAML documents found")

        # Clear existing components
        project.components = []

        # Create components from YAML documents
        from ..models.component import ComponentInstance
        import uuid

        for i, doc in enumerate(documents):
            if not isinstance(doc, dict):
                raise HTTPException(
                    status_code=400,
                    detail=f"Document {i+1} is not a valid YAML object"
                )

            if 'type' not in doc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Document {i+1} is missing 'type' field"
                )

            # Create component instance
            component = ComponentInstance(
                id=str(uuid.uuid4()),
                component_type=doc['type'],
                label=doc.get('label', doc.get('attributes', {}).get('asset_name', f"component_{i+1}")),
                description=doc.get('description', ''),
                attributes=doc.get('attributes', {}),
                translation=doc.get('translation'),
                post_processing=doc.get('post_processing'),
                is_asset_factory=True  # Assume all imported components are asset factories
            )

            project.components.append(component)

        # Save updated project
        updated_project = project_service.update_project(
            project_id,
            ProjectUpdate(components=project.components)
        )

        # Regenerate assets from the imported components
        try:
            asset_nodes, asset_edges = asset_introspection_service.get_assets_for_project(updated_project)

            # Update graph with regenerated assets
            non_asset_nodes = [n for n in updated_project.graph.nodes if n.node_kind != "asset"]
            updated_project.graph.nodes = non_asset_nodes + asset_nodes
            updated_project.graph.edges = asset_edges

            # Save again with updated graph
            updated_project = project_service.update_project(
                project_id,
                ProjectUpdate(graph=updated_project.graph)
            )
        except Exception as e:
            print(f"⚠️  Failed to regenerate assets after import: {e}")
            # Continue anyway - assets can be regenerated manually

        return updated_project

    except yaml.YAMLError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid YAML: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to import YAML: {str(e)}"
        )
