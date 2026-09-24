"""API endpoints for component registry."""

import json
import os
import subprocess
import time

from fastapi import APIRouter, HTTPException

from ..core.uv_binary import venv_bin_path
from ..models.component import ComponentRegistryResponse, ComponentSchema
from ..services.component_registry import component_registry

router = APIRouter(prefix="/components", tags=["components"])


# Cache for `dg utils inspect-component` results -- a real subprocess call into
# the project's own venv. The schema can't change without the project's component
# code changing (which happens on save/reload, not while a config modal is open),
# so a short TTL avoids re-running it on every "Advanced" click without risking a
# stale schema surviving a real edit for long.
_dg_component_schema_cache: dict[tuple[str, str], tuple[float, "ComponentSchema | None"]] = {}
_DG_SCHEMA_CACHE_TTL_SECONDS = 30


def _normalize_json_schema_for_ui(schema, defs: dict, _depth: int = 0):
    """Collapses raw pydantic-v2 JSON Schema conventions into the flatter
    shape ComponentConfigModal already knows how to render (a `type` key
    directly on every field) -- the same shape Designer's built-in registry
    and the community schema.json convention both already use.

    Two conventions `dg utils inspect-component` emits that the modal's
    field-type dispatch (`fieldSchema.type`) can't see through on its own:

    1. `$ref` pointers into `$defs` for nested models (e.g. `workspace`'s
       FabricResource) -- left unresolved, the modal has no `type` or
       `properties` to render at all.
    2. `anyOf: [<real type>, {"type": "string"}]` on EVERY Component field,
       not just genuinely Optional ones -- this is Dagster's own
       "real value OR a `{{ env.VAR }}` template string" convention for
       Resolvable component fields, confirmed live against a real project
       (every one of demo_mode/workspace/assets_by_item_name/... has this
       shape). `fieldSchema.type` is undefined on the wrapper itself, so a
       boolean field fell through to a plain text input showing its raw
       Python-side default, and an object field rendered as
       "[object Object]" -- both symptoms the user hit live, both from this
       same cause. The real type is always the FIRST anyOf branch (`null`
       or the template-string `type: string` variant comes after), so
       picking branch 0 recovers the correct widget type both for this
       convention and for ordinary `Optional[X]` fields.
    """
    if _depth > 12 or not isinstance(schema, dict):
        return schema

    if "$ref" in schema:
        def_name = schema["$ref"].split("/")[-1]
        resolved = defs.get(def_name)
        if isinstance(resolved, dict):
            merged = {**resolved, **{k: v for k, v in schema.items() if k != "$ref"}}
            return _normalize_json_schema_for_ui(merged, defs, _depth + 1)
        return schema

    for union_key in ("anyOf", "oneOf"):
        branches = schema.get(union_key)
        if branches and "type" not in schema:
            non_null = [b for b in branches if isinstance(b, dict) and b.get("type") != "null"]
            if non_null:
                chosen = _normalize_json_schema_for_ui(dict(non_null[0]), defs, _depth + 1)
                merged = dict(chosen)
                for k, v in schema.items():
                    if k != union_key and k not in merged:
                        merged[k] = v
                return merged

    out = dict(schema)
    if isinstance(out.get("properties"), dict):
        out["properties"] = {
            k: _normalize_json_schema_for_ui(v, defs, _depth + 1)
            for k, v in out["properties"].items()
        }
    if isinstance(out.get("items"), dict):
        out["items"] = _normalize_json_schema_for_ui(out["items"], defs, _depth + 1)

    return out


def _get_component_schema_via_dg(project, component_type: str) -> "ComponentSchema | None":
    """Resolve a component's schema by asking the project's OWN `dg` CLI,
    instead of guessing from a checked-in schema.json (may not exist) or
    parsing Python source with `ast` (the pre-existing fallback below this
    function's call site -- fragile: no $ref resolution, no nested models,
    whole classes of pydantic field types silently mis-typed).

    `dg utils inspect-component <type> --defs-yaml-json-schema` runs the
    project's own component class through pydantic's real
    `model_json_schema()` and returns the exact schema `dg` itself uses --
    correct for ANY component `dg` can see in that venv, including a
    project-local subclass of a registry component (confirmed live: a demo
    project's `DemoFabricWorkspaceComponent`, which adds fields like
    `demo_mode`/`assets_by_item_name` over its parent, resolved with all of
    them present and correctly typed -- something no schema.json convention
    or AST parse could get right without being told about the subclass).
    """
    cache_key = (project.id, component_type)
    now = time.time()
    if cache_key in _dg_component_schema_cache:
        cached_at, cached_value = _dg_component_schema_cache[cache_key]
        if now - cached_at < _DG_SCHEMA_CACHE_TTL_SECONDS:
            return cached_value

    from ..services.project_service import project_service

    project_dir = project_service._get_project_dir(project)
    venv_dir = project_dir / ".venv"
    dg_path = venv_bin_path(venv_dir, "dg")
    if not dg_path.exists():
        _dg_component_schema_cache[cache_key] = (now, None)
        return None

    work_dir = project_dir
    if project.dagster_package_subdir:
        work_dir = project_dir / project.dagster_package_subdir

    env = os.environ.copy()
    env.pop("PYTHONHOME", None)
    env.pop("VIRTUAL_ENV", None)
    env["PATH"] = f"{dg_path.parent}{os.pathsep}{env.get('PATH', '')}"

    try:
        result = subprocess.run(
            [str(dg_path.resolve()), "utils", "inspect-component", component_type, "--defs-yaml-json-schema"],
            cwd=str(work_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, OSError):
        _dg_component_schema_cache[cache_key] = (now, None)
        return None

    if result.returncode != 0:
        _dg_component_schema_cache[cache_key] = (now, None)
        return None

    try:
        full_schema = json.loads(result.stdout)
        attributes_schema = full_schema.get("properties", {}).get("attributes")
        if not isinstance(attributes_schema, dict):
            _dg_component_schema_cache[cache_key] = (now, None)
            return None

        # `dg` splits nested-model $defs between the outer envelope
        # (type + attributes) and the attributes sub-schema itself, but every
        # $ref inside `attributes` uses the same "#/$defs/X" form regardless
        # of which bucket its target actually landed in -- confirmed live.
        # Merging both into one $defs at the level we're returning
        # (attributes) makes every $ref resolvable there instead of only some.
        merged_defs = {**full_schema.get("$defs", {}), **attributes_schema.get("$defs", {})}
        schema_out = dict(attributes_schema)
        if isinstance(schema_out.get("properties"), dict):
            schema_out["properties"] = {
                field_name: _normalize_json_schema_for_ui(field_schema, merged_defs)
                for field_name, field_schema in schema_out["properties"].items()
            }
        if merged_defs:
            schema_out["$defs"] = merged_defs

        component = ComponentSchema(
            name=component_type.split(".")[-1],
            type=component_type,
            module="project",
            category="custom",
            description=full_schema.get("description") or None,
            icon="package",
            schema=schema_out,
        )
        _dg_component_schema_cache[cache_key] = (now, component)
        return component
    except (json.JSONDecodeError, AttributeError):
        _dg_component_schema_cache[cache_key] = (now, None)
        return None


# Cache for `dg list components` results, same rationale as the schema cache above.
_dg_project_components_cache: dict[str, tuple[float, list[dict]]] = {}
_DG_LIST_CACHE_TTL_SECONDS = 30


@router.get("/project/{project_id}/custom")
async def list_project_custom_components(project_id: str):
    """List component types defined by the project's OWN code -- not
    Designer's built-in registry, not a community-installed component (both
    already covered by the palette's other sections).

    `dg list components --json` enumerates every component type visible in
    the project's venv, which includes framework/vendor components it
    happens to depend on (dagster.*, dagster_dbt.*, ...) alongside anything
    the project itself defines. Filtering to keys under the project's own
    root_module namespace (e.g. "stellantis_financial_services.") isolates
    just the hand-written ones -- confirmed live, this correctly picks out
    a project's own DemoFabricWorkspaceComponent while excluding the
    dozens of dagster.* built-ins the same `dg list components` call
    also returns for that project.
    """
    from ..services.project_service import project_service

    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    now = time.time()
    if project_id in _dg_project_components_cache:
        cached_at, cached_value = _dg_project_components_cache[project_id]
        if now - cached_at < _DG_LIST_CACHE_TTL_SECONDS:
            return {"components": cached_value}

    project_dir = project_service._get_project_dir(project)
    venv_dir = project_dir / ".venv"
    dg_path = venv_bin_path(venv_dir, "dg")
    if not dg_path.exists():
        return {"components": []}

    root_module = project_service.get_project_root_module(project)
    work_dir = project_dir / project.dagster_package_subdir if project.dagster_package_subdir else project_dir

    env = os.environ.copy()
    env.pop("PYTHONHOME", None)
    env.pop("VIRTUAL_ENV", None)
    env["PATH"] = f"{dg_path.parent}{os.pathsep}{env.get('PATH', '')}"

    try:
        result = subprocess.run(
            [str(dg_path.resolve()), "list", "components", "--json"],
            cwd=str(work_dir),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, OSError):
        return {"components": []}

    if result.returncode != 0:
        return {"components": []}

    try:
        items = json.loads(result.stdout).get("items", [])
    except json.JSONDecodeError:
        return {"components": []}

    prefix = f"{root_module}."
    custom = [
        {
            "type": item["key"],
            "name": item["key"].rsplit(".", 1)[-1],
            "description": (item.get("summary") or "").split("\n\n")[0],
            "category": "custom",
            "icon": "package",
        }
        for item in items
        if isinstance(item.get("key"), str) and item["key"].startswith(prefix)
    ]
    _dg_project_components_cache[project_id] = (now, custom)
    return {"components": custom}


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

    # If project_id not provided but component_type looks project-specific, try to extract project from type
    if not project_id and '.' in component_type and 'components' in component_type:
        # Extract directory name from component type like "project_xxx_yyy.components.foo.FooComponent"
        parts = component_type.split('.')
        if parts[0].startswith('project_'):
            directory_name = parts[0]
            # Find project by directory_name
            from ..services.project_service import project_service
            for proj in project_service.projects.values():
                if proj.directory_name == directory_name:
                    project_id = proj.id
                    break

    if not component and project_id:
        # Check for installed community component
        from ..services.project_service import project_service
        from ..services.designer_loc_service import get_state as _get_sandbox_state
        from pathlib import Path
        import yaml

        project = project_service.get_project(project_id)
        if project:
            # Try the project's own `dg` CLI first -- accurate for ANY
            # component dg can see in that venv (built-in, community-
            # installed, or a hand-written project-local class/subclass),
            # and doesn't depend on a schema.json existing on disk at all.
            # Falls through to the schema.json / AST-parsing paths below
            # only if this project has no usable venv yet or dg doesn't
            # recognize the type for some other reason.
            dg_schema = _get_component_schema_via_dg(project, component_type)
            if dg_schema:
                return dg_schema

            project_dir = project_service._get_project_dir(project)
            # Use the actual directory name from the project, not just the sanitized name
            # The directory name includes the project ID prefix (e.g., project_acaa97f2_my_test_project)
            directory_name = project.directory_name

            # Community components installed via `dagster-component add` land
            # in the Designer sandbox (`~/.dagster-designer/designer-locs/ds_<pid>/`),
            # NOT the project backend dir. Check the sandbox first — a fresh
            # install lives there and only there until it's promoted to the
            # project repo. Falling back to the project dir catches the case
            # where the user has already promoted the component into their repo.
            sandbox_dir = _get_sandbox_state(project_id).dir()
            sandbox_module = sandbox_dir.name
            sandbox_components_dir = sandbox_dir / "src" / sandbox_module / "components"

            components_dir = None
            if sandbox_components_dir.exists():
                components_dir = sandbox_components_dir
            elif (flat := project_dir / directory_name / "components").exists():
                components_dir = flat
            elif (src := project_dir / "src" / directory_name / "components").exists():
                components_dir = src

            if components_dir:
                # Locate the component's directory. Two supported shapes:
                #   1. Fully-qualified module path, e.g.
                #      "<pkg>.components.rest_api_fetcher.RestApiFetcher"
                #      → `component_id = "rest_api_fetcher"`
                #   2. Community catalog type, e.g.
                #      "dagster_component_templates.CronScheduleComponent"
                #      → no `.components.` segment; match against each
                #        installed component's `schema.json[component_type]`.
                # The second case is how the community palette exposes types,
                # so it's the common path for anything installed via
                # `dagster-component add`.
                import json as _json
                parts = component_type.split('.')
                component_id: str | None = None

                if 'components' in parts:
                    idx = parts.index('components')
                    if idx + 1 < len(parts):
                        component_id = parts[idx + 1]

                if component_id is None and components_dir.exists():
                    for candidate in components_dir.iterdir():
                        if not candidate.is_dir():
                            continue
                        schema_file = candidate / "schema.json"
                        if not schema_file.exists():
                            continue
                        try:
                            with open(schema_file, 'r') as f:
                                schema_probe = _json.load(f)
                        except Exception:
                            continue
                        if schema_probe.get('component_type') == component_type:
                            component_id = candidate.name
                            break

                if component_id:
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

                                # Transform schema format: convert "attributes" to "properties" for JSON Schema compatibility
                                transformed_schema = {}
                                if 'attributes' in schema_data:
                                    transformed_schema['properties'] = schema_data['attributes']
                                    # Extract required fields
                                    required = []
                                    for field_name, field_def in schema_data['attributes'].items():
                                        if field_def.get('required'):
                                            required.append(field_name)
                                    if required:
                                        transformed_schema['required'] = required
                                    # x-dagster-io (input/output type contract, e.g. "dataframe")
                                    # was being silently dropped here -- it lives alongside
                                    # "attributes" in the source schema.json, not inside it, so
                                    # copying `attributes` alone left it out. The frontend's
                                    # asset pickers (ComponentConfigModal) rely on this to filter
                                    # to only DataFrame-producing upstream assets; without it
                                    # every asset in the project looked equally valid.
                                    if 'x-dagster-io' in schema_data:
                                        transformed_schema['x-dagster-io'] = schema_data['x-dagster-io']
                                else:
                                    # If already in correct format, use as-is
                                    transformed_schema = schema_data.get('schema', schema_data)

                                from ..models.component import ComponentSchema
                                return ComponentSchema(
                                    name=manifest_data.get('name', schema_data.get('name', component_id)),
                                    type=component_type,
                                    category=manifest_data.get('category', schema_data.get('category', 'unknown')),
                                    module='community',
                                    description=manifest_data.get('description', schema_data.get('description', '')),
                                    icon=schema_data.get('icon', 'package'),
                                    schema=transformed_schema
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
