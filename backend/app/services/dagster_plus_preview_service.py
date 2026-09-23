"""Dagster+ Branch-Deployment-backed preview (M7.2).

Alternative to the laptop `dagster dev` preview in
`preview_runtime_service`. Instead of cloning the repo + running
`dagster dev` on the laptop, we ask Dagster+ to spin up a real Branch
Deployment reusing the base deployment's container image, then apply
each draft via `setAppManagedComponent` on the new BD.

Flow:
  1. Look up the base deployment's location metadata (image, module,
     commit hash) via `workspaceOrError.locationEntries.displayMetadata`.
  2. `createOrUpdateBranchDeployment` — allocates a new BD, inheriting
     the base's env-var scope. Empty of code initially.
  3. `addLocation` — populate the BD with a location pointing at the
     base's image so the agent boots the same code.
  4. Poll `workspaceOrError` on the BD until the location loads.
  5. `setAppManagedComponent` per draft — instantiates each draft's
     component type on the BD, using inner YAML attributes (not the
     full defs.yaml doc).
  6. Return the BD's webserver URL for the UI to open.

Zero Docker on Designer's side. Zero registry auth. The customer's
agent + Dagster+'s branch-deployment infra do the work. Env vars
auto-inject via the customer's branch-scoped Dagster+ env settings.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

import yaml as _yaml

from ..core.config import settings
from ..models.project import Project
from .dagster_plus_client import DagsterPlusError, _graphql_url, query as dp_query
from .drafts_service import Draft


# --- persistence -----------------------------------------------------------

def _store_path() -> Path:
    """Where remote-preview state lives across Designer restarts.
    On disk so a reboot doesn't orphan the BDs we created."""
    p = settings.data_dir / "preview-remote-states.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _serialize_key(key: tuple[str, str, str]) -> str:
    return "::".join(key)


def _deserialize_key(s: str) -> tuple[str, str, str] | None:
    parts = s.split("::")
    if len(parts) != 3:
        return None
    return (parts[0], parts[1], parts[2])


def _load_persisted() -> dict[tuple[str, str, str], dict]:
    p = _store_path()
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text())
    except Exception:
        return {}
    out: dict[tuple[str, str, str], dict] = {}
    for k, v in raw.items():
        parsed = _deserialize_key(k)
        if parsed is not None and isinstance(v, dict):
            out[parsed] = v
    return out


def _persist(cache: dict[tuple[str, str, str], dict]) -> None:
    raw = {_serialize_key(k): v for k, v in cache.items()}
    _store_path().write_text(json.dumps(raw, indent=2, sort_keys=True))


# --- GraphQL --------------------------------------------------------------

LOCATIONS_METADATA_QUERY = """
query LocMeta {
  workspaceOrError {
    __typename
    ... on Workspace {
      locationEntries {
        name
        loadStatus
        displayMetadata { key value }
      }
    }
  }
}
"""

# Resolve which deployment can serve as the base for a new BD. Branch
# deployments cannot themselves be a base — Dagster+ enforces that
# only long-lived deployments (PRODUCTION type) fork BDs off them. The
# `parentDeployment` field walks up the chain.
CURRENT_DEPLOYMENT_QUERY = """
query CurrentDeployment {
  currentDeployment {
    deploymentName
    deploymentType
    parentDeployment {
      deploymentName
      deploymentType
    }
  }
}
"""

CREATE_BD_MUTATION = """
mutation CreateOrUpdateBD(
  $baseDeploymentName: String,
  $branchData: CreateOrUpdateBranchDeploymentInput!,
  $commit: DeploymentCommitInput!
) {
  createOrUpdateBranchDeployment(
    baseDeploymentName: $baseDeploymentName,
    branchData: $branchData,
    commit: $commit
  ) {
    __typename
    ... on DagsterCloudDeployment {
      deploymentName
      deploymentId
      deploymentType
      deploymentStatus
    }
    ... on DeploymentNotFoundError { message }
    ... on UnauthorizedError { message }
    ... on PythonError { message stack }
    ... on DuplicateDeploymentError { message }
    ... on DeploymentLimitError { message }
  }
}
"""

ADD_LOCATION_MUTATION = """
mutation AddOrUpdateLoc($location: LocationSelector!) {
  addOrUpdateLocation(location: $location) {
    __typename
    ... on WorkspaceEntry { locationName metadataTimestamp }
    ... on PythonError { message stack }
    ... on UnauthorizedError { message }
    ... on InvalidLocationError { errors }
  }
}
"""


DELETE_DEPLOYMENT_MUTATION = """
mutation DeleteDep($deploymentId: Int!) {
  deleteDeployment(deploymentId: $deploymentId) {
    __typename
    ... on DagsterCloudDeployment { deploymentName }
    ... on DeploymentNotFoundError { message }
    ... on DeleteFinalDeploymentError { message }
    ... on UnauthorizedError { message }
    ... on PythonError { message stack }
  }
}
"""

REFRESH_DEFS_STATE_MUTATION = """
mutation RefreshDefsState($locationName: String!) {
  refreshDefsState(locationName: $locationName) {
    __typename
    ... on WorkspaceEntry { locationName hasLoadError }
    ... on RefreshDefsStateError { message }
    ... on UnauthorizedError { message }
    ... on PythonError { message stack }
  }
}
"""


COMPONENT_TYPES_QUERY = """
query ComponentTypes($locationName: String!) {
  componentTypesForLocationOrError(locationName: $locationName) {
    __typename
    ... on ComponentTypes {
      componentTypes { namespace name isAppManaged example }
    }
    ... on RepositoryLocationNotFound { message }
    ... on PythonError { message }
  }
}
"""


# Read the state-bag of app-managed components on a location. Used to
# find the community_component_installer's `components:` list — the
# authoritative source of "what community components are installed here."
APP_MANAGED_COMPONENTS_QUERY = """
query AppManagedComponents($locationName: String!) {
  appManagedComponentsForLocationOrError(locationName: $locationName) {
    __typename
    ... on AppManagedComponents {
      components { componentId componentType attributes }
    }
    ... on PythonError { message }
  }
}
"""


# Query the location's top-level resources. Used at promote time to
# check whether the target deployment has resources for every
# `consumes: ["resource:<service>"]` the promoted component declares.
# Repository.allTopLevelResourceDetails returns `{name, resourceType,
# description}` — matched against the manifest's canonical service names
# by substring (both name and resourceType).
LOCATION_RESOURCES_QUERY = """
query LocationResources($locationName: String!, $repositoryName: String!) {
  repositoryOrError(repositorySelector: {
    repositoryLocationName: $locationName,
    repositoryName: $repositoryName
  }) {
    __typename
    ... on Repository {
      allTopLevelResourceDetails {
        name
        resourceType
      }
    }
  }
}
"""


SET_APP_MANAGED_COMPONENT_MUTATION = """
mutation SetAppManagedComponent(
  $locationName: String!,
  $componentId: String!,
  $componentType: String!,
  $attributes: String!
) {
  setAppManagedComponent(
    locationName: $locationName,
    componentId: $componentId,
    componentType: $componentType,
    attributes: $attributes
  ) {
    __typename
    ... on SetAppManagedComponentSuccess {
      component { componentId componentType __typename }
    }
    ... on UnauthorizedError { message }
    ... on PythonError { message }
  }
}
"""


DELETE_APP_MANAGED_COMPONENT_MUTATION = """
mutation DeleteAppManagedComponent($locationName: String!, $componentId: String!) {
  deleteAppManagedComponent(locationName: $locationName, componentId: $componentId) {
    __typename
    ... on DeleteAppManagedComponentSuccess { componentId }
    ... on UnauthorizedError { message }
    ... on PythonError { message }
  }
}
"""


# --- helpers --------------------------------------------------------------

async def _classify_deployment(project: Project, deployment: str) -> dict:
    """Introspect a deployment to decide the right preview strategy.

    Returns `{is_branch: bool, parent_name: str | None}`. Callers use
    `is_branch` to decide:
      - Long-lived target  → must fork a fresh BD off it. Cannot state-mutate prod.
      - Branch target      → the target IS already an ephemeral, prod-safe
                             environment; apply state directly for speed.
    """
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            deployment,
            project.dagster_plus_token or "",
            CURRENT_DEPLOYMENT_QUERY,
        )
    except DagsterPlusError as e:
        raise RuntimeError(f"Failed to introspect deployment {deployment!r}: {e}") from e
    cur = data.get("currentDeployment") or {}
    dtype = cur.get("deploymentType")
    parent = cur.get("parentDeployment") or {}
    return {
        "is_branch": dtype == "BRANCH",
        "parent_name": parent.get("deploymentName"),
    }


async def _location_metadata(project: Project, base_deployment: str, location_name: str) -> dict:
    """Read displayMetadata for a specific location on the base
    deployment. Returns the image path + module identity we need to
    replicate the location onto a new BD."""
    data = await dp_query(
        project.dagster_plus_org or "",
        base_deployment,
        project.dagster_plus_token or "",
        LOCATIONS_METADATA_QUERY,
    )
    ws = data.get("workspaceOrError") or {}
    entries = ws.get("locationEntries") or []
    entry = next((e for e in entries if e.get("name") == location_name), None)
    if entry is None:
        raise RuntimeError(
            f"Location {location_name!r} not found on deployment {base_deployment!r}"
        )
    meta = {m["key"]: m["value"] for m in (entry.get("displayMetadata") or [])}
    if "image" not in meta:
        raise RuntimeError(
            f"Location {location_name!r} on {base_deployment!r} has no image in its display "
            "metadata — this preview flow needs a Hybrid (containerised) location to clone forward."
        )
    return meta


def _normalize_asset_selection(attrs: dict) -> dict:
    """Rewrite a comma-joined `asset_selection` into a Dagster-DSL-parseable form.

    Older Designer builds joined multi-selected assets with `, ` — but
    Dagster's `AssetSelection.from_string` rejects commas AND rejects
    bare `a/b or c/d` for slash-hierarchical asset keys. The parser
    requires each hierarchical key to carry an explicit `key:` prefix
    when combined with `or`. So:

      "a, b, c"            (comma-joined, invalid)
        →
      'key:"a" or key:"b" or key:"c"'  (canonical multi-key DSL, valid)

    Single-key values pass through untouched — they parse fine bare
    (e.g. `ANALYTICS/company_perf`) or quoted (e.g. `key:"..."`).
    Values that already look like DSL (contain `or`, `and`, `key:`,
    `group:`, `tag:`, `kind:`, `+`, `*`) are left alone."""
    if not isinstance(attrs, dict):
        return attrs
    v = attrs.get("asset_selection")
    if not isinstance(v, str) or "," not in v:
        return attrs

    # Bail out if the value already looks like a proper DSL expression —
    # don't touch it (commas can appear inside quoted names in theory).
    lo = v.lower()
    if any(tok in lo for tok in (" or ", " and ", "key:", "group:", "tag:", "kind:")):
        return attrs

    tokens = [t.strip() for t in v.split(",") if t.strip()]
    if len(tokens) <= 1:
        return attrs

    # Emit `key:"<name>"` for each token — this is the canonical form
    # for multi-key selections regardless of whether the key path uses
    # slashes, dots, or plain names. Quoting handles special chars.
    joined = " or ".join(f'key:"{t}"' for t in tokens)
    return {**attrs, "asset_selection": joined}


def _extract_inner_attributes(defs_yaml: str) -> str:
    """Drafts store the full `type:` + `attributes:` YAML document.
    `setAppManagedComponent` wants ONLY the inner `attributes:` block
    as a YAML string (matches Dagster+'s current mutation surface).

    Also normalizes known-broken shapes: `asset_selection` joined with
    commas gets rewritten to the DSL `or`-form so Dagster can parse it
    on the far side."""
    try:
        doc = _yaml.safe_load(defs_yaml) or {}
        attrs = doc.get("attributes") if isinstance(doc, dict) else None
        if attrs is None:
            return ""
        attrs = _normalize_asset_selection(attrs)
        return _yaml.safe_dump(attrs, sort_keys=False, default_flow_style=False)
    except Exception:
        # Fall back to the raw doc — worst case Dagster+ rejects it
        # and we surface the error to the user.
        return defs_yaml


async def _create_bd(
    project: Project,
    base_deployment: str,
    branch_hint: str,
) -> tuple[str, int]:
    """Create a fresh BD off `base_deployment`. Returns (name, id) —
    name is what URLs use, id is what `deleteDeployment` needs."""
    # Synthetic commit metadata — the BD needs a hash + timestamp, but
    # since Designer isn't tied to a real commit, we generate a stable
    # marker so the customer can find "who created this BD" later.
    commit_hash = uuid.uuid4().hex + uuid.uuid4().hex[:8]  # 48 chars
    now = time.time()
    variables = {
        "baseDeploymentName": base_deployment,
        "branchData": {
            "repoName": "designer-preview",   # placeholder; not tied to a real repo
            "branchName": branch_hint,
            "branchUrl": None,
            "pullRequestUrl": None,
            "pullRequestStatus": None,
            "pullRequestNumber": None,
        },
        "commit": {
            "commitHash": commit_hash,
            "timestamp": now,
            "commitMessage": "Dagster Designer preview session",
            "commitUrl": None,
            "authorName": "Dagster Designer",
            "authorEmail": "designer@dagsterlabs.com",
            "authorAvatarUrl": None,
        },
    }
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            base_deployment,
            project.dagster_plus_token or "",
            CREATE_BD_MUTATION,
            variables,
        )
    except DagsterPlusError as e:
        raise RuntimeError(f"Failed to create branch deployment: {e}") from e
    payload = data.get("createOrUpdateBranchDeployment") or {}
    tname = payload.get("__typename")
    if tname != "DagsterCloudDeployment":
        # Every other union variant carries a `message` — surface it.
        msg = payload.get("message") or tname or "unknown"
        raise RuntimeError(f"createOrUpdateBranchDeployment failed ({tname}): {msg}")
    bd_name = payload.get("deploymentName")
    bd_id = payload.get("deploymentId")
    if not isinstance(bd_name, str) or not bd_name or not isinstance(bd_id, int):
        raise RuntimeError(f"createOrUpdateBranchDeployment returned unexpected shape: {payload}")
    return bd_name, bd_id


async def _add_location_to_bd(
    project: Project,
    bd_name: str,
    location_name: str,
    meta: dict,
) -> None:
    """Populate the newly-created BD with a code location that reuses
    the base deployment's image + module identity."""
    selector: dict[str, Any] = {"name": location_name, "image": meta["image"]}
    if "commit_hash" in meta:
        selector["commitHash"] = meta["commit_hash"]
    if "url" in meta:
        selector["url"] = meta["url"]
    if "module_name" in meta:
        selector["moduleName"] = meta["module_name"]
    if "package_name" in meta:
        selector["packageName"] = meta["package_name"]

    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            bd_name,
            project.dagster_plus_token or "",
            ADD_LOCATION_MUTATION,
            {"location": selector},
        )
    except DagsterPlusError as e:
        raise RuntimeError(f"Failed to attach location {location_name!r} to BD {bd_name!r}: {e}") from e
    payload = data.get("addOrUpdateLocation") or {}
    tname = payload.get("__typename")
    if tname != "WorkspaceEntry":
        errors = payload.get("errors")
        msg = (
            payload.get("message")
            or (errors if isinstance(errors, str) else (", ".join(errors) if isinstance(errors, list) else None))
            or tname
            or "unknown"
        )
        raise RuntimeError(f"addOrUpdateLocation failed ({tname}): {msg}")


async def _wait_for_location(
    project: Project,
    bd_name: str,
    location_name: str,
    timeout_s: float = 300.0,
) -> None:
    """Poll the BD's workspace until the location has finished loading."""
    started = time.time()
    while time.time() - started < timeout_s:
        try:
            data = await dp_query(
                project.dagster_plus_org or "",
                bd_name,
                project.dagster_plus_token or "",
                "query { workspaceOrError { ... on Workspace { locationEntries { name loadStatus } } } }",
            )
        except DagsterPlusError:
            time.sleep(2)
            continue
        entries = ((data.get("workspaceOrError") or {}).get("locationEntries") or [])
        entry = next((e for e in entries if e.get("name") == location_name), None)
        if entry and entry.get("loadStatus") == "LOADED":
            return
        time.sleep(2)
    raise RuntimeError(
        f"Location {location_name!r} did not finish loading on BD {bd_name!r} within {timeout_s}s."
    )


async def _refresh_defs_state(project: Project, deployment: str, location_name: str) -> None:
    """Lift app-managed component state into first-class definitions.

    `setAppManagedComponent` writes to a server-side state bag but does
    NOT re-materialize the location's defs from that bag. Without this
    call, the state exists but no schedule/job/sensor surfaces — the
    location page shows the raw component attributes and nothing else.

    This is Dagster+'s canonical "state → defs" step. It also handles
    the re-serve internally, so a separate `reloadRepositoryLocation`
    is not needed."""
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            deployment,
            project.dagster_plus_token or "",
            REFRESH_DEFS_STATE_MUTATION,
            {"locationName": location_name},
        )
    except DagsterPlusError as e:
        print(f"[preview] refreshDefsState failed for {deployment}/{location_name}: {e}")
        return
    payload = (data or {}).get("refreshDefsState") or {}
    tname = payload.get("__typename")
    if tname != "WorkspaceEntry":
        print(f"[preview] refreshDefsState returned {tname}: {payload.get('message')}")


async def _registered_app_managed_types(
    project: Project, deployment: str, location_name: str,
) -> list[dict]:
    """Return the location's `isAppManaged=True` component types as
    `[{'namespace', 'name'}, ...]`. Used to resolve a draft's local
    componentType string to the exact registered type-id — the write
    APIs accept any string, but `refreshDefsState` silently drops
    entries whose type isn't registered."""
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            deployment,
            project.dagster_plus_token or "",
            COMPONENT_TYPES_QUERY,
            {"locationName": location_name},
        )
    except DagsterPlusError as e:
        print(f"[preview] componentTypes query failed for {deployment}/{location_name}: {e}")
        return []
    payload = (data or {}).get("componentTypesForLocationOrError") or {}
    if payload.get("__typename") != "ComponentTypes":
        print(f"[preview] componentTypes returned {payload.get('__typename')}: {payload.get('message')}")
        return []
    return [t for t in (payload.get("componentTypes") or []) if t.get("isAppManaged")]


def _resolve_component_type(draft_type: str, registered: list[dict]) -> str:
    """Match a draft's componentType against the location's registered
    app-managed types.

    Match precedence:
      1. Exact match on `namespace.name` — draft already has the correct id.
      2. Same class name (last dot segment) — the common Designer bug is
         a truncated module path (e.g. draft has
         `hooli_data_eng.components.ScheduledJobComponent` but the location
         registers `hooli_data_eng.hooli_data_eng.components.ScheduledJobComponent`
         because of the `dagster_dg.plugin` entry-point package prefix).
      3. No match — return draft_type unchanged; the write will succeed
         but refresh will silently drop it, and the caller can log.
    """
    if not registered:
        return draft_type
    draft_class = draft_type.rsplit(".", 1)[-1]

    for t in registered:
        if f"{t['namespace']}.{t['name']}" == draft_type:
            return draft_type

    class_matches = [t for t in registered if t["name"].rsplit(".", 1)[-1] == draft_class]
    if len(class_matches) == 1:
        t = class_matches[0]
        return f"{t['namespace']}.{t['name']}"
    return draft_type


async def _find_installer_instance(project: Project, bd_name: str, location_name: str) -> dict | None:
    """Look up the community_component_installer instance on a location,
    if one is present in the state bag. Returns `{component_id,
    component_type, components: [...current list...]}` or None."""
    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            bd_name,
            project.dagster_plus_token or "",
            APP_MANAGED_COMPONENTS_QUERY,
            {"locationName": location_name},
        )
    except DagsterPlusError:
        return None
    payload = (data or {}).get("appManagedComponentsForLocationOrError") or {}
    if payload.get("__typename") != "AppManagedComponents":
        return None
    for c in (payload.get("components") or []):
        ctype = c.get("componentType") or ""
        if "CommunityComponentInstallerComponent" not in ctype:
            continue
        try:
            attrs = _yaml.safe_load(c.get("attributes") or "") or {}
        except Exception:
            attrs = {}
        components = attrs.get("components") or []
        if not isinstance(components, list):
            components = []
        return {
            "component_id": c.get("componentId"),
            "component_type": ctype,
            "attributes_raw": c.get("attributes") or "",
            "components": [str(x) for x in components],
        }
    return None


async def _ensure_installer_lists_community_id(
    project: Project,
    bd_name: str,
    location_name: str,
    catalog_id: str,
) -> dict:
    """If the target has a `community_component_installer` instance AND
    `catalog_id` isn't already in its `components:` list, mutate the
    installer's state to add it and refresh defs.

    Effect: on the next refreshDefsState, the installer downloads
    `catalog_id`'s source files into the location's state directory,
    so subsequent asset defs referencing that class actually load.

    Returns:
      {"action": "added" | "already-present" | "no-installer" | "error",
       "message": <human-readable summary>, "components": <new list>}"""
    installer = await _find_installer_instance(project, bd_name, location_name)
    if installer is None:
        return {"action": "no-installer", "message": "No community_component_installer on target — falling back to direct sync (class must already exist in code)."}
    # Strip version pins on comparison (`postgres_resource@v1.2.0` → `postgres_resource`).
    current_ids = [item.split("@", 1)[0].strip() for item in installer["components"]]
    if catalog_id in current_ids:
        return {"action": "already-present", "message": f"'{catalog_id}' is already in the installer's list — no update needed.", "components": installer["components"]}

    # Append to the list and write back via setAppManagedComponent.
    new_components = list(installer["components"]) + [catalog_id]
    new_attrs_yaml = _yaml.safe_dump(
        {"components": new_components, "install_pip_requirements": True},
        sort_keys=False,
        default_flow_style=False,
    )
    try:
        r = await dp_query(
            project.dagster_plus_org or "",
            bd_name,
            project.dagster_plus_token or "",
            SET_APP_MANAGED_COMPONENT_MUTATION,
            {
                "locationName": location_name,
                "componentId": installer["component_id"],
                "componentType": installer["component_type"],
                "attributes": new_attrs_yaml,
            },
        )
    except DagsterPlusError as e:
        return {"action": "error", "message": f"setAppManagedComponent failed while updating installer: {e}"}
    payload = (r or {}).get("setAppManagedComponent") or {}
    if payload.get("__typename") != "SetAppManagedComponentSuccess":
        return {"action": "error", "message": f"installer update rejected: {payload.get('message') or payload.get('__typename')}"}

    # Refresh so the installer actually downloads the new component.
    # This is the slow step — installer has to fetch from GitHub.
    await _refresh_defs_state(project, bd_name, location_name)
    return {
        "action": "added",
        "message": f"Added '{catalog_id}' to installer; refresh triggered — source will download on the next load.",
        "components": new_components,
    }


async def _apply_drafts(
    project: Project,
    bd_name: str,
    location_name: str,
    drafts: list[Draft],
) -> list[dict]:
    """Fire `setAppManagedComponent` per draft, then refresh defs.
    Any failure short-circuits — partial preview state is confusing.

    Resolves each draft's `component_type` against the location's
    actually-registered app-managed types before writing, because
    `setAppManagedComponent` accepts any string but `refreshDefsState`
    silently drops entries whose type doesn't map to a registered class.

    When a draft references a community-catalog component that isn't
    already registered as a type on the target, first mutates the
    community_component_installer's state to include it — so the
    installer downloads the source on refresh, THEN the draft's own
    setAppManagedComponent has a real class to resolve against.
    Unlocks the "install new components without a PR" iteration flow."""
    # Load the manifest once for the community-catalog lookup below.
    _manifest_by_id: dict[str, dict] = {}
    try:
        from . import genie_service as _genie
        _mfx = await _genie.fetch_manifest()
        _manifest_by_id = {c.get("id"): c for c in (_mfx.get("components") or [])}
    except Exception as e:
        print(f"[preview] manifest fetch for installer-driven sync failed (non-fatal): {e}")

    registered = await _registered_app_managed_types(project, bd_name, location_name)
    registered_names = {t.get("name") for t in registered}
    installer_actions: list[dict] = []

    # If any draft references a community component whose class isn't
    # yet in the location's registered types, ensure the installer's
    # `components:` list includes it, then refresh defs.
    for d in drafts:
        class_name = d.component_type.rsplit(".", 1)[-1]
        # Find the catalog entry whose class-name-last-segment matches.
        catalog_id: str | None = None
        for seg in d.component_type.split("."):
            if seg in _manifest_by_id:
                catalog_id = seg
                break
        # Only trigger installer-driven install when: (a) we recognize it
        # as a community-catalog component, and (b) the class isn't
        # already loaded (registered by name).
        if catalog_id and class_name not in registered_names and catalog_id != "community_component_installer":
            action = await _ensure_installer_lists_community_id(
                project, bd_name, location_name, catalog_id,
            )
            installer_actions.append({"draft_id": d.id, "catalog_id": catalog_id, **action})

    # After the installer downloads new source and refresh runs, re-read
    # registered types so the resolver below has the fresh set.
    if any(a.get("action") == "added" for a in installer_actions):
        registered = await _registered_app_managed_types(project, bd_name, location_name)

    applied: list[dict] = []
    for d in drafts:
        resolved_type = _resolve_component_type(d.component_type, registered)
        if resolved_type != d.component_type:
            print(f"[preview] Resolved {d.component_type} → {resolved_type} (draft {d.id})")
        inner = _extract_inner_attributes(d.attributes)
        try:
            r = await dp_query(
                project.dagster_plus_org or "",
                bd_name,
                project.dagster_plus_token or "",
                SET_APP_MANAGED_COMPONENT_MUTATION,
                {
                    "locationName": location_name,
                    "componentId": d.component_id,
                    "componentType": resolved_type,
                    "attributes": inner,
                },
            )
        except DagsterPlusError as e:
            raise RuntimeError(
                f"setAppManagedComponent failed for {d.component_id}: {e}"
            ) from e
        payload = (r or {}).get("setAppManagedComponent") or {}
        tname = payload.get("__typename")
        if tname != "SetAppManagedComponentSuccess":
            msg = payload.get("message") or tname or "unknown error"
            raise RuntimeError(f"setAppManagedComponent rejected {d.component_id}: {msg}")
        applied.append({"draft_id": d.id, "component_id": d.component_id})

    # State is written; make it visible. `refreshDefsState` re-reads
    # the state bag and rebuilds the location's def payload so the
    # schedule/job/sensor actually exists as a first-class definition.
    # It internally re-materializes the location — a separate
    # `reloadRepositoryLocation` is not needed (and racing it here
    # returned 400s while the refresh was still in flight).
    #
    # Without this step, `setAppManagedComponent` succeeds silently
    # and the user sees the raw attribute bag on the location page
    # but no schedule/job/sensor — the classic "state saved but
    # nothing shows up" failure mode.
    if applied:
        await _refresh_defs_state(project, bd_name, location_name)

    # Return both the per-draft "applied" list and the installer actions
    # so the caller (boot_remote_preview) can surface installer-driven
    # side effects to the UI. Backwards-compatible: existing code that
    # only reads `applied` still works via unpacking or list-index.
    return applied, installer_actions   # type: ignore[return-value]


# --- orchestration --------------------------------------------------------

def _webserver_url_for_bd(project: Project, bd_name: str, location_name: str | None = None) -> str:
    """Human-friendly URL for the BD's Dagster+ UI. When we know the
    specific location, deep-link to its detail page so the user lands
    where their draft's jobs / schedules / assets actually show up
    instead of the deployment root."""
    org = (project.dagster_plus_org or "").strip()
    for suffix in (".dagster.cloud", ".dagster.plus"):
        if org.endswith(suffix):
            org = org.rsplit(suffix, 1)[0]
    base = f"https://{org}.dagster.cloud/{bd_name}"
    if location_name:
        return f"{base}/locations/{location_name}"
    return base


# Registry keyed by (project_id, base_deployment, location_name).
# In-memory for fast access, but hydrated from disk on module load and
# persisted after every mutation so a Designer restart doesn't orphan
# the BDs we've created.
_remote_previews: dict[tuple[str, str, str], dict] = _load_persisted()


async def boot_remote_preview(
    project: Project,
    base_deployment: str,
    location_name: str,
    drafts: list[Draft],
) -> dict:
    """One-shot: create BD (or reuse existing) + attach location + apply drafts.

    Returns state the UI can render + link to."""
    if not project.is_dagster_plus:
        raise RuntimeError("Remote preview is only meaningful for Dagster+ projects.")

    key = (project.id, base_deployment, location_name)
    existing = _remote_previews.get(key)

    if existing is None:
        # Classify the target deployment to pick the fastest safe path:
        # - Branch target: it's already ephemeral + prod-safe. Skip the
        #   BD-create dance and apply state directly. ~1s round-trip
        #   instead of ~30-90s.
        # - Long-lived target: cannot state-mutate prod. Fork a fresh BD
        #   off it, reuse the image on the new location, wait for load,
        #   then apply drafts.
        classification = await _classify_deployment(project, base_deployment)
        if classification["is_branch"]:
            bd_name = base_deployment
            bd_id = None                    # not ours; teardown skips
            fresh_bd_created = False
        else:
            branch_hint = f"designer/{project.id[:8]}-{base_deployment[:12]}-{location_name}"
            bd_name, bd_id = await _create_bd(project, base_deployment, branch_hint)
            meta = await _location_metadata(project, base_deployment, location_name)
            await _add_location_to_bd(project, bd_name, location_name, meta)
            await _wait_for_location(project, bd_name, location_name)
            fresh_bd_created = True
    else:
        bd_name = existing["bd_name"]
        bd_id = existing["bd_id"]
        fresh_bd_created = existing.get("fresh_bd_created", False)

    applied, installer_actions = await _apply_drafts(project, bd_name, location_name, drafts)

    state = {
        "kind": "remote",
        "bd_name": bd_name,
        "bd_id": bd_id,
        # True = we created a fresh isolated BD; teardown should delete it.
        # False = state applied to a pre-existing BD (typically the target
        # branch deployment itself); teardown skips deletion.
        "fresh_bd_created": fresh_bd_created,
        "base_deployment": base_deployment,
        "location_name": location_name,
        "webserver_url": _webserver_url_for_bd(project, bd_name, location_name),
        "graphql_url": _graphql_url(project.dagster_plus_org or "", bd_name),
        "drafts_applied": applied,
        "draft_count": len(drafts),
        # Installer-driven install actions taken during this apply. When
        # any entry has action=="added", the user gained access to a new
        # community component in the target BD without a PR — the
        # session's main UX unlock.
        "installer_actions": installer_actions,
    }
    _remote_previews[key] = state
    _persist(_remote_previews)
    return state


async def prewarm_remote_preview(
    project: Project,
    base_deployment: str,
    location_name: str,
) -> dict:
    """Fire the BD-creation half of `boot_remote_preview` without
    applying any drafts. Used as fire-and-forget on draft save so the
    long wait happens in the background — by the time the user clicks
    Cloud later, the BD is warm and the click just applies drafts (~1s).

    No-op when the target is a branch deployment (fast path already
    handles that with ~1s state-mutation on demand — nothing to warm)."""
    if not project.is_dagster_plus:
        return {"skipped": "not-dagster-plus"}

    key = (project.id, base_deployment, location_name)
    if key in _remote_previews:
        # Already warm — nothing to do.
        return {"skipped": "already-warm", "state": _remote_previews[key]}

    classification = await _classify_deployment(project, base_deployment)
    if classification["is_branch"]:
        return {"skipped": "branch-target-uses-fast-path"}

    branch_hint = f"designer/{project.id[:8]}-{base_deployment[:12]}-{location_name}"
    bd_name, bd_id = await _create_bd(project, base_deployment, branch_hint)
    meta = await _location_metadata(project, base_deployment, location_name)
    await _add_location_to_bd(project, bd_name, location_name, meta)
    await _wait_for_location(project, bd_name, location_name)

    state = {
        "kind": "remote",
        "bd_name": bd_name,
        "bd_id": bd_id,
        "fresh_bd_created": True,
        "base_deployment": base_deployment,
        "location_name": location_name,
        "webserver_url": _webserver_url_for_bd(project, bd_name, location_name),
        "graphql_url": _graphql_url(project.dagster_plus_org or "", bd_name),
        "drafts_applied": [],           # populated on first boot / sync
        "draft_count": 0,
    }
    _remote_previews[key] = state
    _persist(_remote_previews)
    return {"warmed": True, "state": state}


async def resolve_defs_yaml_type(
    project: Project,
    base_deployment: str,
    location_name: str,
    state_component_type: str,
) -> str | None:
    """Return the correct `type:` value for a `defs.yaml` file, given the
    state-registry component type string.

    Two forms exist for the same class:
      - State registry (what `componentTypesForLocationOrError` returns
        as `namespace.name` and what `setAppManagedComponent` accepts):
        `hooli_data_eng.hooli_data_eng.components.ScheduledJobComponent`
      - Python import path (what `defs.yaml`'s `type:` field must be to
        load via `importlib`): `hooli_data_eng.components.ScheduledJobComponent`

    The state form prefixes the actual module path with the entry-point
    package name (`dagster_dg.plugin`), which is fine for the state bag
    but not for `import`. Dagster+ hands us the correct import form via
    each ComponentType's `example` field, which contains a valid
    `defs.yaml` snippet. We parse that.

    Returns None if we can't resolve — callers should fall back to the
    input string (best-effort — better a wrong write than a failed
    promote when we can't reach Dagster+)."""
    if not project.is_dagster_plus:
        return None

    # Query the location's registered types. If the target's the base
    # deployment (fast path fork resolution or explicit BD target),
    # query directly. Otherwise prefer the applied BD from the preview
    # registry so we're introspecting the same environment we wrote to.
    key = (project.id, base_deployment, location_name)
    state = _remote_previews.get(key)
    query_target = (state or {}).get("bd_name") or base_deployment

    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            query_target,
            project.dagster_plus_token or "",
            COMPONENT_TYPES_QUERY,
            {"locationName": location_name},
        )
    except DagsterPlusError:
        return None
    payload = (data or {}).get("componentTypesForLocationOrError") or {}
    if payload.get("__typename") != "ComponentTypes":
        return None

    class_name = state_component_type.rsplit(".", 1)[-1]
    for t in payload.get("componentTypes") or []:
        registered = f"{t.get('namespace','')}.{t.get('name','')}"
        # Match by full registered string OR just class name (Designer
        # may have already resolved to a shorter form — see _resolve_component_type).
        if registered != state_component_type and t.get("name") != class_name:
            continue
        example = t.get("example") or ""
        # Parse the first `type:` line in the example YAML. Robust to
        # leading whitespace, quotes, and comment lines.
        for raw_line in example.splitlines():
            line = raw_line.strip()
            if line.startswith("#") or not line:
                continue
            if line.startswith("type:"):
                v = line.split(":", 1)[1].strip().strip('"').strip("'")
                if v:
                    return v
        break
    return None


async def list_installed_community_components(
    project: Project,
    base_deployment: str,
    location_name: str,
) -> dict:
    """Return the community-catalog IDs currently installed on a target
    location — read from the `community_component_installer`'s
    `components:` YAML list in the state bag.

    Powers Designer's AddComponentModal "already installed" indicator:
    when the user picks a target, the picker marks matching community
    components with a checkmark so the user knows they don't need to
    re-install.

    Returns `{checked, installed: [id, ...], installer_present: bool}`
    or `{checked: False, reason}` if the introspection fails.
    Best-effort — the picker degrades gracefully to "no annotation"
    when this returns `checked: False`."""
    if not project.is_dagster_plus:
        return {"checked": False, "reason": "not-dagster-plus"}

    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            base_deployment,
            project.dagster_plus_token or "",
            APP_MANAGED_COMPONENTS_QUERY,
            {"locationName": location_name},
        )
    except DagsterPlusError as e:
        return {"checked": False, "reason": f"introspection failed: {e}"}

    payload = (data or {}).get("appManagedComponentsForLocationOrError") or {}
    if payload.get("__typename") != "AppManagedComponents":
        return {"checked": False, "reason": f"unexpected response: {payload.get('__typename')}"}

    installer_present = False
    installed: list[str] = []
    for c in (payload.get("components") or []):
        ctype = c.get("componentType") or ""
        # Match any component whose class name ends in the installer's
        # marker — the actual namespace varies by how the class was
        # discovered but the class name is stable.
        if "CommunityComponentInstallerComponent" not in ctype:
            continue
        installer_present = True
        # Parse the installer's attributes YAML to extract components.
        try:
            attrs = _yaml.safe_load(c.get("attributes") or "") or {}
        except Exception:
            continue
        items = attrs.get("components") or []
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, str):
                    continue
                # Strip version pins: `postgres_resource@v1.2.0` → `postgres_resource`
                cid = item.split("@", 1)[0].strip()
                if cid:
                    installed.append(cid)
    return {
        "checked": True,
        "installer_present": installer_present,
        "installed": sorted(set(installed)),
    }


async def check_resources_for_promote(
    project: Project,
    base_deployment: str,
    location_name: str,
    required_services: list[str],
) -> dict:
    """Pre-promote check for design-doc §7 (environment awareness).

    Given a set of `resource:<service>` names the promoted component
    declared in its manifest's `consumes` field, query the target
    deployment for its top-level resources and check whether each
    required service is matched.

    Matching is lenient — a required service matches when any of the
    location's resources has:
      • a `name` containing the service substring, OR
      • a `resourceType` class name containing the service substring
        (case-insensitive)

    Returns a dict shaped like:
      {
        "checked": True,
        "resources_available": ["api", "dbt", "snowflake_prod"],
        "matches": [{"service": "snowflake", "matched_by": "snowflake_prod (resource name)"}],
        "missing":  [{"service": "kafka", "reason": "no resource matches"}],
      }

    Best-effort — if the introspection call fails or the deployment
    isn't reachable, returns `{"checked": False, "reason": ...}` so
    the promote itself doesn't fail on a soft check."""
    if not project.is_dagster_plus:
        return {"checked": False, "reason": "not-dagster-plus"}
    if not required_services:
        return {"checked": True, "matches": [], "missing": [], "resources_available": []}

    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            base_deployment,
            project.dagster_plus_token or "",
            LOCATION_RESOURCES_QUERY,
            {"locationName": location_name, "repositoryName": "__repository__"},
        )
    except DagsterPlusError as e:
        return {"checked": False, "reason": f"introspection failed: {e}"}

    payload = (data or {}).get("repositoryOrError") or {}
    if payload.get("__typename") != "Repository":
        return {"checked": False, "reason": f"location not found or errored: {payload.get('__typename')}"}
    resources = payload.get("allTopLevelResourceDetails") or []
    resource_names = [r.get("name") for r in resources]

    matches: list[dict] = []
    missing: list[dict] = []
    for service in required_services:
        s_lo = service.lower()
        match = None
        for r in resources:
            r_name = (r.get("name") or "").lower()
            r_type = (r.get("resourceType") or "").lower()
            if s_lo in r_name:
                match = {"service": service, "matched_by": f'{r["name"]} (resource name)'}
                break
            if s_lo in r_type:
                match = {"service": service, "matched_by": f'{r["name"]} → {r["resourceType"]} (resource type)'}
                break
        if match:
            matches.append(match)
        else:
            missing.append({
                "service": service,
                "reason": "no resource on the location matches the service name",
            })

    return {
        "checked": True,
        "resources_available": resource_names,
        "matches": matches,
        "missing": missing,
    }


async def clear_preview_state_for_draft(
    project: Project,
    base_deployment: str,
    location_name: str,
    component_id: str,
) -> dict:
    """Remove a draft's `setAppManagedComponent` entry from Dagster+ after
    it's been promoted to a PR.

    Called by `promote_draft` right after the PR is opened. Rationale:
    once the draft lives in git, the PR-triggered branch deployment will
    materialize the component from code. Leaving the state entry around
    would give the location TWO copies of the same component_id on
    reload — a state-vs-code conflict that shows up as a duplicate-
    definition load error.

    Resolves the actual BD name from the remote-preview registry (fast
    path applies state to the target BD directly; slow path applies it
    to a Designer-forked BD). If neither is present the write may have
    landed on the base deployment itself; try that too so we don't
    leave orphans anywhere.

    Best-effort — a failed delete doesn't fail the promote. Returns a
    small status dict for logging."""
    if not project.is_dagster_plus:
        return {"skipped": "not-dagster-plus"}

    # Prefer the BD we applied to (either the customer's BD via fast
    # path or Designer's forked BD via slow path).
    key = (project.id, base_deployment, location_name)
    state = _remote_previews.get(key)
    target_deployment = (state or {}).get("bd_name") or base_deployment

    try:
        data = await dp_query(
            project.dagster_plus_org or "",
            target_deployment,
            project.dagster_plus_token or "",
            DELETE_APP_MANAGED_COMPONENT_MUTATION,
            {"locationName": location_name, "componentId": component_id},
        )
    except DagsterPlusError as e:
        print(f"[promote] state cleanup failed for {component_id} on {target_deployment}/{location_name}: {e}")
        return {"cleared": False, "reason": str(e), "deployment": target_deployment}

    payload = (data or {}).get("deleteAppManagedComponent") or {}
    tname = payload.get("__typename")
    if tname != "DeleteAppManagedComponentSuccess":
        msg = payload.get("message") or tname or "unknown"
        print(f"[promote] state cleanup returned {tname}: {msg}")
        return {"cleared": False, "reason": msg, "deployment": target_deployment}

    # Refresh so the location's def list actually forgets the entry.
    await _refresh_defs_state(project, target_deployment, location_name)
    return {"cleared": True, "deployment": target_deployment}


async def teardown_remote_preview(project: Project, base_deployment: str, location_name: str) -> None:
    """Delete the BD via GraphQL and drop it from the local registry.
    Only deletes BDs Designer created — if we applied state to a
    pre-existing branch deployment (fast path), the BD isn't ours to
    tear down, so we just clear the local registry entry.
    Best-effort otherwise — a stale BD is annoying but not harmful."""
    key = (project.id, base_deployment, location_name)
    state = _remote_previews.pop(key, None)
    _persist(_remote_previews)
    if state is None:
        return
    if not state.get("fresh_bd_created"):
        # Fast path — nothing to delete on Dagster+'s side.
        return
    bd_id = state.get("bd_id")
    if not isinstance(bd_id, int):
        return
    try:
        await dp_query(
            project.dagster_plus_org or "",
            base_deployment,
            project.dagster_plus_token or "",
            DELETE_DEPLOYMENT_MUTATION,
            {"deploymentId": bd_id},
        )
    except DagsterPlusError:
        # Not fatal — leave the BD orphaned. User can nuke via Dagster+ UI.
        pass


def list_remote_previews(project: Project) -> list[dict]:
    """Everything the frontend can show as active remote previews for
    a project. Cheap in-memory lookup.

    Recomputes `webserver_url` on every read so entries persisted before
    URL-shape changes (e.g. adding the `/locations/<name>` deep-link)
    don't serve stale URLs — the URL is a pure function of `bd_name` +
    `location_name`, both of which we keep on the entry."""
    out: list[dict] = []
    for (pid, _, _), s in _remote_previews.items():
        if pid != project.id:
            continue
        s = {**s, "webserver_url": _webserver_url_for_bd(project, s["bd_name"], s.get("location_name"))}
        out.append(s)
    return out
