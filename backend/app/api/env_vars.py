"""API endpoints for environment variable management."""

from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.config import settings
from ..core.uv_binary import venv_bin_path
from ..services.project_service import project_service
from ..services.dagster_plus_client import (
    query as dagster_plus_query,
    SECRETS_QUERY,
    CREATE_SECRET_MUTATION,
    UPDATE_SECRET_MUTATION,
    DELETE_SECRET_MUTATION,
    DagsterPlusError,
)

router = APIRouter(prefix="/env", tags=["env"])


class EnvVariable(BaseModel):
    """Environment variable model."""
    key: str
    value: str
    is_sensitive: bool = False


class CloudSecretScopes(BaseModel):
    """Mirrors Dagster+'s SecretScopesInput -- the granularity the user
    asked for (deployment / branch / local), distinct from `location_names`
    below which further restricts to specific code locations within
    whichever of these scopes is chosen."""
    full_deployment_scope: bool = False
    all_branch_deployments_scope: bool = False
    specific_branch_deployment_scope: str | None = None
    local_deployment_scope: bool = False


class CloudEnvVariable(EnvVariable):
    """A Dagster+ secret -- extends EnvVariable (same key/value/is_sensitive
    shape the frontend's table already renders) with the scope info that's
    meaningless for local .env vars but core to how Dagster+ secrets work."""
    id: str
    scopes: CloudSecretScopes
    location_names: list[str] = []
    can_edit: bool = True


class SaveCloudSecretRequest(BaseModel):
    key: str
    value: str
    scopes: CloudSecretScopes
    location_names: list[str] = []


class EnvVarsResponse(BaseModel):
    """Response model for environment variables."""
    variables: list[EnvVariable]


class EnvVarsUpdate(BaseModel):
    """Request model for updating environment variables."""
    variables: list[EnvVariable]


# List of keywords that indicate a sensitive variable
SENSITIVE_KEYWORDS = [
    "password", "secret", "key", "token", "api_key", "apikey",
    "auth", "credential", "private", "passphrase", "salt"
]


def is_sensitive_variable(key: str) -> bool:
    """Check if a variable key indicates sensitive data."""
    key_lower = key.lower()
    return any(keyword in key_lower for keyword in SENSITIVE_KEYWORDS)


@router.get("/{project_id}")
async def get_env_vars(project_id: str) -> EnvVarsResponse:
    """
    Get environment variables for a project.

    Args:
        project_id: Project ID

    Returns:
        List of environment variables
    """
    # Get project path
    project_file = (settings.projects_dir / f"{project_id}.json").resolve()
    if not project_file.exists():
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

    # Read project metadata to get directory name
    import json
    with open(project_file, 'r') as f:
        project_data = json.load(f)

    directory_name = project_data.get("directory_name", project_id)
    project_path = (settings.projects_dir / directory_name).resolve()

    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project directory not found")

    # Read .env file
    env_file = project_path / ".env"
    variables = []

    if env_file.exists():
        try:
            with open(env_file, 'r') as f:
                for line in f:
                    line = line.strip()
                    # Skip empty lines and comments
                    if not line or line.startswith('#'):
                        continue

                    # Parse key=value
                    if '=' in line:
                        key, value = line.split('=', 1)
                        key = key.strip()
                        value = value.strip()

                        # Remove quotes if present
                        if (value.startswith('"') and value.endswith('"')) or \
                           (value.startswith("'") and value.endswith("'")):
                            value = value[1:-1]

                        variables.append(EnvVariable(
                            key=key,
                            value=value,
                            is_sensitive=is_sensitive_variable(key)
                        ))
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to read .env file: {str(e)}"
            )

    return EnvVarsResponse(variables=variables)


@router.put("/{project_id}")
async def update_env_vars(project_id: str, update: EnvVarsUpdate):
    """
    Update environment variables for a project.

    Args:
        project_id: Project ID
        update: Updated environment variables

    Returns:
        Success message
    """
    # Get project path
    project_file = (settings.projects_dir / f"{project_id}.json").resolve()
    if not project_file.exists():
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

    # Read project metadata to get directory name
    import json
    with open(project_file, 'r') as f:
        project_data = json.load(f)

    directory_name = project_data.get("directory_name", project_id)
    project_path = (settings.projects_dir / directory_name).resolve()

    if not project_path.exists():
        raise HTTPException(status_code=404, detail=f"Project directory not found")

    # Write .env file
    env_file = project_path / ".env"

    try:
        with open(env_file, 'w') as f:
            f.write("# Environment variables for Dagster project\n")
            f.write("# Generated by Dagster Designer\n\n")

            for var in update.variables:
                # Quote values that contain spaces or special characters
                value = var.value
                if ' ' in value or any(c in value for c in ['#', '$', '&', '|', ';']):
                    value = f'"{value}"'

                f.write(f"{var.key}={value}\n")

        return {"message": "Environment variables updated successfully"}

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to write .env file: {str(e)}"
        )


class DagsterPlusScope(BaseModel):
    """Optional Dagster+ scope for env pull/push."""
    deployment: str | None = None
    code_location: str | None = None


def _dagster_plus_creds(project) -> tuple[str, str, str, str]:
    return (
        project.dagster_plus_org or "",
        project.dagster_plus_deployment or "",
        project.dagster_plus_token or "",
        project.dagster_plus_region,
    )


async def _fetch_cloud_secrets(project, code_location: str | None) -> list[CloudEnvVariable]:
    """Real env-var VALUES for a pure Dagster+ connection (is_dagster_plus,
    no local repo/venv) via GraphQL -- the dg-CLI path below (`_run_dg_env`
    etc) needs a project-local venv that this kind of project never has.
    secretsOrError is the one that actually carries secretValue;
    utilizedEnvVarsOrError (also in dagster_plus_client.py) only gives
    names + what consumes them, no values.

    canViewSecretValue reflects the token's real permission -- a secret
    the token can't view still comes back with SOME string in
    secretValue (not necessarily empty), so that flag, not the value's
    presence, is what decides whether we trust and surface it."""
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        data = await dagster_plus_query(org, deployment, token, SECRETS_QUERY, region=region)
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch secrets from Dagster+: {e}")
    result = data.get("secretsOrError") or {}
    if result.get("__typename") != "Secrets":
        raise HTTPException(status_code=502, detail=result.get("message") or "Dagster+ returned an unexpected response for secrets.")
    out: list[CloudEnvVariable] = []
    for s in (result.get("secrets") or []):
        locations = s.get("locationNames") or []
        # Deployment-wide secrets apply everywhere; location-scoped ones
        # only to their listed code location(s). No code_location filter
        # (deployment-level view) shows everything.
        if code_location and not s.get("fullDeploymentScope") and code_location not in locations:
            continue
        can_view = bool(s.get("canViewSecretValue"))
        out.append(CloudEnvVariable(
            key=s.get("secretName", ""),
            value=s.get("secretValue", "") if can_view else "(hidden — no permission to view)",
            is_sensitive=True,
            id=s.get("id", ""),
            scopes=CloudSecretScopes(
                full_deployment_scope=bool(s.get("fullDeploymentScope")),
                all_branch_deployments_scope=bool(s.get("allBranchDeploymentsScope")),
                specific_branch_deployment_scope=s.get("specificBranchDeploymentScope"),
                local_deployment_scope=bool(s.get("localDeploymentScope")),
            ),
            location_names=locations,
            can_edit=bool(s.get("canEditSecret", True)),
        ))
    return out


def _scopes_to_graphql_input(scopes: CloudSecretScopes) -> dict:
    return {
        "fullDeploymentScope": scopes.full_deployment_scope,
        "allBranchDeploymentsScope": scopes.all_branch_deployments_scope,
        "specificBranchDeploymentScope": scopes.specific_branch_deployment_scope,
        "localDeploymentScope": scopes.local_deployment_scope,
    }


async def _create_cloud_secret(project, req: SaveCloudSecretRequest) -> None:
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        data = await dagster_plus_query(
            org, deployment, token, CREATE_SECRET_MUTATION,
            variables={
                "name": req.key,
                "value": req.value,
                "scopes": _scopes_to_graphql_input(req.scopes),
                "locationNames": req.location_names or None,
            },
            region=region,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to create secret: {e}")
    result = data.get("createSecret") or {}
    if result.get("__typename") == "CreateOrUpdateSecretSuccess":
        return
    raise HTTPException(status_code=400, detail=result.get("message") or "Failed to create secret.")


async def _update_cloud_secret(project, secret_id: str, req: SaveCloudSecretRequest) -> None:
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        data = await dagster_plus_query(
            org, deployment, token, UPDATE_SECRET_MUTATION,
            variables={
                "id": secret_id,
                "name": req.key,
                "value": req.value,
                "scopes": _scopes_to_graphql_input(req.scopes),
                "locationNames": req.location_names or None,
            },
            region=region,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to update secret: {e}")
    result = data.get("updateSecret") or {}
    if result.get("__typename") == "CreateOrUpdateSecretSuccess":
        return
    raise HTTPException(status_code=400, detail=result.get("message") or "Failed to update secret.")


async def _delete_cloud_secret(project, secret_id: str) -> None:
    org, deployment, token, region = _dagster_plus_creds(project)
    try:
        data = await dagster_plus_query(
            org, deployment, token, DELETE_SECRET_MUTATION, variables={"id": secret_id},
            region=region,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=f"Failed to delete secret: {e}")
    result = data.get("deleteSecret") or {}
    if result.get("__typename") == "DeleteSecretSuccess":
        return
    raise HTTPException(status_code=400, detail=result.get("message") or "Failed to delete secret.")


def _resolve_project_dir(project_id: str) -> Path:
    import json
    project_file = (settings.projects_dir / f"{project_id}.json").resolve()
    if not project_file.exists():
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")
    with open(project_file, 'r') as f:
        project_data = json.load(f)
    directory_name = project_data.get("directory_name", project_id)
    project_dir = (settings.projects_dir / directory_name).resolve()
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project directory not found")
    return project_dir


def _run_dg_env(project_dir: Path, action: str, scope: DagsterPlusScope) -> tuple[int, str, str]:
    """Run `dg plus env pull|push` in the project's venv and return (rc, stdout, stderr)."""
    import subprocess
    dg_path = venv_bin_path(project_dir / ".venv", "dg")
    if not dg_path.exists():
        raise HTTPException(
            status_code=400,
            detail="Project venv missing dg CLI. Reinstall project dependencies.",
        )
    cmd = [str(dg_path), "plus", "env", action]
    if scope.deployment:
        cmd += ["--deployment", scope.deployment]
    if scope.code_location:
        cmd += ["--code-location", scope.code_location]
    if action == "pull":
        # Overwrite whatever's currently in .env so the UI reflects Dagster+ state.
        cmd += ["--overwrite"]
    result = subprocess.run(
        cmd, cwd=str(project_dir), capture_output=True, text=True, timeout=60,
    )
    return result.returncode, result.stdout, result.stderr


@router.get("/{project_id}/dagster-plus-scope")
async def get_dagster_plus_scope(project_id: str):
    """List available Dagster+ deployments and code locations for this project.

    Runs `dg plus deployment list` and `dg plus code-location list` in the
    project's venv. Returns empty lists if the user isn't logged in or the
    project isn't a Dagster+ project (frontend falls back to free-text).
    """
    import subprocess

    # A pure Dagster+ "connect" project (is_dagster_plus=True) has no local
    # directory at all -- _resolve_project_dir below 404s before we'd ever
    # reach the "missing dg CLI" fallback a few lines down, which is for
    # LOCAL projects with cloud sync configured but not yet `dg plus
    # login`'d, a different case. This one already knows its one connected
    # deployment (stored at connect time) without needing dg to discover
    # anything.
    cloud_project = project_service.get_project(project_id)
    if cloud_project and getattr(cloud_project, "is_dagster_plus", False):
        deployment = cloud_project.dagster_plus_deployment or ""
        return {
            "deployments": [deployment] if deployment else [],
            "code_locations": [],
            "authenticated": bool(deployment),
            # Tells the frontend the dedicated /cloud-secrets create/update/
            # delete endpoints are usable here -- a LOCAL project that
            # merely has `dg plus login` / cloud sync configured (the
            # branch below) is NOT is_dagster_plus and has no such
            # connection info to run those against; it keeps using the
            # dg-CLI bulk push/pull flow it always has.
            "cloud_native": True,
        }

    project_dir = _resolve_project_dir(project_id)
    dg_path = venv_bin_path(project_dir / ".venv", "dg")
    if not dg_path.exists():
        return {"deployments": [], "code_locations": [], "authenticated": False,
                "cloud_native": False, "message": "Project venv missing dg CLI"}

    def _run_list(subcommand: list[str]) -> list[str]:
        try:
            result = subprocess.run(
                [str(dg_path), "plus", *subcommand, "--json"],
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode != 0:
                return []
            import json as _json
            data = _json.loads(result.stdout)
            if isinstance(data, list):
                return [str(x.get("name") if isinstance(x, dict) else x) for x in data]
            if isinstance(data, dict) and "items" in data:
                return [str(x.get("name") if isinstance(x, dict) else x) for x in data["items"]]
        except Exception:
            pass
        return []

    deployments = _run_list(["deployment", "list"])
    code_locations = _run_list(["code-location", "list"])
    return {
        "deployments": deployments,
        "code_locations": code_locations,
        "authenticated": bool(deployments) or bool(code_locations),
        "cloud_native": False,
    }


@router.post("/{project_id}/dagster-plus-login")
async def start_dagster_plus_login(project_id: str):
    """Kick off `dg plus login` so the user can sign in from the browser
    without opening a terminal.

    `dg plus login` opens a browser for the OAuth flow and blocks in the
    foreground until it completes, so it's spawned detached rather than
    awaited here -- the frontend polls dagster-plus-scope afterward to
    notice once `authenticated` flips to true.
    """
    import subprocess

    project_dir = _resolve_project_dir(project_id)
    dg_path = venv_bin_path(project_dir / ".venv", "dg")
    if not dg_path.exists():
        raise HTTPException(status_code=400, detail="Project venv missing dg CLI")

    try:
        subprocess.Popen(
            [str(dg_path), "plus", "login"],
            cwd=str(project_dir),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start dg plus login: {e}")

    return {"started": True}


def _parse_env_file_content(content: str) -> list[dict]:
    """Parse .env text into [{key, value, is_sensitive}] list."""
    vars_out: list[dict] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        vars_out.append({
            "key": key,
            "value": value,
            "is_sensitive": is_sensitive_variable(key),
        })
    return vars_out


def _serialize_env_file(vars_in: list[EnvVariable]) -> str:
    """Serialize env vars to .env text (matches the format update_env_vars writes)."""
    out = ["# Environment variables for Dagster project", "# Generated by Dagster Designer", ""]
    for var in vars_in:
        value = var.value
        if " " in value or any(c in value for c in ["#", "$", "&", "|", ";"]):
            value = f'"{value}"'
        out.append(f"{var.key}={value}")
    return "\n".join(out) + "\n"


@router.post("/{project_id}/pull-from-plus")
async def pull_env_vars_from_plus(project_id: str, scope: DagsterPlusScope):
    """Pull env vars from Dagster+ using `dg plus env pull`.

    Writes to the project's `.env` file (overwriting it). Requires the user to
    be authenticated with `dg plus login` in the project's venv.
    """
    project_dir = _resolve_project_dir(project_id)
    rc, stdout, stderr = _run_dg_env(project_dir, "pull", scope)
    if rc != 0:
        detail = (stderr or stdout or "dg plus env pull failed").strip()
        # Common case: not logged in.
        if "login" in detail.lower() or "auth" in detail.lower():
            detail = f"{detail}\n\nHint: run `dg plus login` in the project directory first."
        raise HTTPException(status_code=400, detail=detail)
    return {
        "message": "Pulled env vars from Dagster+.",
        "stdout": stdout.strip(),
    }


@router.post("/{project_id}/push-to-plus")
async def push_env_vars_to_plus(project_id: str, scope: DagsterPlusScope):
    """Push local `.env` vars to Dagster+ using `dg plus env push`."""
    project_dir = _resolve_project_dir(project_id)
    rc, stdout, stderr = _run_dg_env(project_dir, "push", scope)
    if rc != 0:
        detail = (stderr or stdout or "dg plus env push failed").strip()
        if "login" in detail.lower() or "auth" in detail.lower():
            detail = f"{detail}\n\nHint: run `dg plus login` in the project directory first."
        raise HTTPException(status_code=400, detail=detail)
    return {
        "message": "Pushed env vars to Dagster+.",
        "stdout": stdout.strip(),
    }


@router.post("/{project_id}/scoped-fetch")
async def scoped_fetch_from_plus(project_id: str, scope: DagsterPlusScope):
    """Fetch env vars for a specific Dagster+ scope WITHOUT touching local .env.

    Pulls into a temp file, reads it, deletes it, returns parsed vars.
    """
    import subprocess
    import tempfile

    cloud_project = project_service.get_project(project_id)
    if cloud_project and getattr(cloud_project, "is_dagster_plus", False):
        return {"variables": await _fetch_cloud_secrets(cloud_project, scope.code_location)}

    project_dir = _resolve_project_dir(project_id)
    dg_path = venv_bin_path(project_dir / ".venv", "dg")
    if not dg_path.exists():
        raise HTTPException(status_code=400, detail="Project venv missing dg CLI")

    # dg plus env pull writes to .env by default. Use a temp file via --path if supported;
    # otherwise pull into project_dir then read + restore original .env.
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [str(dg_path), "plus", "env", "pull", "--path", str(Path(tmp) / ".env"), "--overwrite"]
        if scope.deployment:
            cmd += ["--deployment", scope.deployment]
        if scope.code_location:
            cmd += ["--code-location", scope.code_location]
        result = subprocess.run(cmd, cwd=str(project_dir), capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "dg plus env pull failed").strip()
            if "login" in detail.lower() or "auth" in detail.lower():
                detail = f"{detail}\n\nHint: run `dg plus login` in the project directory first."
            # Some older `dg plus env pull` versions may not support --path — fall back.
            if "--path" in detail or "unexpected" in detail.lower():
                # Fallback: read existing .env, run non-scoped pull, capture, restore.
                env_file = project_dir / ".env"
                original = env_file.read_text() if env_file.exists() else None
                rc2, stdout2, stderr2 = _run_dg_env(project_dir, "pull", scope)
                if rc2 != 0:
                    raise HTTPException(status_code=400, detail=(stderr2 or stdout2).strip())
                new_content = env_file.read_text() if env_file.exists() else ""
                if original is not None:
                    env_file.write_text(original)
                return {"variables": _parse_env_file_content(new_content)}
            raise HTTPException(status_code=400, detail=detail)

        pulled_file = Path(tmp) / ".env"
        content = pulled_file.read_text() if pulled_file.exists() else ""
        return {"variables": _parse_env_file_content(content)}


def _require_cloud_project(project_id: str):
    project = project_service.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not getattr(project, "is_dagster_plus", False):
        raise HTTPException(status_code=400, detail="This project isn't a Dagster+ connection.")
    return project


@router.post("/{project_id}/cloud-secrets")
async def create_cloud_secret(project_id: str, request: SaveCloudSecretRequest):
    """Create a new Dagster+ secret with an explicit scope (deployment /
    branch / local, optionally restricted to specific code locations) --
    see CloudSecretScopes. Returns the full refreshed deployment-wide list
    so the UI stays in sync with whatever Dagster+ actually stored."""
    project = _require_cloud_project(project_id)
    await _create_cloud_secret(project, request)
    return {"variables": await _fetch_cloud_secrets(project, None)}


@router.put("/{project_id}/cloud-secrets/{secret_id}")
async def update_cloud_secret(project_id: str, secret_id: str, request: SaveCloudSecretRequest):
    """Updates value AND scope -- Dagster+'s mutation requires both even
    for a pure value change, so the frontend always resubmits the secret's
    current scope unless the user explicitly changed it."""
    project = _require_cloud_project(project_id)
    await _update_cloud_secret(project, secret_id, request)
    return {"variables": await _fetch_cloud_secrets(project, None)}


@router.delete("/{project_id}/cloud-secrets/{secret_id}")
async def delete_cloud_secret(project_id: str, secret_id: str):
    project = _require_cloud_project(project_id)
    await _delete_cloud_secret(project, secret_id)
    return {"variables": await _fetch_cloud_secrets(project, None)}


class ScopedPushRequest(BaseModel):
    scope: DagsterPlusScope
    variables: list[EnvVariable]


@router.post("/{project_id}/scoped-push")
async def scoped_push_to_plus(project_id: str, request: ScopedPushRequest):
    """Push a specific list of env vars to a specific Dagster+ scope.

    Writes the vars to a temp .env, calls `dg plus env push --path <tmp>`,
    without touching the project's .env.
    """
    import subprocess
    import tempfile
    project_dir = _resolve_project_dir(project_id)
    dg_path = venv_bin_path(project_dir / ".venv", "dg")
    if not dg_path.exists():
        raise HTTPException(status_code=400, detail="Project venv missing dg CLI")

    content = _serialize_env_file(request.variables)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_env = Path(tmp) / ".env"
        tmp_env.write_text(content)
        cmd = [str(dg_path), "plus", "env", "push", "--path", str(tmp_env)]
        if request.scope.deployment:
            cmd += ["--deployment", request.scope.deployment]
        if request.scope.code_location:
            cmd += ["--code-location", request.scope.code_location]
        result = subprocess.run(cmd, cwd=str(project_dir), capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "dg plus env push failed").strip()
            if "--path" in detail or "unexpected" in detail.lower():
                # Fallback: swap project .env temporarily.
                env_file = project_dir / ".env"
                original = env_file.read_text() if env_file.exists() else None
                env_file.write_text(content)
                try:
                    rc2, stdout2, stderr2 = _run_dg_env(project_dir, "push", request.scope)
                    if rc2 != 0:
                        raise HTTPException(status_code=400, detail=(stderr2 or stdout2).strip())
                finally:
                    if original is not None:
                        env_file.write_text(original)
                    else:
                        env_file.unlink(missing_ok=True)
                return {"message": f"Pushed {len(request.variables)} vars to Dagster+."}
            if "login" in detail.lower() or "auth" in detail.lower():
                detail = f"{detail}\n\nHint: run `dg plus login` in the project directory first."
            raise HTTPException(status_code=400, detail=detail)
        return {
            "message": f"Pushed {len(request.variables)} vars to Dagster+.",
            "stdout": result.stdout.strip(),
        }
