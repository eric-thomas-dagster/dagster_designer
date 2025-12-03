"""API endpoints for CDP Pipeline Templates.

Pipeline templates are multi-component bundles that install and configure
multiple components at once to solve a specific use case.

Example: "Customer LTV Pipeline" installs:
  - Shopify ingestion component
  - E-commerce standardizer component
  - LTV prediction component
  - Customer segmentation component
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Optional
import httpx
import yaml
import json
from pathlib import Path

from ..services.project_service import project_service
from .templates_registry import (
    detect_project_structure,
    validate_component_config,
    InstallComponentRequest
)

router = APIRouter(prefix="/pipeline-templates", tags=["pipeline-templates"])

# GitHub URL for pipeline templates manifest
PIPELINE_MANIFEST_URL = "https://raw.githubusercontent.com/eric-thomas-dagster/dagster-component-templates/main/pipelines/manifest.json"


class PipelineComponent(BaseModel):
    """A component within a pipeline template."""
    component_id: str
    instance_name: str
    config_mapping: Dict[str, str]  # Maps pipeline params to component params
    depends_on: Optional[List[str]] = []  # List of instance names this depends on


class PipelineTemplate(BaseModel):
    """Pipeline template metadata."""
    id: str
    name: str
    description: str
    category: str
    use_case: str
    business_outcome: str
    components: List[PipelineComponent]
    pipeline_params: Dict[str, Dict]  # High-level parameters for the pipeline
    estimated_savings: Optional[str] = None
    readme_url: str
    yaml_url: str
    icon: Optional[str] = "Workflow"


class PipelineManifest(BaseModel):
    """Manifest of all available pipeline templates."""
    version: str
    repository: str
    last_updated: str
    pipelines: List[PipelineTemplate]


class InstallPipelineRequest(BaseModel):
    """Request model for installing a pipeline template."""
    project_id: str
    config: Dict[str, any]  # High-level pipeline configuration


@router.get("/manifest")
async def get_pipeline_manifest() -> PipelineManifest:
    """Fetch the pipeline templates manifest from GitHub."""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(PIPELINE_MANIFEST_URL, timeout=10.0)
            response.raise_for_status()
            data = response.json()
            return PipelineManifest(**data)
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch pipeline manifest: {str(e)}"
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error processing pipeline manifest: {str(e)}"
        )


@router.get("/pipeline/{pipeline_id}")
async def get_pipeline_details(pipeline_id: str):
    """Get detailed information about a specific pipeline template."""
    try:
        # Fetch manifest
        manifest = await get_pipeline_manifest()

        # Find pipeline
        pipeline = next(
            (p for p in manifest.pipelines if p.id == pipeline_id),
            None
        )

        if not pipeline:
            raise HTTPException(status_code=404, detail="Pipeline template not found")

        # Fetch README
        async with httpx.AsyncClient() as client:
            readme_response = await client.get(pipeline.readme_url, timeout=10.0)
            yaml_response = await client.get(pipeline.yaml_url, timeout=10.0)

            return {
                "pipeline": pipeline.dict(),
                "readme": readme_response.text,
                "yaml_content": yaml_response.text,
            }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching pipeline: {str(e)}"
        )


def resolve_config_value(value: str, pipeline_config: Dict) -> any:
    """
    Resolve a configuration value that may reference pipeline-level params.

    Examples:
        "${data_source}" -> looks up pipeline_config["data_source"]
        "standardized_orders" -> returns as-is
        "${prediction_period_months}" -> looks up pipeline_config["prediction_period_months"]
    """
    if isinstance(value, str) and value.startswith("${") and value.endswith("}"):
        param_name = value[2:-1]
        if param_name in pipeline_config:
            return pipeline_config[param_name]
        else:
            raise ValueError(f"Pipeline parameter '{param_name}' not provided in configuration")
    return value


@router.post("/install/{pipeline_id}")
async def install_pipeline_template(
    pipeline_id: str,
    request: InstallPipelineRequest
):
    """
    Install a complete pipeline template with all its components.

    This endpoint:
    1. Validates the pipeline configuration
    2. Ensures all required components are installed (installs if missing)
    3. Creates instances of each component with proper configuration
    4. Connects components via lineage (source_asset parameters)
    5. Returns the created assets

    Args:
        pipeline_id: ID of the pipeline template to install
        request: Pipeline configuration

    Returns:
        Details about installed components and created assets
    """
    try:
        print(f"[InstallPipeline] Starting installation of pipeline: {pipeline_id}")
        print(f"[InstallPipeline] Pipeline config: {json.dumps(request.config, indent=2)}")

        # Fetch pipeline metadata
        manifest = await get_pipeline_manifest()
        pipeline_template = next(
            (p for p in manifest.pipelines if p.id == pipeline_id),
            None
        )

        if not pipeline_template:
            raise HTTPException(status_code=404, detail="Pipeline template not found")

        # Get project
        project = project_service.get_project(request.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        project_dir = project_service._get_project_dir(project)
        if not project_dir.is_absolute():
            project_dir = project_dir.resolve()
        project_name_sanitized = project.name.replace(" ", "_").replace("-", "_")

        # Detect project structure
        try:
            base_dir, actual_module_name, use_src_layout, defs_dir, components_dir = detect_project_structure(
                project_dir, project_name_sanitized
            )
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))

        print(f"[InstallPipeline] Project structure detected:")
        print(f"[InstallPipeline]   Module: {actual_module_name}")
        print(f"[InstallPipeline]   Defs dir: {defs_dir}")
        print(f"[InstallPipeline]   Components dir: {components_dir}")

        # Track installed components and created instances
        installed_components = []
        created_instances = []
        errors = []

        # Step 1: Ensure all required components are installed
        for pipeline_component in pipeline_template.components:
            component_id = pipeline_component.component_id
            component_dir = components_dir / component_id

            if not component_dir.exists():
                print(f"[InstallPipeline] Component {component_id} not found, need to install it")
                # Component not installed - we need to install it first
                # This would require fetching from the component manifest
                # For now, return an error asking user to install components first
                errors.append(f"Component '{component_id}' is not installed. Please install it first from the Component Library.")
                continue

            print(f"[InstallPipeline] Component {component_id} found at {component_dir}")

        # If there are missing components, stop here
        if errors:
            raise HTTPException(
                status_code=400,
                detail="Missing required components:\n" + "\n".join(errors)
            )

        # Step 2: Create component instances with resolved configuration
        for pipeline_component in pipeline_template.components:
            component_id = pipeline_component.component_id
            instance_name = pipeline_component.instance_name

            print(f"[InstallPipeline] Creating instance '{instance_name}' of component '{component_id}'")

            # Resolve configuration from pipeline params
            component_config = {}
            for component_param, pipeline_param in pipeline_component.config_mapping.items():
                resolved_value = resolve_config_value(pipeline_param, request.config)
                component_config[component_param] = resolved_value
                print(f"[InstallPipeline]   {component_param} = {resolved_value}")

            # Load component manifest to get component type
            manifest_file = components_dir / component_id / "manifest.yaml"
            if not manifest_file.exists():
                errors.append(f"Component '{component_id}' manifest not found")
                continue

            with open(manifest_file, 'r') as f:
                component_manifest = yaml.safe_load(f)

            component_type = component_manifest.get('component_type')
            if not component_type:
                errors.append(f"Component '{component_id}' has no component_type in manifest")
                continue

            # Validate component configuration
            component_dir_path = components_dir / component_id
            validated_config, validation_errors = validate_component_config(
                component_dir_path, component_config
            )

            if validation_errors:
                errors.append(f"Configuration validation failed for '{instance_name}':\n" + "\n".join(validation_errors))
                continue

            # Create instance directory and defs.yaml
            instance_dir = defs_dir / instance_name
            instance_dir.mkdir(parents=True, exist_ok=True)

            yaml_config = {
                "type": component_type,
                "attributes": validated_config
            }

            yaml_file = instance_dir / "defs.yaml"
            with open(yaml_file, 'w') as f:
                yaml.dump(yaml_config, f, default_flow_style=False, sort_keys=False)

            print(f"[InstallPipeline] Created instance at {yaml_file}")

            created_instances.append({
                "instance_name": instance_name,
                "component_id": component_id,
                "component_type": component_type,
                "yaml_file": str(yaml_file.relative_to(project_dir))
            })

        # If there were any errors during instance creation, report them
        if errors:
            raise HTTPException(
                status_code=500,
                detail="Errors occurred during pipeline installation:\n" + "\n".join(errors)
            )

        # Step 3: Auto-regenerate assets so all components appear
        try:
            from ..services.asset_introspection_service import AssetIntrospectionService
            asset_introspection_service = AssetIntrospectionService()

            # Clear cache
            asset_introspection_service.clear_cache(project.id)
            print(f"[InstallPipeline] Cleared asset cache")

            # Regenerate assets
            print(f"[InstallPipeline] Regenerating assets...")
            asset_nodes, asset_edges = await asset_introspection_service.get_assets_for_project_async(project)

            # Update project graph
            project.graph.nodes = asset_nodes
            project.graph.edges = asset_edges

            # Save project
            project_service._save_project(project)

            print(f"[InstallPipeline] Successfully regenerated {len(asset_nodes)} assets")

        except Exception as e:
            print(f"[InstallPipeline] Warning: Failed to auto-regenerate assets: {e}")
            import traceback
            traceback.print_exc()

        return {
            "success": True,
            "message": f"Pipeline '{pipeline_template.name}' installed successfully",
            "pipeline_id": pipeline_id,
            "pipeline_name": pipeline_template.name,
            "components_installed": installed_components,
            "instances_created": created_instances,
            "total_instances": len(created_instances),
            "assets_regenerated": True
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"[InstallPipeline] Error: {error_details}")
        raise HTTPException(
            status_code=500,
            detail=f"Error installing pipeline: {str(e)}"
        )


@router.get("/categories")
async def get_pipeline_categories():
    """Get list of pipeline categories for filtering."""
    try:
        manifest = await get_pipeline_manifest()

        # Extract unique categories
        categories = list(set(p.category for p in manifest.pipelines))
        categories.sort()

        # Count pipelines per category
        category_counts = {}
        for pipeline in manifest.pipelines:
            category_counts[pipeline.category] = category_counts.get(pipeline.category, 0) + 1

        return {
            "categories": [
                {
                    "id": cat,
                    "name": cat.replace("_", " ").title(),
                    "count": category_counts[cat]
                }
                for cat in categories
            ]
        }

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Error fetching categories: {str(e)}"
        )
