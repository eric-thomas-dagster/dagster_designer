"""Unified queries for authoring components.

Returns the shape Designer needs to render:
  * `GET /projects/{id}/authored/locations`      — code locations the
    user can author against: customer Dagster+ locs + the sandbox
  * `GET /projects/{id}/authored/component-types?location=<name>` —
    ComponentTypeInfo list for that loc, sourced from Dagster+ or the
    sandbox subprocess depending on where the location lives.

The GraphQL shape mirrors Dagster+'s `componentTypesForLocationOrError`
so the frontend can treat both sources identically.
"""

import asyncio
import time

from fastapi import APIRouter, HTTPException, Query

from ..services import designer_loc_service
from ..services.dagster_plus_client import DagsterPlusError, query as dagster_plus_query
from ..services.project_service import project_service


router = APIRouter(prefix="/projects/{project_id}/authored", tags=["authored"])


# Sentinel location name used to reference the Designer sandbox in a
# way that can't collide with a real Dagster+ code location name.
SANDBOX_LOCATION_NAME = "__sandbox__"


DEPLOYMENTS_LIST_QUERY = """
query DesignerDeployments {
  fullDeployments {
    deploymentName
    deploymentId
    deploymentType
    deploymentStatus
  }
  branchDeployments(limit: 40) {
    nodes {
      deploymentName
      deploymentId
      deploymentType
      deploymentStatus
      branchDeploymentGitMetadata {
        branchName
        repoName
        pullRequestUrl
        pullRequestNumber
        pullRequestStatus
      }
    }
  }
}
"""


# Both current Dagster+ and vanilla Dagster expose the inner list under
# `componentTypes`. An earlier HAR capture showed `types`, but the
# schema has since converged — introspection on data-eng-prod and
# christian/editable-components branch both report `componentTypes`.
CLOUD_COMPONENT_TYPES_QUERY = """
query CodeLocationComponentTypesQuery($locationName: String!) {
  componentTypesForLocationOrError(locationName: $locationName) {
    __typename
    ... on ComponentTypes {
      componentTypes {
        name
        namespace
        schema
        formSchema { dataSchema uiSchema }
        isAppManaged
        example
        description
        owners
        tags
      }
    }
    ... on PythonError { message }
  }
}
"""

# Vanilla Dagster (`dg dev`, what the sandbox runs) names it `componentTypes`.
SANDBOX_COMPONENT_TYPES_QUERY = """
query CodeLocationComponentTypesQuery($locationName: String!) {
  componentTypesForLocationOrError(locationName: $locationName) {
    __typename
    ... on ComponentTypes {
      componentTypes {
        name
        namespace
        schema
        formSchema { dataSchema uiSchema }
        isAppManaged
        example
        description
        owners
        tags
      }
    }
    ... on PythonError { message }
  }
}
"""


CODE_LOCATIONS_QUERY = """
query CodeLocations {
  workspaceOrError {
    __typename
    ... on Workspace {
      locationEntries { name }
    }
  }
}
"""


ASSET_NODES_QUERY = """
query DesignerAssetNodes {
  assetNodes(loadMaterializations: false) {
    assetKey { path }
    groupName
    repository { location { name } }
  }
}
"""


# Richer than ASSET_NODES_QUERY — enough to render sandbox assets as real
# canvas nodes (lineage, description, kind) rather than just picker
# entries. Deliberately OSS-schema-only (no internalFreshnessPolicy /
# freshnessStatusInfo / etc.) since this runs against the sandbox's own
# local dg dev webserver, not Dagster+.
SANDBOX_GRAPH_ASSET_NODES_QUERY = """
query DesignerSandboxGraphAssets {
  assetNodes(loadMaterializations: false) {
    assetKey { path }
    groupName
    description
    computeKind
    repository { name location { name } }
    isPartitioned
    isExecutable
    isMaterializable
    isObservable
    dependencyKeys { path }
    dependedByKeys { path }
    tags { key value }
  }
}
"""


# Jobs / schedules / sensors — pulled together in one round trip
# because they all live under the same locationEntries shape and the
# form uses them for adjacent field pickers (`job_name`,
# `schedule_name`, `sensor_name`).
PRIMITIVES_QUERY = """
query DesignerPrimitives {
  workspaceOrError {
    __typename
    ... on Workspace {
      locationEntries {
        name
        locationOrLoadError {
          __typename
          ... on RepositoryLocation {
            repositories {
              name
              pipelines { name isJob }
              schedules { name }
              sensors { name }
            }
          }
        }
      }
    }
  }
}
"""


def _require_project(project_id: str):
    project = project_service.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


# In-memory cache: `(project_id, deployment_name) -> (supports_authoring, ts_epoch)`.
# Refresh every 60s so the picker sees fresh state without hammering
# Dagster+ on every modal open. Keyed by project too because different
# projects may use different orgs/tokens.
_SUPPORT_CACHE: dict[tuple[str, str], tuple[bool, float]] = {}
_SUPPORT_CACHE_TTL_S = 60.0
_SUPPORT_PROBE_CONCURRENCY = 8  # semaphore limit — safe for Dagster+


@router.get("/deployments")
async def deployments(project_id: str):
    """List all Dagster+ deployments the project's token can reach —
    long-lived (fullDeployments) + branch (branchDeployments). Branch
    entries include git metadata so the UI can render a friendly
    `<branch-name>` label instead of the commit hash."""
    project = _require_project(project_id)
    if not project.is_dagster_plus:
        return {"deployments": []}
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            project.dagster_plus_deployment or "",
            project.dagster_plus_token or "",
            DEPLOYMENTS_LIST_QUERY,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))

    out: list[dict] = []
    for d in data.get("fullDeployments") or []:
        out.append({
            "name": d.get("deploymentName"),
            "id": d.get("deploymentId"),
            "type": d.get("deploymentType"),   # PRODUCTION for long-lived
            "status": d.get("deploymentStatus"),
            "display_name": d.get("deploymentName"),
            "branch_name": None,
            "pull_request_url": None,
        })
    for node in ((data.get("branchDeployments") or {}).get("nodes") or []):
        meta = node.get("branchDeploymentGitMetadata") or {}
        branch = meta.get("branchName")
        pr_num = meta.get("pullRequestNumber")
        # Prefer human-readable branch-name; fall back to short hash if missing.
        raw_name = node.get("deploymentName") or ""
        display = branch or (raw_name[:8] if raw_name else "unnamed")
        if pr_num:
            display = f"{display} · PR #{pr_num}"
        out.append({
            "name": node.get("deploymentName"),
            "id": node.get("deploymentId"),
            "type": node.get("deploymentType"),   # BRANCH
            "status": node.get("deploymentStatus"),
            "display_name": display,
            "branch_name": branch,
            "pull_request_url": meta.get("pullRequestUrl"),
        })
    return {"deployments": out}


@router.get("/deployment-support")
async def deployment_support(project_id: str):
    """For each deployment the token can reach, probe whether ANY of
    its code locations exposes an `isAppManaged: true` component type.
    Enables the modal to grey out deployments where authoring isn't
    possible today.

    Cached per (project, deployment) for 60s so repeat modal opens
    don't re-probe. Concurrency-limited so we don't fan out 250+
    parallel GraphQL calls at Dagster+."""
    project = _require_project(project_id)
    if not project.is_dagster_plus:
        return {"support": {}}

    # Enumerate deployments once.
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            project.dagster_plus_deployment or "",
            project.dagster_plus_token or "",
            DEPLOYMENTS_LIST_QUERY,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))

    names: list[str] = []
    for d in data.get("fullDeployments") or []:
        n = d.get("deploymentName")
        if n:
            names.append(n)
    for node in ((data.get("branchDeployments") or {}).get("nodes") or []):
        n = node.get("deploymentName")
        if n:
            names.append(n)

    sem = asyncio.Semaphore(_SUPPORT_PROBE_CONCURRENCY)
    now = time.time()

    async def probe(name: str) -> tuple[str, bool]:
        cached = _SUPPORT_CACHE.get((project_id, name))
        if cached and (now - cached[1]) < _SUPPORT_CACHE_TTL_S:
            return name, cached[0]
        async with sem:
            supports = await _deployment_supports_authoring(project, name)
        _SUPPORT_CACHE[(project_id, name)] = (supports, time.time())
        return name, supports

    results = await asyncio.gather(*[probe(n) for n in names])
    return {"support": dict(results)}


async def _deployment_supports_authoring(project, deployment_name: str) -> bool:
    """True if ANY location in the deployment exposes an app-managed type.
    Fan-outs the location probe in parallel and short-circuits — the
    first True result wins."""
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            deployment_name,
            project.dagster_plus_token or "",
            CODE_LOCATIONS_QUERY,
        )
    except DagsterPlusError:
        return False
    ws = data.get("workspaceOrError") or {}
    loc_names = [e.get("name") for e in (ws.get("locationEntries") or []) if e.get("name")]
    if not loc_names:
        return False

    # asyncio.wait FIRST_COMPLETED gives us early exit on the first
    # True result — no need to wait for slow deployments to fully
    # respond once we know the answer.
    tasks = [
        asyncio.create_task(_location_has_app_managed_types(project, ln, deployment_name))
        for ln in loc_names
    ]
    supports = False
    try:
        while tasks:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                if t.result():
                    supports = True
                    break
            if supports:
                break
            tasks = list(pending)
    finally:
        for t in tasks:
            t.cancel()
    return supports


@router.get("/locations")
async def locations(
    project_id: str,
    deployment: str | None = Query(None, description="Which Dagster+ deployment to enumerate; defaults to the project's configured deployment"),
    include_unsupported: bool = Query(False),
):
    """Locations available for authoring — Dagster+ locs that expose at
    least one `isAppManaged: true` component type, plus the sandbox.

    Most long-lived deployments don't have app-managed types registered
    (that's an opt-in the code location has to configure). Filtering
    them out here so the modal's location dropdown shows only usable
    entries. Pass `include_unsupported=true` to see the full list plus
    a per-entry `authoring_supported` flag (for debugging)."""
    project = _require_project(project_id)
    entries: list[dict] = []
    # Deployment scope — defaults to the project's configured one, but the
    # caller can point at any deployment (including branch deployments) that
    # the token can reach.
    dep = deployment or project.dagster_plus_deployment or ""

    if project.is_dagster_plus:
        try:
            data = await dagster_plus_query(
                project.dagster_plus_org or "",
                dep,
                project.dagster_plus_token or "",
                CODE_LOCATIONS_QUERY,
            )
            ws = data.get("workspaceOrError") or {}
            raw_names = [e.get("name") for e in (ws.get("locationEntries") or []) if e.get("name")]

            # Probe each location in parallel for app-managed types.
            supported_flags = await asyncio.gather(
                *[_location_has_app_managed_types(project, n, dep) for n in raw_names],
                return_exceptions=False,
            )
            for name, is_supported in zip(raw_names, supported_flags):
                if is_supported or include_unsupported:
                    entries.append({
                        "name": name,
                        "deployment": dep,
                        "source": "dagster_plus",
                        "authoring_supported": bool(is_supported),
                    })
        except DagsterPlusError as e:
            entries.append({
                "name": "__error__",
                "deployment": dep,
                "source": "dagster_plus",
                "error": str(e),
                "authoring_supported": False,
            })

    # Sandbox loc — surface it if the subprocess is ready. Sandbox
    # always supports authoring (that's the whole point).
    sandbox_state = designer_loc_service.get_state(project_id)
    if sandbox_state.is_proc_alive():
        entries.append({
            "name": SANDBOX_LOCATION_NAME,
            "source": "sandbox",
            "authoring_supported": True,
        })

    return {"locations": entries}


async def _location_has_app_managed_types(project, location_name: str, deployment: str) -> bool:
    """True if the loc exposes at least one `isAppManaged: true` type."""
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            deployment,
            project.dagster_plus_token or "",
            CLOUD_COMPONENT_TYPES_QUERY,
            {"locationName": location_name},
        )
    except DagsterPlusError:
        return False
    payload = (data or {}).get("componentTypesForLocationOrError") or {}
    if payload.get("__typename") != "ComponentTypes":
        return False
    return any(t.get("isAppManaged") for t in (payload.get("componentTypes") or []))


@router.get("/component-types")
async def component_types(
    project_id: str,
    location: str = Query(...),
    deployment: str | None = Query(None, description="Which Dagster+ deployment; defaults to the project's configured one"),
):
    """List component types available in a code location. Routes to
    Dagster+ (for customer locs, scoped to `deployment`) or to the
    sandbox subprocess (for the sandbox sentinel)."""
    project = _require_project(project_id)

    if location == SANDBOX_LOCATION_NAME:
        # Query the sandbox subprocess. The sandbox's own location name
        # depends on how create-dagster scaffolded it — we need to look
        # it up first via workspaceOrError.
        loc_name = await _sandbox_location_name(project_id)
        if not loc_name:
            raise HTTPException(status_code=503, detail="Sandbox has no active location yet")
        try:
            r = await designer_loc_service.proxy_graphql(
                project_id, SANDBOX_COMPONENT_TYPES_QUERY, {"locationName": loc_name}
            )
            return _shape_component_types(r, list_field="componentTypes")
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))

    # Cloud location — scope query to the requested deployment.
    if not project.is_dagster_plus:
        raise HTTPException(status_code=400, detail="Not a Dagster+ project")
    dep = deployment or project.dagster_plus_deployment or ""
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            dep,
            project.dagster_plus_token or "",
            CLOUD_COMPONENT_TYPES_QUERY,
            {"locationName": location},
        )
        return _shape_component_types({"data": data}, list_field="componentTypes")
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/installed-community-components")
async def installed_community_components(
    project_id: str,
    location: str = Query(...),
    deployment: str | None = Query(None),
):
    """Return the community-catalog IDs already installed on a target
    location via the `community_component_installer` (if any).

    Powers the AddComponent picker's "already installed" indicator so
    users know which community components are ready-to-use on the
    target vs. would need to be installed by the promote flow.

    Sandbox: not covered — sandbox uses direct `dagster-component add`
    installs, not the installer component. Returns empty in that case."""
    project = _require_project(project_id)

    if location == SANDBOX_LOCATION_NAME:
        return {"checked": False, "installed": [], "reason": "sandbox uses direct install"}
    if not project.is_dagster_plus:
        raise HTTPException(status_code=400, detail="Not a Dagster+ project")

    dep = deployment or project.dagster_plus_deployment or ""
    from ..services import dagster_plus_preview_service as _preview
    return await _preview.list_installed_community_components(
        project=project,
        base_deployment=dep,
        location_name=location,
    )


@router.get("/assets")
async def assets(
    project_id: str,
    deployment: str | None = Query(None),
    location: str | None = Query(None),
):
    """Asset keys for the deployment+location the user is authoring
    against. Powers the `asset_selection` picker in the component form
    so users see the RIGHT assets — not whatever the project's
    hydrated graph happens to hold."""
    project = _require_project(project_id)
    if not project.is_dagster_plus:
        return {"asset_keys": []}
    dep = deployment or project.dagster_plus_deployment or ""
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            dep,
            project.dagster_plus_token or "",
            ASSET_NODES_QUERY,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))
    nodes = data.get("assetNodes") or []
    out: list[str] = []
    for n in nodes:
        if location:
            loc = ((n.get("repository") or {}).get("location") or {}).get("name")
            if loc != location:
                continue
        path = (n.get("assetKey") or {}).get("path") or []
        if path:
            out.append("/".join(path) if len(path) > 1 else path[0])
    # Preserve source order but dedupe (assetNodes can list the same key
    # twice when partitioned assets appear alongside their base defs).
    seen = set()
    deduped = []
    for k in out:
        if k not in seen:
            seen.add(k)
            deduped.append(k)
    return {"asset_keys": deduped}


@router.get("/primitives")
async def primitives(
    project_id: str,
    deployment: str | None = Query(None),
    location: str | None = Query(None),
):
    """Names of the Dagster primitives registered in the target
    deployment+location — jobs, schedules, sensors. Powers the
    `job_name` / `schedule_name` / `sensor_name` pickers in the
    component-authoring form so users pick from what actually exists
    rather than typing free-form."""
    project = _require_project(project_id)
    if not project.is_dagster_plus:
        return {"jobs": [], "schedules": [], "sensors": []}
    dep = deployment or project.dagster_plus_deployment or ""
    try:
        data = await dagster_plus_query(
            project.dagster_plus_org or "",
            dep,
            project.dagster_plus_token or "",
            PRIMITIVES_QUERY,
        )
    except DagsterPlusError as e:
        raise HTTPException(status_code=502, detail=str(e))

    entries = ((data.get("workspaceOrError") or {}).get("locationEntries") or [])
    if location:
        entries = [e for e in entries if e.get("name") == location]

    jobs: set[str] = set()
    schedules: set[str] = set()
    sensors: set[str] = set()
    for e in entries:
        loc = e.get("locationOrLoadError") or {}
        for repo in (loc.get("repositories") or []):
            for p in (repo.get("pipelines") or []):
                if p.get("isJob"):
                    jobs.add(p["name"])
            for s in (repo.get("schedules") or []):
                schedules.add(s["name"])
            for s in (repo.get("sensors") or []):
                sensors.add(s["name"])
    return {
        "jobs": sorted(jobs),
        "schedules": sorted(schedules),
        "sensors": sorted(sensors),
    }


def _shape_component_types(graphql_response: dict, list_field: str = "types") -> dict:
    """Flatten the union response into a simple {types: [...]}. The
    inner list field is named `types` on Dagster+ and `componentTypes`
    on vanilla Dagster (`dg dev`) — caller specifies which."""
    data = graphql_response.get("data") or {}
    payload = data.get("componentTypesForLocationOrError") or {}
    if payload.get("__typename") == "ComponentTypes":
        return {"types": payload.get(list_field) or []}
    return {"types": [], "error": payload.get("message") or payload.get("__typename")}


async def _sandbox_location_name(project_id: str) -> str | None:
    """Ask the sandbox for its one code location's name."""
    try:
        r = await designer_loc_service.proxy_graphql(project_id, CODE_LOCATIONS_QUERY, None)
    except RuntimeError:
        return None
    data = (r or {}).get("data") or {}
    ws = data.get("workspaceOrError") or {}
    entries = ws.get("locationEntries") or []
    for e in entries:
        n = e.get("name")
        if n:
            return n
    return None
