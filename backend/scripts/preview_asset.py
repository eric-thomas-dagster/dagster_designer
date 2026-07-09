"""
Script to execute an asset and return its data for preview.
Runs in the project's Python environment to access custom components.
"""
import sys
import json
import traceback
import warnings
from pathlib import Path

# Suppress warnings that would interfere with JSON output
warnings.filterwarnings('ignore')

# Marker used when we detect an asset that can't be previewed by calling its
# compute function in-process (e.g. @dbt_assets — needs a real Dagster context
# with resources and often shells out to subprocesses). Callers check for this
# and surface a friendly error instead of trying + crashing.
_MULTIKEY_SENTINEL = object()


def _try_sql_transformer_output_preview(project_module: str, asset_key: str, row_limit: int = 100):
    """If this asset was created by SqlTransformerComponent, we know exactly
    which table it wrote — read `defs.yaml` and query it directly. This is
    the correct preview path for our in-warehouse transforms: no dbt CLI,
    no heuristic table-name guessing.

    Returns a preview dict on success, None if the asset isn't a
    SqlTransformer (so callers can fall back to other strategies).
    """
    import yaml
    from pathlib import Path as _Path

    # defs.yaml lives at <project_module>/defs/<asset_key_normalized>/defs.yaml
    # Search a couple of common project layouts.
    asset_dir = asset_key.replace('/', '_')
    candidates = [
        _Path(f"projects/{project_module}/src/{project_module}/defs/{asset_dir}/defs.yaml"),
        _Path(f"projects/{project_module}/src/{project_module}/defs/{asset_key}/defs.yaml"),
        _Path(f"{project_module}/defs/{asset_dir}/defs.yaml"),
    ]
    defs_yaml_path = next((p for p in candidates if p.exists()), None)
    if defs_yaml_path is None:
        return None

    try:
        cfg = yaml.safe_load(defs_yaml_path.read_text()) or {}
    except Exception:
        return None

    component_type = str(cfg.get('type', ''))
    if 'SqlTransformerComponent' not in component_type:
        return None

    attrs = cfg.get('attributes') or {}
    output_schema = attrs.get('output_schema', 'main')
    output_name = attrs.get('asset_name') or asset_key.rsplit('/', 1)[-1]

    # Reuse the SqlTransformer's own connection resolver so we hit the exact
    # same warehouse file/URL the component wrote to (no CWD divergence).
    try:
        import importlib
        st_mod = importlib.import_module(f"{project_module}.dagster_designer_components.sql_transformer")
        resolve = getattr(st_mod, '_resolve_engine')
    except Exception:
        return None

    conn_cfg = {
        'connection_url': attrs.get('connection_url'),
        'connection_url_env_var': attrs.get('connection_url_env_var'),
    }
    try:
        engine = resolve(conn_cfg)
    except Exception as e:
        return {"success": False, "error": f"SqlTransformer preview: couldn't resolve engine: {e}"}

    try:
        from sqlalchemy import text
        with engine.connect() as conn:
            cursor = conn.execute(
                text(f'SELECT * FROM "{output_schema}"."{output_name}" LIMIT {row_limit}')
            )
            rows = cursor.fetchall()
            columns = list(cursor.keys())
            try:
                desc = conn.execute(text(f'DESCRIBE "{output_schema}"."{output_name}"')).fetchall()
                dtypes = {r[0]: r[1] for r in desc if r[0] in columns}
            except Exception:
                dtypes = {c: '' for c in columns}
    except Exception as e:
        return {
            "success": False,
            "error": (
                f"SqlTransformer output table \"{output_schema}\".\"{output_name}\" "
                f"couldn't be read: {e}. Click Run to here to materialize it first."
            ),
        }

    data = [
        {
            columns[i]: (v if _json_safe(v) else str(v))
            for i, v in enumerate(row)
        }
        for row in rows
    ]
    return {
        "success": True,
        "data": data,
        "columns": columns,
        "dtypes": dtypes,
        "row_count": len(rows),
        "column_count": len(columns),
        "shape": [len(rows), len(columns)],
        "source": f"SqlTransformer:{output_schema}.{output_name}",
    }


def _try_duckdb_preview(asset_key: str, row_limit: int = 100):
    """For dbt-on-DuckDB projects (Jaffle Shop, etc.): after `dg launch` has
    materialized the asset, the data lives in a `.duckdb` file the dbt profile
    points at. Walk from cwd to find one and query the table matching the
    asset key. Returns a dict shaped like the DataFrame branch of main(),
    or None if nothing works.
    """
    import os
    from pathlib import Path as _Path

    # Candidate table names to try — asset_key can be multi-segment like
    # "seeds/raw_customers", and dbt materializes tables by their model name
    # (final segment). Try a few normalizations.
    last_segment = asset_key.rsplit('/', 1)[-1]
    candidates = [
        last_segment,
        asset_key.replace('/', '_'),
        asset_key,
    ]
    # De-dupe while preserving order.
    seen = set()
    candidates = [c for c in candidates if not (c in seen or seen.add(c))]

    # Find .duckdb files near cwd (dbt profiles.yml usually points at one via
    # a relative path — safer to just search for the file directly).
    cwd = _Path(os.getcwd())
    duckdb_paths = []
    for root in [cwd, *cwd.parents[:3]]:
        for p in root.glob("**/*.duckdb"):
            if any(part in {".venv", "node_modules", "__pycache__"} for part in p.parts):
                continue
            duckdb_paths.append(p)
        if duckdb_paths:
            break
    if not duckdb_paths:
        return None

    try:
        import duckdb  # type: ignore
    except ImportError:
        return None

    for db_path in duckdb_paths:
        try:
            con = duckdb.connect(str(db_path), read_only=True)
        except Exception:
            continue
        try:
            # Discover the schema list once so we can hit the right one.
            schemas = [
                r[0] for r in con.execute(
                    "SELECT DISTINCT schema_name FROM information_schema.schemata"
                ).fetchall()
            ] or ['main']
            for schema in schemas:
                if schema in ('information_schema', 'pg_catalog'):
                    continue
                for table in candidates:
                    try:
                        # `fetchdf()` requires numpy which isn't guaranteed in
                        # every project's venv (Jaffle Shop's minimal env
                        # doesn't have it). Use raw tuples + cursor metadata.
                        cursor = con.execute(
                            f'SELECT * FROM "{schema}"."{table}" LIMIT {row_limit}'
                        )
                    except Exception:
                        continue
                    rows = cursor.fetchall()
                    description = cursor.description or []
                    columns = [d[0] for d in description]
                    # duckdb's cursor.description type codes aren't very
                    # descriptive — get proper column types via DESCRIBE.
                    try:
                        type_rows = con.execute(
                            f'DESCRIBE "{schema}"."{table}"'
                        ).fetchall()
                        dtypes = {r[0]: r[1] for r in type_rows if r[0] in columns}
                    except Exception:
                        dtypes = {c: '' for c in columns}
                    data = [
                        {
                            columns[i]: (v if _json_safe(v) else str(v))
                            for i, v in enumerate(row)
                        }
                        for row in rows
                    ]
                    return {
                        "success": True,
                        "data": data,
                        "columns": columns,
                        "dtypes": dtypes,
                        "row_count": len(rows),
                        "column_count": len(columns),
                        "shape": [len(rows), len(columns)],
                        "source": f"duckdb:{db_path.name}:{schema}.{table}",
                    }
        finally:
            con.close()

    return None


def _json_safe(v):
    """Return True if `v` will round-trip through json.dumps as-is. Anything
    else (Decimal, datetime, bytes, UUID) we coerce via str() at the call site."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return True
    return False


def _try_dbt_show_preview(asset_key: str, row_limit: int = 100):
    """General fallback for dbt models across any adapter (Postgres, Snowflake,
    BigQuery, etc.): shell out to `dbt show --select <model>` and parse the
    JSON. Slower than a direct DuckDB read (~5s cold start) but reuses dbt's
    entire connection/credential/dialect stack — including env var
    interpolation like `{{ env_var('SNOWFLAKE_PASSWORD') }}`.

    Returns a preview dict or None if dbt isn't available / no project found /
    the model wasn't built yet.
    """
    import os
    import subprocess as _sp
    from pathlib import Path as _Path

    # Find the dbt project (has dbt_project.yml). Look near cwd first, then
    # walk down into project subdirs (Jaffle Shop has it in ./jaffle-shop-classic/).
    cwd = _Path(os.getcwd())
    candidates = [cwd, *cwd.parents[:2]]
    dbt_project_dir = None
    for root in candidates:
        for p in root.glob("**/dbt_project.yml"):
            if any(part in {".venv", "node_modules", "__pycache__", ".dbt"} for part in p.parts):
                continue
            dbt_project_dir = p.parent
            break
        if dbt_project_dir:
            break
    if dbt_project_dir is None:
        return None

    # Profiles: usually in the same directory as dbt_project.yml (per dbt-
    # cookiecutter conventions), else the user's ~/.dbt/.
    profiles_dir = dbt_project_dir if (dbt_project_dir / "profiles.yml").exists() else None

    # Model name is the last segment of the asset key (dbt models are
    # identified by their name, not their path).
    model_name = asset_key.rsplit('/', 1)[-1]

    # Locate the dbt binary — this script already runs in the project's
    # own venv (set by assets.py) so `dbt` should be next to `python`.
    dbt_bin = _Path(sys.executable).parent / "dbt"
    if not dbt_bin.exists():
        return None

    cmd = [
        str(dbt_bin), "--quiet", "show",
        "--select", model_name,
        "--limit", str(row_limit),
        "--output", "json",
        "--project-dir", str(dbt_project_dir),
    ]
    if profiles_dir:
        cmd.extend(["--profiles-dir", str(profiles_dir)])

    try:
        result = _sp.run(cmd, capture_output=True, text=True, timeout=180)
    except _sp.TimeoutExpired:
        return {"success": False, "error": f"dbt show timed out after 180s for {model_name}"}
    except Exception:
        return None

    stdout = result.stdout or ""
    # `dbt --quiet show` emits pure JSON on stdout; grab from first `{`.
    brace = stdout.find('{')
    if brace < 0:
        # Failure — surface dbt's own error (typically indicates the model
        # isn't materialized yet or has an upstream that isn't built).
        tail = (result.stderr or stdout or 'unknown error').strip().splitlines()[-5:]
        return {
            "success": False,
            "error": f"dbt show couldn't preview '{model_name}': {' | '.join(tail)}",
        }

    try:
        payload = json.loads(stdout[brace:])
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"dbt show returned unparseable JSON: {e}"}

    rows = payload.get("show") or []
    columns = list(rows[0].keys()) if rows else []
    # Coerce non-JSON-safe values (Decimal, datetime, bytes) to strings.
    data = [
        {c: (v if _json_safe(v) else str(v)) for c, v in row.items()}
        for row in rows
    ]
    return {
        "success": True,
        "data": data,
        "columns": columns,
        "dtypes": {c: '' for c in columns},  # dbt show doesn't return types
        "row_count": len(data),
        "column_count": len(columns),
        "shape": [len(data), len(columns)],
        "source": f"dbt show:{model_name}",
    }


def create_mock_context():
    """Create a mock context for asset execution."""
    class SimpleMockContext:
        def __init__(self):
            self.log = self.SimpleLogger()
            self.has_partition_key = False
            self.partition_key = None
            self._output_metadata = {}
            self.resources = {}

        def add_output_metadata(self, metadata, output_name=None):
            if output_name:
                self._output_metadata[output_name] = metadata
            else:
                self._output_metadata.update(metadata)

        class SimpleLogger:
            def info(self, msg): pass
            def warning(self, msg): pass
            def error(self, msg): pass
            def debug(self, msg): pass

    return SimpleMockContext()


def execute_asset_dependencies(defs, asset_key: str, executed_results: dict, visiting: set | None = None):
    """
    Recursively execute upstream dependencies of an asset AND the asset itself.
    Returns a dict of asset_key -> result.

    `visiting` tracks the current recursion stack so we don't loop forever when
    a multi-key AssetsDefinition (e.g. `@dbt_assets`) reports intra-group keys
    in its `dependency_keys` — asking for A's deps returns the whole group's
    dep set, which includes B (also in the group), whose deps include A, etc.
    """
    if visiting is None:
        visiting = set()

    # Skip if already executed OR currently being visited (cycle guard).
    if asset_key in executed_results or asset_key in visiting:
        return executed_results
    visiting.add(asset_key)

    # Get all assets
    all_assets = []
    if hasattr(defs, 'assets') and defs.assets:
        all_assets.extend(defs.assets)

    # Find the target asset
    target_asset_def = None
    for asset_group in all_assets:
        if hasattr(asset_group, 'keys'):
            for key in asset_group.keys:
                if key.to_user_string() == asset_key or key.to_user_string().replace('/', '_') == asset_key:
                    target_asset_def = asset_group
                    break
        if target_asset_def:
            break

    if not target_asset_def:
        visiting.discard(asset_key)
        return executed_results

    # Multi-key AssetsDefinition (@dbt_assets, factory-generated groups, etc.)
    # can't be executed by calling `op.compute_fn` in-process with a mock
    # context — they need real resources (DbtCliResource, etc.) and often
    # shell out to subprocesses. Bail early with a marker so main() can
    # produce a friendly error instead of trying and infinite-looping.
    keys_in_group = list(getattr(target_asset_def, 'keys', []) or [])
    if len(keys_in_group) > 1:
        executed_results[asset_key] = _MULTIKEY_SENTINEL
        visiting.discard(asset_key)
        return executed_results

    # First, execute all dependencies of this asset
    if hasattr(target_asset_def, 'dependency_keys'):
        dep_keys = target_asset_def.dependency_keys or set()

        # Execute each dependency recursively
        for dep_key in dep_keys:
            dep_key_str = dep_key.to_user_string()
            # Recursively execute this dependency and its dependencies
            execute_asset_dependencies(defs, dep_key_str, executed_results, visiting)

    # Now execute the target asset itself
    if hasattr(target_asset_def, 'op'):
        try:
            # Get the function
            func = target_asset_def.op.compute_fn
            # Unwrap DecoratedOpFunction or other wrappers
            if hasattr(func, 'decorated_fn'):
                func = func.decorated_fn
            # Continue unwrapping if there are more layers
            while hasattr(func, '__wrapped__'):
                func = func.__wrapped__

            # Execute with mock context
            context = create_mock_context()

            # Build kwargs from already executed dependencies
            import inspect
            sig = inspect.signature(func)
            kwargs = {}

            # Check if function has **kwargs parameter (VAR_KEYWORD)
            has_var_keyword = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())

            if has_var_keyword:
                # Function accepts **kwargs - pass all executed results
                for exec_key, exec_result in executed_results.items():
                    param_name = exec_key.replace('/', '_')
                    kwargs[param_name] = exec_result
            else:
                # Function has specific parameters - match them individually
                for param_name in sig.parameters:
                    if param_name == 'context':
                        continue
                    # Look for this param in executed results
                    for exec_key, exec_result in executed_results.items():
                        if param_name == exec_key.replace('/', '_') or param_name == exec_key:
                            kwargs[param_name] = exec_result
                            break

            result = func(context, **kwargs)
            executed_results[asset_key] = result
        except Exception as e:
            print(f"Warning: Failed to execute asset {asset_key}: {e}", file=sys.stderr)

    return executed_results


def get_upstream_asset_keys_from_config(project_module, asset_key):
    """
    Check if the asset has upstream_asset_keys configured in its defs.yaml.
    Returns a list of upstream asset keys if configured, None otherwise.
    """
    try:
        import yaml
        from pathlib import Path

        # Normalize asset key for directory name
        asset_dir_name = asset_key.replace('/', '_')

        # Try to find the defs.yaml file
        defs_yaml_path = Path(f"projects/{project_module}/src/{project_module}/defs/{asset_dir_name}/defs.yaml")
        if not defs_yaml_path.exists():
            # Try without projects prefix (might be running from different location)
            defs_yaml_path = Path(f"{project_module}/defs/{asset_dir_name}/defs.yaml")
            if not defs_yaml_path.exists():
                return None

        with open(defs_yaml_path, 'r') as f:
            config = yaml.safe_load(f)

        if not config or 'attributes' not in config:
            return None

        upstream_keys_str = config['attributes'].get('upstream_asset_keys')
        if upstream_keys_str:
            # Parse comma-separated list
            return [k.strip() for k in upstream_keys_str.split(',')]

        return None
    except Exception as e:
        # Silently ignore errors - asset might not have config file
        return None


def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "success": False,
            "error": "Usage: python -m scripts.preview_asset <project_module> <asset_key>"
        }))
        sys.exit(1)

    project_module = sys.argv[1]
    asset_key = sys.argv[2]

    try:
        # Import the definitions module
        import importlib
        definitions_module = importlib.import_module(f"{project_module}.definitions")
        defs = definitions_module.defs

        # Find the asset by key
        all_assets = []
        if hasattr(defs, 'assets') and defs.assets:
            all_assets.extend(defs.assets)

        found_asset = None
        asset_def = None

        for asset_group in all_assets:
            if hasattr(asset_group, 'keys'):
                for key in asset_group.keys:
                    key_str = key.to_user_string()
                    if key_str == asset_key or key_str.replace('/', '_') == asset_key:
                        found_asset = key
                        asset_def = asset_group
                        break
            if found_asset:
                break

        if not found_asset:
            print(json.dumps({
                "success": False,
                "error": f"Asset '{asset_key}' not found"
            }))
            sys.exit(1)

        # If the target lives inside a multi-key AssetsDefinition (e.g. dbt
        # assets, factory-generated groups), we can't reconstruct a compute
        # for a single key by mocking a context. But if the user has already
        # materialized it via "Run to here", the data is sitting in the
        # underlying store — for dbt-on-DuckDB projects that's a `.duckdb`
        # file we can read directly. Try that; fall back to a helpful error.
        keys_in_group = list(getattr(asset_def, 'keys', []) or [])
        if len(keys_in_group) > 1:
            # 1) DuckDB fast path — <100ms if the model has been materialized
            #    into a `.duckdb` file that lives next to the project.
            duckdb_result = _try_duckdb_preview(asset_key)
            if duckdb_result is not None:
                print(json.dumps(duckdb_result))
                sys.exit(0)

            # 2) `dbt show` general fallback — works for every adapter dbt
            #    supports (Postgres/Snowflake/BigQuery/Redshift/…). ~5s cold
            #    start but reuses dbt's full connection + credential stack.
            dbt_result = _try_dbt_show_preview(asset_key)
            if dbt_result is not None:
                print(json.dumps(dbt_result))
                sys.exit(0)

            group_kind = 'dbt project' if 'dbt' in type(asset_def).__module__.lower() else 'multi-asset group'
            other_keys = [k.to_user_string() for k in keys_in_group if k.to_user_string() != asset_key][:5]
            hint = f' Related keys in this group: {", ".join(other_keys)}.' if other_keys else ''
            print(json.dumps({
                "success": False,
                "error": (
                    f"Preview couldn't find materialized data for '{asset_key}'. "
                    f"It's part of a {group_kind} — click Run to here first to "
                    f"materialize it, then re-open the preview.{hint}"
                ),
            }))
            sys.exit(0)

        # Check if asset has upstream_asset_keys configuration
        configured_upstream_keys = get_upstream_asset_keys_from_config(project_module, asset_key)

        # Execute dependencies first
        executed_results = {}

        if configured_upstream_keys:
            # Asset has explicit upstream_asset_keys - materialize those specific assets
            for upstream_key in configured_upstream_keys:
                if upstream_key not in executed_results:
                    execute_asset_dependencies(defs, upstream_key, executed_results)
        else:
            # Fall back to automatic dependency resolution
            execute_asset_dependencies(defs, asset_key, executed_results)

        # Now execute the target asset
        if hasattr(asset_def, 'op'):
            func = asset_def.op.compute_fn

            # Unwrap DecoratedOpFunction or other wrappers
            if hasattr(func, 'decorated_fn'):
                func = func.decorated_fn

            # Continue unwrapping if there are more layers
            while hasattr(func, '__wrapped__'):
                func = func.__wrapped__

            # Create mock context
            context = create_mock_context()

            # Match parameters to executed dependencies
            import inspect
            sig = inspect.signature(func)
            kwargs = {}

            # Check if function has **kwargs parameter (VAR_KEYWORD)
            has_var_keyword = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())

            if has_var_keyword:
                # Function accepts **kwargs - pass all executed results as keyword arguments
                for exec_key, exec_result in executed_results.items():
                    # Normalize key for use as Python identifier
                    param_name = exec_key.replace('/', '_')
                    kwargs[param_name] = exec_result
            else:
                # Function has specific parameters - match them individually
                for param_name in sig.parameters:
                    if param_name == 'context':
                        continue
                    # Look for this param in executed results
                    for exec_key, exec_result in executed_results.items():
                        if param_name == exec_key.replace('/', '_') or param_name == exec_key:
                            kwargs[param_name] = exec_result
                            break

            # Execute the asset
            try:
                result = func(context, **kwargs)
            except Exception as e:
                # If it's a pandas UndefinedVariableError, add helpful context about available columns
                import pandas as pd
                if "UndefinedVariableError" in str(type(e).__name__) or "is not defined" in str(e):
                    # Try to find DataFrames in kwargs to show available columns
                    available_columns = {}
                    for key, value in kwargs.items():
                        if isinstance(value, pd.DataFrame):
                            available_columns[key] = list(value.columns)

                    error_msg = f"Column reference error in filter/transform: {str(e)}"
                    if available_columns:
                        error_msg += f"\n\nAvailable columns in upstream DataFrames:"
                        for df_name, cols in available_columns.items():
                            error_msg += f"\n  {df_name}: {cols}"

                    print(json.dumps({
                        "success": False,
                        "error": error_msg
                    }))
                    sys.exit(1)
                else:
                    raise

            # Convert result to JSON-serializable format
            if result is not None:
                import pandas as pd
                if isinstance(result, pd.DataFrame):
                    # Convert DataFrame to dict
                    data = result.to_dict('records')
                    columns = result.columns.tolist()
                    dtypes = {col: str(dtype) for col, dtype in result.dtypes.items()}

                    print(json.dumps({
                        "success": True,
                        "data": data,
                        "columns": columns,
                        "dtypes": dtypes,
                        "row_count": len(result),
                        "column_count": len(columns),
                        "shape": list(result.shape)
                    }))
                else:
                    print(json.dumps({
                        "success": False,
                        "error": f"Asset returned {type(result).__name__}, expected DataFrame"
                    }))
            else:
                # Asset function returned None. This is the normal case for
                # in-warehouse transforms (SqlTransformerComponent's asset
                # does CREATE TABLE AS SELECT with no return value) and for
                # sink components that write to disk. Try, in order:
                #   1. SqlTransformer-specific direct read (knows the exact
                #      output_schema.asset_name from defs.yaml, no guessing)
                #   2. DuckDB fast path (glob + naming heuristic)
                #   3. `dbt show` if a dbt profile is nearby (last resort)
                sql_r = _try_sql_transformer_output_preview(project_module, asset_key)
                if sql_r is not None:
                    print(json.dumps(sql_r))
                    sys.exit(0)
                duck = _try_duckdb_preview(asset_key)
                if duck is not None:
                    print(json.dumps(duck))
                    sys.exit(0)
                dbt_r = _try_dbt_show_preview(asset_key)
                if dbt_r is not None:
                    print(json.dumps(dbt_r))
                    sys.exit(0)
                print(json.dumps({
                    "success": False,
                    "error": (
                        "Asset returned None. This asset writes to a warehouse "
                        "or sink instead of returning a DataFrame — click Run "
                        "to here first, then re-open the preview so we can "
                        "read the materialized result."
                    ),
                }))
        else:
            print(json.dumps({
                "success": False,
                "error": "Asset definition has no executable function"
            }))

    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": f"Failed to execute asset: {str(e)}",
            "traceback": traceback.format_exc()
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
