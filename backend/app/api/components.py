"""API endpoints for component registry."""

from fastapi import APIRouter, HTTPException

from ..models.component import ComponentRegistryResponse
from ..services.component_registry import component_registry

router = APIRouter(prefix="/components", tags=["components"])


@router.get("", response_model=ComponentRegistryResponse)
async def list_components(category: str | None = None):
    """List all available Dagster components.

    Args:
        category: Optional category filter (dbt, fivetran, sling, dlt)
    """
    if category:
        components = component_registry.get_components_by_category(category)
    else:
        components = component_registry.get_all_components()

    return ComponentRegistryResponse(
        components=components,
        total=len(components),
    )


@router.get("/{component_type:path}")
async def get_component(component_type: str, project_id: str | None = None):
    """Get a specific component by type.

    Args:
        component_type: Component type (e.g., dagster_dbt.DbtProjectComponent)
        project_id: Optional project ID to check for installed community components
    """
    # First check built-in component registry
    component = component_registry.get_component(component_type)

    # If not found by exact match, try fuzzy matching by class name
    # This handles project-specific module paths like "project_xxx.dagster_designer_components.DbtProjectWithTranslatorComponent"
    if not component:
        # Extract the class name from the component type
        class_name = component_type.split('.')[-1] if '.' in component_type else component_type

        # Try to find a component with matching class name
        all_components = component_registry.get_all_components()
        for comp in all_components:
            comp_class_name = comp.type.split('.')[-1] if '.' in comp.type else comp.type
            if comp_class_name == class_name:
                component = comp
                break

    if not component and project_id:
        # Check for installed community component
        from ..services.project_service import project_service
        from pathlib import Path
        import yaml

        project = project_service.get_project(project_id)
        if project:
            project_dir = project_service._get_project_dir(project)
            # Use the actual directory name from the project, not just the sanitized name
            # The directory name includes the project ID prefix (e.g., project_acaa97f2_my_test_project)
            directory_name = project.directory_name

            # Try both flat and src layouts
            flat_components_dir = project_dir / directory_name / "components"
            src_components_dir = project_dir / "src" / directory_name / "components"

            components_dir = None
            if flat_components_dir.exists():
                components_dir = flat_components_dir
            elif src_components_dir.exists():
                components_dir = src_components_dir

            if components_dir:
                # Extract component_id from component_type
                # e.g., "dagster_snowflake_dbt_demo.components.rest_api_fetcher.RestApiFetcher" -> "rest_api_fetcher"
                parts = component_type.split('.')
                if 'components' in parts:
                    idx = parts.index('components')
                    if idx + 1 < len(parts):
                        component_id = parts[idx + 1]
                        component_dir = components_dir / component_id

                        # First check if schema.json exists (from installed community component)
                        schema_file = component_dir / "schema.json"
                        if schema_file.exists():
                            try:
                                import json
                                with open(schema_file, 'r') as f:
                                    schema_data = json.load(f)

                                # Also get manifest data if available
                                manifest_file = component_dir / "manifest.yaml"
                                manifest_data = {}
                                if manifest_file.exists():
                                    with open(manifest_file, 'r') as f:
                                        manifest_data = yaml.safe_load(f)

                                from ..models.component import ComponentSchema
                                return ComponentSchema(
                                    name=manifest_data.get('name', component_id),
                                    type=component_type,
                                    category=manifest_data.get('category', 'unknown'),
                                    module='community',
                                    description=manifest_data.get('description', ''),
                                    icon='package',
                                    schema=schema_data
                                )
                            except Exception as e:
                                print(f"Error loading schema.json for {component_id}: {e}")
                                import traceback
                                traceback.print_exc()
                                # Fall through to AST parsing

                        manifest_file = component_dir / "manifest.yaml"
                        if manifest_file.exists():
                            try:
                                with open(manifest_file, 'r') as f:
                                    manifest_data = yaml.safe_load(f)

                                # Try to dynamically load the component class to get schema
                                from ..models.component import ComponentSchema
                                component_file = component_dir / f"{component_id}.py"

                                # Generate schema from Pydantic model fields
                                schema = {
                                    "properties": {},
                                    "required": []
                                }

                                # Parse the Python file using AST to extract Pydantic fields
                                try:
                                    import ast

                                    with open(component_file, 'r') as f:
                                        source_code = f.read()

                                    tree = ast.parse(source_code)

                                    # Find the component class
                                    class_name = parts[-1]  # Last part is class name

                                    for node in ast.walk(tree):
                                        if isinstance(node, ast.ClassDef) and node.name == class_name:
                                            # Extract field annotations
                                            for item in node.body:
                                                if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                                                    field_name = item.target.id

                                                    # Skip internal/inherited fields
                                                    if field_name.startswith('_') or field_name in ['model_config', 'model_fields']:
                                                        continue

                                                    # Extract type from annotation
                                                    field_type = 'string'
                                                    is_required = True

                                                    # Check if Optional (Union with None)
                                                    if isinstance(item.annotation, ast.Subscript):
                                                        if isinstance(item.annotation.value, ast.Name):
                                                            if item.annotation.value.id == 'Optional':
                                                                is_required = False

                                                            # Get the actual type
                                                            if hasattr(item.annotation, 'slice'):
                                                                if isinstance(item.annotation.slice, ast.Name):
                                                                    type_name = item.annotation.slice.id
                                                                    if type_name in ['int', 'float']:
                                                                        field_type = 'number'
                                                                    elif type_name == 'bool':
                                                                        field_type = 'boolean'
                                                    elif isinstance(item.annotation, ast.Name):
                                                        type_name = item.annotation.id
                                                        if type_name in ['int', 'float']:
                                                            field_type = 'number'
                                                        elif type_name == 'bool':
                                                            field_type = 'boolean'

                                                    # Extract description from Field() call
                                                    description = ""
                                                    if item.value and isinstance(item.value, ast.Call):
                                                        if isinstance(item.value.func, ast.Name) and item.value.func.id == 'Field':
                                                            for keyword in item.value.keywords:
                                                                if keyword.arg == 'description':
                                                                    if isinstance(keyword.value, ast.Constant):
                                                                        description = keyword.value.value
                                                                elif keyword.arg == 'default':
                                                                    # Has default, so not required
                                                                    is_required = False

                                                    # Try to extract enum values from description
                                                    # Look for patterns like: 'option1', 'option2', 'option3'
                                                    # or: "option1", "option2", "option3"
                                                    # or: GET, POST, PUT, DELETE (uppercase words)
                                                    import re
                                                    enum_values = []
                                                    if description:
                                                        # First try: Match quoted values
                                                        matches = re.findall(r"['\"]([^'\"]+)['\"]", description)
                                                        if matches and len(matches) > 1:
                                                            enum_values = matches
                                                        # Second try: Match uppercase words in comma-separated list
                                                        # Pattern: word(, word)+ followed by optional ", etc."
                                                        elif re.search(r'\b[A-Z]{2,}(?:,\s*[A-Z]{2,})+(?:,\s*etc\.?)?', description):
                                                            matches = re.findall(r'\b([A-Z]{2,})\b', description)
                                                            # Filter out common words like "HTTP", "API", etc.
                                                            filtered = [m for m in matches if m not in ['HTTP', 'API', 'URL', 'JSON', 'CSV', 'XML']]
                                                            if len(filtered) > 1:
                                                                enum_values = filtered

                                                    field_schema = {
                                                        "type": field_type,
                                                        "description": description
                                                    }

                                                    if enum_values:
                                                        field_schema["enum"] = enum_values

                                                    schema["properties"][field_name] = field_schema

                                                    if is_required:
                                                        schema["required"].append(field_name)

                                            break

                                except Exception as e:
                                    print(f"Could not parse component schema: {e}")
                                    import traceback
                                    traceback.print_exc()

                                component = ComponentSchema(
                                    name=manifest_data.get('name', component_id.replace('_', ' ').title()),
                                    module="community",
                                    type=component_type,
                                    description=manifest_data.get('description', ''),
                                    schema=schema,
                                    category=manifest_data.get('category', 'community'),
                                    icon="package"
                                )
                            except Exception as e:
                                print(f"Error loading community component: {e}")
                                import traceback
                                traceback.print_exc()

    if not component:
        raise HTTPException(status_code=404, detail="Component not found")

    return component
