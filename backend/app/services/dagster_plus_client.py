"""Thin GraphQL client for Dagster+ deployments.

Every Dagster+ org has a GraphQL endpoint at either:
  • `https://<org>.dagster.cloud/graphql` (top-level; multi-deployment orgs)
  • `https://<org>.dagster.cloud/<deployment>/graphql` (per-deployment)

Authenticated with a user token via the `Dagster-Cloud-Api-Token`
header. This module gives us a single place to build the URL, attach
the header, and issue queries -- all of the read-only surfaces
(assets, checks, runs, lineage) call into it.

We keep it minimal on purpose: no schema-derived typing, no caching
layer yet. A follow-up can add cache + retries once we know which
queries are hot.
"""
from __future__ import annotations

from typing import Any

import httpx


class DagsterPlusError(RuntimeError):
    """Raised when a GraphQL call fails (auth, network, or GraphQL errors).
    Preserved separately from generic RuntimeError so callers can
    surface a helpful "check your token / connection" message."""


def _graphql_url(org: str, deployment: str) -> str:
    """Build the org's GraphQL endpoint. Trims accidental whitespace +
    protocol so users can paste the URL or the bare org. When the
    deployment is empty (or 'none'), we hit the top-level org
    endpoint -- some orgs (esp. Hybrid setups) expose GraphQL there
    rather than at the per-deployment path."""
    o = (org or "").strip().replace("https://", "").replace("http://", "").split("/", 1)[0]
    d = (deployment or "").strip()
    # Users sometimes paste the full host -- strip common suffixes.
    for suffix in (".dagster.cloud", ".dagster.plus"):
        if o.endswith(suffix):
            o = o.rsplit(suffix, 1)[0]
    if not d or d.lower() in ("none", "-"):
        return f"https://{o}.dagster.cloud/graphql"
    return f"https://{o}.dagster.cloud/{d}/graphql"


async def query(
    org: str,
    deployment: str,
    token: str,
    gql: str,
    variables: dict | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Run a GraphQL query against the deployment. Returns the top-level
    `data` object or raises DagsterPlusError with a helpful message."""
    if not org or not token:
        raise DagsterPlusError("Dagster+ connection needs both org and token.")
    url = _graphql_url(org, deployment)
    # Handle POST redirects ourselves. httpx's follow_redirects=True
    # sometimes returns HTML from the redirect target when the POST
    # body isn't re-issued cleanly. Manually chase up to 3 3xx hops.
    headers = {"Dagster-Cloud-Api-Token": token, "content-type": "application/json"}
    body = {"query": gql, "variables": variables or {}}
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        try:
            r = await client.post(url, headers=headers, json=body)
            hops = 0
            while r.status_code in (301, 302, 303, 307, 308) and hops < 3:
                loc = r.headers.get("location") or r.headers.get("Location")
                if not loc:
                    break
                if loc.startswith("/"):
                    from urllib.parse import urlsplit
                    base = urlsplit(url)
                    loc = f"{base.scheme}://{base.netloc}{loc}"
                url = loc
                r = await client.post(url, headers=headers, json=body)
                hops += 1
        except httpx.HTTPError as e:
            raise DagsterPlusError(
                f"Couldn't reach Dagster+ at {url}: {e}. Check your org name, deployment, and network."
            ) from e
    if r.status_code == 401 or r.status_code == 403:
        raise DagsterPlusError("Dagster+ rejected the token -- verify it's a valid user token with read access.")
    if r.status_code >= 400:
        raise DagsterPlusError(f"Dagster+ returned HTTP {r.status_code}: {r.text[:400]}")
    body = r.json()
    if body.get("errors"):
        # GraphQL surfaces query-level errors even on HTTP 200. Fold
        # them into one string so the frontend can surface it.
        msgs = "; ".join(e.get("message", "") for e in body["errors"])
        raise DagsterPlusError(f"GraphQL errors: {msgs}")
    return body.get("data") or {}


async def probe_default_deployment(org: str, token: str, timeout: float = 10.0) -> str | None:
    """Hit the org-level /graphql and read the deployment name out of
    the 3xx redirect target. This is the only authoritative signal for
    "what is this org's default deployment" -- the fullDeployments
    GraphQL query returns deploymentType='PRODUCTION' for every full
    deployment, so it can't distinguish `data-eng-prod` from
    `data-eng-dev` on its own.

    Returns the deployment name (e.g. 'data-eng-prod') or None if the
    org endpoint didn't redirect (unusual) or the target URL wasn't
    parseable."""
    if not org or not token:
        return None
    url = _graphql_url(org, "")
    headers = {"Dagster-Cloud-Api-Token": token, "content-type": "application/json"}
    body = {"query": "query { __typename }", "variables": {}}
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            r = await client.post(url, headers=headers, json=body)
            if r.status_code not in (301, 302, 303, 307, 308):
                return None
            loc = r.headers.get("location") or r.headers.get("Location")
            if not loc:
                return None
            # Redirect target looks like:
            #   https://hooli.dagster.cloud/data-eng-prod/graphql
            #   /data-eng-prod/graphql (relative)
            from urllib.parse import urlsplit
            path = urlsplit(loc).path if "://" in loc else loc
            # Strip leading slash and trailing "/graphql" -> deployment name
            path = path.strip("/")
            if path.endswith("/graphql"):
                path = path[: -len("/graphql")].strip("/")
            return path or None
    except httpx.HTTPError:
        return None


# --- Query catalog ----------------------------------------------------------
# Small library of common GraphQL queries we run against Dagster+.
# They mirror the ones OSS Dagster's GraphiQL exposes, so users can
# copy them into their own tooling if they want.


PING_QUERY = """
query DagsterPlusPing {
  version
}
"""

# Consolidated per-asset shape — one query gets us the asset key,
# its full lineage (both edges in and out), definition metadata,
# every attached check with latest execution, and any schedules /
# sensors targeting it. Cuts the hydrate call count from 3+ to 2
# (this + the per-repository schedule/sensor listings for the
# Automation tab). Uses assetNodes rather than assetsOrError because
# the latter's definition sub-object is missing `dependencyKeys`
# fields in some deployments -- assetNodes surfaces them cleanly.
ASSETS_QUERY = """
query DagsterPlusAssets {
  assetNodes {
    id
    assetKey { path }
    groupName
    description
    computeKind
    isPartitioned
    isExecutable
    isMaterializable
    isObservable
    jobNames
    hasAssetChecks
    tags { key value }
    owners {
      __typename
      ... on UserAssetOwner { email }
      ... on TeamAssetOwner { team }
    }
    dependencyKeys { path }
    dependedByKeys { path }
    metadataEntries {
      __typename
      label
      description
      ... on TableSchemaMetadataEntry {
        schema {
          columns {
            name
            type
            description
          }
        }
      }
    }
    assetChecksOrError(limit: 1000) {
      __typename
      ... on AssetChecks {
        checks {
          name
          description
          jobNames
          blocking
          canExecuteIndividually
          executionForLatestMaterialization {
            id
            runId
            status
            timestamp
            evaluation {
              timestamp
              severity
              description
              success
            }
          }
        }
      }
      # AssetChecksOrError union in the Dagster+ schema does NOT
      # include PythonError -- adding it fails query-wide with
      # "Fragment cannot be spread here". Migration / user-code /
      # agent-upgrade error types would go here if we cared to
      # surface them separately; for now we treat non-AssetChecks
      # responses as "no checks available."
    }
    targetingInstigators {
      __typename
      ... on Schedule {
        id
        name
        cronSchedule
        pipelineName
      }
      ... on Sensor {
        id
        name
        sensorType
      }
    }
  }
}
"""

ASSET_CHECKS_QUERY = """
query DagsterPlusAssetChecks {
  assetChecksOrError {
    __typename
    ... on AssetChecks {
      checks {
        name
        description
        assetKey { path }
        canExecuteIndividually
        executionForLatestMaterialization {
          id
          status
          evaluation {
            timestamp
            severity
            targetMaterialization { runId storageId timestamp }
            metadataEntries {
              label
              description
            }
          }
        }
      }
    }
    ... on PythonError { message stack }
  }
}
"""


DEPLOYMENTS_QUERY = """
query DagsterPlusDeployments {
  fullDeployments {
    deploymentName
    deploymentId
    deploymentType
    deploymentStatus
  }
}
"""


REPOSITORIES_QUERY = """
query DagsterPlusRepositories {
  repositoriesOrError {
    __typename
    ... on RepositoryConnection {
      nodes {
        name
        location { name }
      }
    }
    ... on PythonError { message }
  }
}
"""


# schedulesOrError and sensorsOrError both REQUIRE a RepositorySelector
# at the Dagster+ deployment layer, so callers enumerate repositories
# first (via REPOSITORIES_QUERY) then run these once per repo. The
# `repositorySelector` variable takes {repositoryLocationName,
# repositoryName}.
SCHEDULES_QUERY = """
query DagsterPlusSchedules($repositorySelector: RepositorySelector!) {
  schedulesOrError(repositorySelector: $repositorySelector) {
    __typename
    ... on Schedules {
      results {
        id
        name
        cronSchedule
        pipelineName
        description
        scheduleState { status }
      }
    }
    ... on RepositoryNotFoundError { message }
    ... on PythonError { message }
  }
}
"""


# metadata.assetKeys is where sensor-to-asset association lives when
# the sensor targets specific assets. Missing when the sensor only
# targets jobs, which is fine -- we degrade to "no linked asset".
SENSORS_QUERY = """
query DagsterPlusSensors($repositorySelector: RepositorySelector!) {
  sensorsOrError(repositorySelector: $repositorySelector) {
    __typename
    ... on Sensors {
      results {
        id
        name
        description
        sensorType
        sensorState { status }
        targets { pipelineName }
        metadata {
          assetKeys { path }
        }
      }
    }
    ... on RepositoryNotFoundError { message }
    ... on PythonError { message }
  }
}
"""


# Asset checks are best fetched through assetNodes, which lets us
# also pull hasAssetChecks + jobNames + a cursor-friendly limit.
# The top-level assetChecksOrError we were using earlier isn't the
# documented shape at the deployment layer.
ASSET_NODES_WITH_CHECKS_QUERY = """
query DagsterPlusAssetNodes($checkLimit: Int) {
  assetNodes {
    assetKey { path }
    groupName
    jobNames
    hasAssetChecks
    assetChecksOrError(limit: $checkLimit) {
      __typename
      ... on AssetChecks {
        checks {
          name
          description
          assetKey { path }
          jobNames
          blocking
          canExecuteIndividually
          executionForLatestMaterialization {
            id
            runId
            status
            timestamp
            evaluation {
              timestamp
              severity
              description
              success
            }
          }
        }
      }
      ... on PythonError { message }
    }
    targetingInstigators {
      __typename
      ... on Schedule {
        id
        name
        cronSchedule
        pipelineName
      }
      ... on Sensor {
        id
        name
        sensorType
        targets { pipelineName }
      }
    }
  }
}
"""


ASSET_CHECK_HISTORY_QUERY = """
query DagsterPlusAssetCheckHistory(
  $assetKey: AssetKeyInput!, $checkName: String!, $limit: Int!, $cursor: String
) {
  assetCheckExecutions(
    assetKey: $assetKey, checkName: $checkName, limit: $limit, cursor: $cursor
  ) {
    id
    runId
    status
    timestamp
    stepKey
    evaluation {
      timestamp
      checkName
      success
      severity
      description
      metadataEntries {
        __typename
        label
        description
      }
    }
  }
}
"""


RUNS_QUERY = """
query DagsterPlusRuns($limit: Int!) {
  runsOrError(limit: $limit) {
    __typename
    ... on Runs {
      results {
        runId
        status
        startTime
        endTime
        pipelineName
        stats {
          ... on RunStatsSnapshot {
            stepsSucceeded
            stepsFailed
            materializations
          }
        }
      }
    }
    ... on PythonError { message stack }
  }
}
"""
