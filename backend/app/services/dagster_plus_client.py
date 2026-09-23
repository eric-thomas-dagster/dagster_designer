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


def _region_host_suffix(region: str | None) -> str:
    """Dagster+ hosts every org, the MCP server, and agents under
    `dagster.cloud` for the US region and `eu.dagster.cloud` for the EU
    region (e.g. `mcp.agent.dagster.cloud` vs `mcp.agent.eu.dagster.cloud`,
    `<org>.dagster.cloud` vs `<org>.eu.dagster.cloud`) -- always the same
    "insert `eu.` right before `dagster.cloud`" pattern. `dg plus login
    --region eu` is the CLI's equivalent explicit switch; we mirror that
    same two-value concept rather than trying to infer region from the
    org name."""
    return "eu.dagster.cloud" if (region or "us").strip().lower() == "eu" else "dagster.cloud"


def _graphql_url(org: str, deployment: str, region: str | None = None) -> str:
    """Build the org's GraphQL endpoint. Trims accidental whitespace +
    protocol so users can paste the URL or the bare org. When the
    deployment is empty (or 'none'), we hit the top-level org
    endpoint -- some orgs (esp. Hybrid setups) expose GraphQL there
    rather than at the per-deployment path."""
    o = (org or "").strip().replace("https://", "").replace("http://", "").split("/", 1)[0]
    d = (deployment or "").strip()
    # Users sometimes paste the full host -- strip common suffixes
    # (including the EU variant) so re-adding the right one below is
    # never doubled up.
    for suffix in (".eu.dagster.cloud", ".dagster.cloud", ".dagster.plus"):
        if o.endswith(suffix):
            o = o.rsplit(suffix, 1)[0]
    host_suffix = _region_host_suffix(region)
    if not d or d.lower() in ("none", "-"):
        return f"https://{o}.{host_suffix}/graphql"
    return f"https://{o}.{host_suffix}/{d}/graphql"


async def query(
    org: str,
    deployment: str,
    token: str,
    gql: str,
    variables: dict | None = None,
    timeout: float = 30.0,
    region: str | None = None,
) -> dict[str, Any]:
    """Run a GraphQL query against the deployment. Returns the top-level
    `data` object or raises DagsterPlusError with a helpful message."""
    if not org or not token:
        raise DagsterPlusError("Dagster+ connection needs both org and token.")
    url = _graphql_url(org, deployment, region)
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


async def probe_default_deployment(org: str, token: str, timeout: float = 10.0, region: str | None = None) -> str | None:
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
    url = _graphql_url(org, "", region)
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


def org_base_url(org: str, region: str | None = None) -> str:
    """The org's web UI base URL (not GraphQL) -- e.g.
    `https://hooli.dagster.cloud` or `https://hooli.eu.dagster.cloud`.
    Shared by every "Open in Dagster+" deep link on the backend so the
    region-suffix logic lives in exactly one place."""
    o = (org or "").strip().replace("https://", "").replace("http://", "").split("/", 1)[0]
    for suffix in (".eu.dagster.cloud", ".dagster.cloud", ".dagster.plus"):
        if o.endswith(suffix):
            o = o.rsplit(suffix, 1)[0]
    return f"https://{o}.{_region_host_suffix(region)}"


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
    repository {
      location {
        name
      }
    }
    isPartitioned
    isExecutable
    isMaterializable
    isObservable
    jobNames
    hasAssetChecks
    # The legacy `freshnessPolicy` field is unpopulated on every asset in
    # every deployment we've checked (superseded by internalFreshnessPolicy
    # -- a union, since Dagster now supports two different policy shapes).
    internalFreshnessPolicy {
      __typename
      ... on TimeWindowFreshnessPolicy { failWindowSeconds warnWindowSeconds }
      ... on CronFreshnessPolicy { deadlineCron lowerBoundDeltaSeconds timezone }
    }
    freshnessStatusInfo {
      freshnessStatus
      freshnessStatusMetadata {
        ... on AssetHealthFreshnessMeta { lastMaterializedTimestamp }
      }
    }
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
query DagsterRuns($limit: Int!, $cursor: String, $filter: RunsFilter) {
  runsOrError(limit: $limit, cursor: $cursor, filter: $filter) {
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


# Deliberately NOT expanding notificationService/alertTargets into inline
# fragments beyond __typename -- Dagster+'s concrete types there (e.g.
# WebhookAlertPolicyNotification.webhookUrl vs the very similarly-named
# but wrong webhookURL) are easy to get subtly wrong, and __typename alone
# is enough to humanize into "Slack" / "Email" / etc for a read-only view.
ALERT_POLICIES_QUERY = """
query DagsterPlusAlertPolicies {
  alertPolicies {
    id
    name
    description
    enabled
    eventTypes
    notificationService { __typename }
    alertTargets { __typename }
    source
    mutedUntil
  }
}
"""


# Secret VALUES (not just names -- see utilizedEnvVarsOrError above, which
# only gives names + consumers) come from secretsOrError. canViewSecretValue
# reflects the calling token's actual permission; secretValue is still
# present but should be treated as inaccessible/redacted when that's false
# rather than trusted at face value.
SECRETS_QUERY = """
query DagsterPlusSecrets {
  secretsOrError {
    __typename
    ... on Secrets {
      secrets {
        id
        secretName
        secretValue
        fullDeploymentScope
        allBranchDeploymentsScope
        specificBranchDeploymentScope
        localDeploymentScope
        locationNames
        canViewSecretValue
        canEditSecret
      }
    }
    ... on UnauthorizedError { message }
    ... on PythonError { message }
  }
}
"""


# Fetched alongside the plain `alertPolicies` list (which has `id`, needed
# for mute/delete) -- this one gives the full per-policy document (richer:
# actual Slack channel names / email addresses, not just "this uses Slack")
# and is also the exact shape createOrUpdateAlertPolicyFromDocument expects
# back, so it doubles as what a "raw edit" UI would show pre-filled.
ALERT_POLICIES_DOCUMENT_QUERY = """
query DagsterPlusAlertPoliciesDocument {
  alertPoliciesAsDocumentOrError {
    __typename
    ... on AlertPoliciesAsDocument { document }
    ... on PythonError { message }
    ... on UnauthorizedError { message }
  }
}
"""

CREATE_OR_UPDATE_ALERT_POLICY_MUTATION = """
mutation CreateOrUpdateAlertPolicy($document: GenericScalar!) {
  createOrUpdateAlertPolicyFromDocument(document: $document) {
    __typename
    ... on AlertPolicy { id name }
    ... on InvalidAlertPolicyError { message }
    ... on CodeBackedAlertPolicyError { message alertPolicyName }
    ... on PythonError { message }
    ... on UnauthorizedError { message }
  }
}
"""

DELETE_ALERT_POLICY_MUTATION = """
mutation DeleteAlertPolicy($name: String!) {
  deleteAlertPolicy(alertPolicyName: $name) {
    __typename
    ... on DeleteAlertPolicySuccess { alertPolicyName }
    ... on CodeBackedAlertPolicyError { message alertPolicyName }
    ... on PythonError { message }
    ... on UnauthorizedError { message }
  }
}
"""

SET_ALERT_POLICY_MUTE_MUTATION = """
mutation SetAlertPolicyMute($id: String!, $seconds: Int) {
  setAlertPolicyMuteUntil(alertPolicyId: $id, muteForSeconds: $seconds) {
    __typename
    ... on AlertPolicy { id mutedUntil }
    ... on PythonError { message }
    ... on UnauthorizedError { message }
  }
}
"""


# Read-only names + what consumes them (no values -- see SECRETS_QUERY
# above for those). Kept in case a future "unused secrets" or "what
# references this var" view wants it; not currently called.
UTILIZED_ENV_VARS_QUERY = """
query DagsterPlusUtilizedEnvVars($repositorySelector: RepositorySelector) {
  utilizedEnvVarsOrError(repositorySelector: $repositorySelector) {
    __typename
    ... on EnvVarWithConsumersList {
      results { envVarName envVarConsumers { type name } }
    }
    ... on PythonError { message }
  }
}
"""

CREATE_SECRET_MUTATION = """
mutation CreateSecret($name: String!, $value: String!, $scopes: SecretScopesInput!, $locationNames: [String!]) {
  createSecret(secretName: $name, secretValue: $value, scopes: $scopes, locationNames: $locationNames) {
    __typename
    ... on CreateOrUpdateSecretSuccess { secret { id secretName } }
    ... on TooManySecretsError { message }
    ... on InvalidSecretInputError { message }
    ... on SecretAlreadyExistsError { message }
    ... on UnauthorizedError { message }
    ... on PythonError { message }
  }
}
"""

UPDATE_SECRET_MUTATION = """
mutation UpdateSecret($id: String!, $name: String!, $value: String!, $scopes: SecretScopesInput!, $locationNames: [String!]) {
  updateSecret(secretId: $id, secretName: $name, secretValue: $value, scopes: $scopes, locationNames: $locationNames) {
    __typename
    ... on CreateOrUpdateSecretSuccess { secret { id secretName } }
    ... on TooManySecretsError { message }
    ... on InvalidSecretInputError { message }
    ... on SecretAlreadyExistsError { message }
    ... on UnauthorizedError { message }
    ... on PythonError { message }
  }
}
"""

DELETE_SECRET_MUTATION = """
mutation DeleteSecret($id: String!) {
  deleteSecret(secretId: $id) {
    __typename
    ... on DeleteSecretSuccess { secretId }
    ... on UnauthorizedError { message }
    ... on PythonError { message }
  }
}
"""


# Jobs -- listed via repositoriesOrError.nodes[].pipelines rather than a
# dedicated jobs query (Dagster+'s schema still calls them "pipelines"
# internally). __ASSET_JOB entries are Dagster's own auto-generated
# "materialize everything" job for each repo, not something a user
# created -- filtered out by the caller, not here, since that's a display
# decision, not a data-fetching one.
JOBS_QUERY = """
query DagsterPlusJobs {
  repositoriesOrError {
    __typename
    ... on RepositoryConnection {
      nodes {
        name
        location { name }
        pipelines {
          name
          description
          isJob
          schedules { name cronSchedule scheduleState { status } }
          sensors { name sensorState { status } }
        }
      }
    }
    ... on PythonError { message }
  }
}
"""

LAUNCH_RUN_MUTATION = """
mutation LaunchRun($selector: JobOrPipelineSelector!) {
  launchRun(executionParams: { selector: $selector }) {
    __typename
    ... on LaunchRunSuccess { run { runId } }
    ... on RunConfigValidationInvalid { errors { message } }
    ... on PipelineNotFoundError { message }
    ... on InvalidSubsetError { message }
    ... on RunConflict { message }
    ... on UnauthorizedError { message }
    ... on PythonError { message }
    ... on NoModeProvidedError { message }
    ... on ConflictingExecutionParamsError { message }
  }
}
"""


# Lighter than ASSETS_QUERY (no groupName/description/etc) -- just enough
# per-asset materialization timestamps to reconstruct something close to
# the local ingestion_history.jsonl event shape (see
# app/services/ingestion_history.py) for the Ingestions tab's KPIs/trend
# chart. Every returned event IS a materialization (Dagster only emits
# these on success), so no separate status field is needed the way a run
# listing would need one. `rows`/`bytes` have no Dagster+ GraphQL
# equivalent (they're parsed from local materialize output, not a
# standard Dagster concept) and are simply absent for cloud events.
ASSET_MATERIALIZATIONS_QUERY = """
query DagsterPlusAssetMaterializations($limit: Int!) {
  assetNodes {
    assetKey { path }
    assetMaterializations(limit: $limit) {
      timestamp
      runId
    }
  }
}
"""


# Per-partition materialization status -- covers the two common partition
# shapes (a flat set of static keys, and a time-window cadence like
# daily/hourly). Multi-dimensional partitions come back as a different
# union member (MultiPartitionStatuses) that this doesn't request fields
# for, so the caller sees an empty assetPartitionStatuses object for
# those and falls back to "not supported yet" rather than erroring.
ASSET_PARTITION_STATUS_QUERY = """
query DagsterPlusAssetPartitionStatus($assetKey: AssetKeyInput!) {
  assetNodeOrError(assetKey: $assetKey) {
    __typename
    ... on AssetNode {
      partitionKeys
      assetPartitionStatuses {
        __typename
        ... on DefaultPartitionStatuses {
          materializedPartitions
          failedPartitions
          materializingPartitions
        }
        ... on TimePartitionStatuses {
          ranges {
            startKey
            endKey
            status
          }
        }
      }
    }
  }
}
"""


# allTopLevelResourceDetails gives module-level resources/IO managers per
# repository -- resourceType is the real Python class path (e.g.
# "dagster_snowflake_pandas.snowflake_pandas_type_handler.SnowflakePandasIOManager"),
# which is how the caller tells IO managers apart from plain resources
# (name-based heuristics like local's "if 'io_manager' in name" don't hold
# for arbitrary resource names).
RESOURCES_QUERY = """
query DagsterPlusResources {
  repositoriesOrError {
    __typename
    ... on RepositoryConnection {
      nodes {
        name
        location { name }
        allTopLevelResourceDetails {
          name
          description
          resourceType
        }
      }
    }
    ... on PythonError { message }
  }
}
"""
