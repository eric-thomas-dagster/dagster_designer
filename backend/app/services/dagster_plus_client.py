"""Thin GraphQL client for Dagster+ deployments.

Every Dagster+ deployment has a GraphQL endpoint at
`https://<org>.dagster.plus/<deployment>/graphql`. Authenticated with
a user token via the `Dagster-Cloud-Api-Token` header. This module
gives us a single place to build the URL, attach the header, and
issue queries — all of the read-only surfaces (assets, checks, runs,
lineage) call into it.

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
    """Build the deployment's GraphQL endpoint. Trims accidental
    whitespace + protocol so users can paste the URL or the bare org."""
    o = (org or "").strip().replace("https://", "").replace("http://", "").split("/", 1)[0]
    d = (deployment or "prod").strip()
    if o.endswith(".dagster.plus"):
        # Users sometimes paste the full host — strip the suffix so we
        # end up with the bare org name.
        o = o.rsplit(".dagster.plus", 1)[0]
    if o.endswith(".dagster.cloud"):
        o = o.rsplit(".dagster.cloud", 1)[0]
    return f"https://{o}.dagster.plus/{d}/graphql"


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
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            r = await client.post(
                url,
                headers={
                    "Dagster-Cloud-Api-Token": token,
                    "content-type": "application/json",
                },
                json={"query": gql, "variables": variables or {}},
            )
        except httpx.HTTPError as e:
            raise DagsterPlusError(
                f"Couldn't reach Dagster+ at {url}: {e}. Check your org name, deployment, and network."
            ) from e
    if r.status_code == 401 or r.status_code == 403:
        raise DagsterPlusError("Dagster+ rejected the token — verify it's a valid user token with read access.")
    if r.status_code >= 400:
        raise DagsterPlusError(f"Dagster+ returned HTTP {r.status_code}: {r.text[:400]}")
    body = r.json()
    if body.get("errors"):
        # GraphQL surfaces query-level errors even on HTTP 200. Fold
        # them into one string so the frontend can surface it.
        msgs = "; ".join(e.get("message", "") for e in body["errors"])
        raise DagsterPlusError(f"GraphQL errors: {msgs}")
    return body.get("data") or {}


# --- Query catalog ----------------------------------------------------------
# Small library of common GraphQL queries we run against Dagster+.
# They mirror the ones OSS Dagster's GraphiQL exposes, so users can
# copy them into their own tooling if they want.


PING_QUERY = """
query DagsterPlusPing {
  version
}
"""

ASSETS_QUERY = """
query DagsterPlusAssets {
  assetsOrError {
    __typename
    ... on AssetConnection {
      nodes {
        id
        key {
          path
        }
        definition {
          groupName
          description
          computeKind
          isSource
          isPartitioned
          partitionDefinition { name description type }
          assetKey { path }
          dependencyKeys { path }
          dependedByKeys { path }
        }
      }
    }
    ... on PythonError {
      message
      stack
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
