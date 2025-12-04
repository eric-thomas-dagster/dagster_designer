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
from typing import List, Dict, Optional, Any
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
from .environment_config import resolve_environment_config, validate_environment_config

router = APIRouter(prefix="/pipeline-templates", tags=["pipeline-templates"])

# GitHub URL for pipeline templates manifest
PIPELINE_MANIFEST_URL = "https://raw.githubusercontent.com/eric-thomas-dagster/dagster-component-templates/main/pipelines/manifest.json"


class PipelineComponent(BaseModel):
    """A component within a pipeline template."""
    component_id: str
    instance_name: str
    config_mapping: Dict[str, Any]  # Maps pipeline params to component params (can be literals or ${var} references)
    depends_on: Optional[List[str]] = []  # List of instance names this depends on
    repeat_for: Optional[str] = None  # Pipeline param to iterate over (e.g., "${data_sources}")
    instance_name_template: Optional[str] = None  # Template for dynamic names (e.g., "{source}_data")


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
    config: Dict[str, Any]  # High-level pipeline configuration


@router.get("/manifest")
async def get_pipeline_manifest() -> PipelineManifest:
    """Fetch the pipeline templates manifest from GitHub."""
    try:
        async with httpx.AsyncClient() as client:
            # Add cache-busting headers to ensure fresh content from GitHub
            headers = {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache'
            }
            response = await client.get(PIPELINE_MANIFEST_URL, headers=headers, timeout=10.0)
            response.raise_for_status()
            data = response.json()

            # Validate pipelines individually to gracefully handle invalid entries
            valid_pipelines = []
            invalid_pipelines = []

            for pipeline_data in data.get('pipelines', []):
                try:
                    # Validate individual pipeline
                    pipeline = PipelineTemplate(**pipeline_data)
                    valid_pipelines.append(pipeline)
                except Exception as e:
                    # Log warning but don't fail entire manifest
                    pipeline_id = pipeline_data.get('id', 'unknown')
                    print(f"[WARNING] Invalid pipeline '{pipeline_id}' in manifest: {str(e)}")
                    invalid_pipelines.append({
                        'id': pipeline_id,
                        'error': str(e)
                    })

            # Log summary if any pipelines were invalid
            if invalid_pipelines:
                print(f"[WARNING] Filtered out {len(invalid_pipelines)} invalid pipelines from manifest:")
                for invalid in invalid_pipelines:
                    print(f"  - {invalid['id']}: {invalid['error']}")

            # Return manifest with only valid pipelines
            return PipelineManifest(
                version=data.get('version', '1.0.0'),
                repository=data.get('repository', ''),
                last_updated=data.get('last_updated', ''),
                pipelines=valid_pipelines
            )
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


def resolve_config_value(value: Any, pipeline_config: Dict, iteration_value: str = None) -> Any:
    """
    Resolve a configuration value that may reference pipeline-level params.

    Examples:
        "${data_source}" -> looks up pipeline_config["data_source"]
        "standardized_orders" -> returns as-is
        "{source}_data" with iteration_value="google_ads" -> "google_ads_data"
        "${prediction_period_months}" -> looks up pipeline_config["prediction_period_months"]
    """
    if not isinstance(value, str):
        return value

    # Handle template strings like {source}_data
    if iteration_value and "{" in value:
        value = value.replace("{source}", iteration_value)
        value = value.replace("{item}", iteration_value)

    # Handle pipeline parameter references like ${data_source}
    if value.startswith("${") and value.endswith("}"):
        param_name = value[2:-1]

        # Special syntax: ${param:*_suffix} means get all items from array and apply suffix
        if ":" in param_name:
            base_param, suffix_pattern = param_name.split(":", 1)
            if base_param in pipeline_config:
                param_value = pipeline_config[base_param]
                if isinstance(param_value, list):
                    # Return list of values with pattern applied
                    return [suffix_pattern.replace("*", item) for item in param_value]

        if param_name in pipeline_config:
            return pipeline_config[param_name]
        else:
            raise ValueError(f"Pipeline parameter '{param_name}' not provided in configuration")

    return value


def expand_dynamic_components(
    pipeline_component: PipelineComponent,
    pipeline_config: Dict
) -> List[Dict[str, Any]]:
    """
    Expand a component that uses repeat_for into multiple component instances.

    Args:
        pipeline_component: Component definition that may have repeat_for
        pipeline_config: Pipeline configuration

    Returns:
        List of expanded component instances
    """
    # If no repeat_for, return single component as-is
    if not pipeline_component.repeat_for:
        return [{
            "component_id": pipeline_component.component_id,
            "instance_name": pipeline_component.instance_name,
            "config_mapping": pipeline_component.config_mapping,
            "depends_on": pipeline_component.depends_on
        }]

    # Extract parameter name from ${param_name} syntax
    repeat_param = pipeline_component.repeat_for
    if repeat_param.startswith("${") and repeat_param.endswith("}"):
        repeat_param = repeat_param[2:-1]

    if repeat_param not in pipeline_config:
        raise ValueError(f"repeat_for parameter '{repeat_param}' not found in pipeline config")

    repeat_values = pipeline_config[repeat_param]
    if not isinstance(repeat_values, list):
        repeat_values = [repeat_values]

    # Create one component instance per value
    expanded_components = []
    for value in repeat_values:
        # Use template if provided, otherwise use instance_name
        instance_name = pipeline_component.instance_name_template or pipeline_component.instance_name
        instance_name = instance_name.replace("{source}", value).replace("{item}", value)

        # Resolve config with iteration value
        resolved_config = {}
        for key, config_value in pipeline_component.config_mapping.items():
            resolved_config[key] = resolve_config_value(config_value, pipeline_config, iteration_value=value)

        # Resolve depends_on with iteration value
        resolved_depends_on = []
        for dep in (pipeline_component.depends_on or []):
            if "{" in dep:
                resolved_depends_on.append(dep.replace("{source}", value).replace("{item}", value))
            else:
                resolved_depends_on.append(dep)

        expanded_components.append({
            "component_id": pipeline_component.component_id,
            "instance_name": instance_name,
            "config_mapping": resolved_config,
            "depends_on": resolved_depends_on
        })

    return expanded_components


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

        # Resolve environment-specific configuration
        # If config has "environments" structure, this merges shared + current environment
        # If config is flat (legacy), this returns it as-is
        resolved_config = resolve_environment_config(request.config)
        print(f"[InstallPipeline] Resolved config for current environment: {json.dumps(resolved_config, indent=2)}")

        # Use resolved config instead of request.config from here on
        pipeline_config = resolved_config

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

        # Step 1: Auto-install any missing components
        from .templates_registry import get_manifest as get_component_manifest, InstallComponentRequest

        component_manifest = await get_component_manifest()

        for pipeline_component in pipeline_template.components:
            component_id = pipeline_component.component_id
            component_dir = components_dir / component_id

            if not component_dir.exists():
                print(f"[InstallPipeline] Component {component_id} not found, installing it automatically...")

                # Find component in manifest
                component_template = next(
                    (c for c in component_manifest.components if c.id == component_id),
                    None
                )

                if not component_template:
                    errors.append(f"Component '{component_id}' not found in component library")
                    continue

                # Auto-install the component
                try:
                    from .templates_registry import install_component
                    install_request = InstallComponentRequest(
                        project_id=request.project_id,
                        config={}  # No config needed for component installation
                    )
                    await install_component(component_id, install_request)
                    installed_components.append(component_id)
                    print(f"[InstallPipeline] Component {component_id} installed successfully")
                except Exception as e:
                    errors.append(f"Failed to install component '{component_id}': {str(e)}")
                    continue
            else:
                print(f"[InstallPipeline] Component {component_id} already installed at {component_dir}")

        # If there were any errors during auto-installation, stop here
        if errors:
            raise HTTPException(
                status_code=400,
                detail="Failed to install required components:\n" + "\n".join(errors)
            )

        # Step 2: Expand dynamic components and create instances
        all_expanded_components = []
        for pipeline_component in pipeline_template.components:
            # Expand component if it uses repeat_for
            expanded = expand_dynamic_components(pipeline_component, pipeline_config)
            all_expanded_components.extend(expanded)

            if len(expanded) > 1:
                print(f"[InstallPipeline] Expanded {pipeline_component.component_id} into {len(expanded)} instances")

        # Step 3: Create component instances with resolved configuration
        for expanded_component in all_expanded_components:
            component_id = expanded_component["component_id"]
            instance_name = expanded_component["instance_name"]
            config_mapping = expanded_component["config_mapping"]

            print(f"[InstallPipeline] Creating instance '{instance_name}' of component '{component_id}'")

            # Resolve configuration from pipeline params (already resolved in expand_dynamic_components)
            component_config = {}
            for component_param, pipeline_param in config_mapping.items():
                resolved_value = resolve_config_value(pipeline_param, pipeline_config)
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
