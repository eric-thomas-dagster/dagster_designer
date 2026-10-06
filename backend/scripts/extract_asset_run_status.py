"""
Fetch the latest run status (success or failure) per asset key from a
project's persistent local Dagster instance (same `.designer_dagster_home`
pinning as extract_run_metadata.py -- see the DAGSTER_HOME comment in
projects.py's materialize_assets).

Why this exists: Dagster's local OSS GraphQL schema has no single
"last run status" field on AssetNode, and `assetMaterializations` only
ever records SUCCESSFUL materializations -- a run that fails leaves no
materialization event, so a naive "latest materialization" read can't
tell "never run" and "last run failed" apart.

Two more specific mechanisms were tried and ruled out before landing on
plain run status (verified live against a real local instance, not
assumed):
  - `DagsterInstance.get_asset_materialization_health_state_for_assets`
    (the "asset health" concept dagster+'s own Catalog is built on) is a
    STUB in OSS dagster-core -- `return {k: None for k in asset_keys}` --
    not an implementation.
  - `DagsterInstance.fetch_failed_materializations` (AssetFailedToMaterialize
    events) requires `instance.can_read_asset_failure_events()`, which is
    False for a standard local instance -- confirmed via a real
    success-then-failure test fixture; the failure never appeared.

What DOES work, confirmed the same way: every `DagsterRun` carries a
`status` (SUCCESS/FAILURE/...) and an `asset_selection` (the exact set of
asset keys that invocation targeted) -- both populated by ordinary,
always-on run storage, no opt-in feature needed. Verified live: a real
`dagster asset materialize --select <key>` run correctly set
`asset_selection={AssetKey([key])}`, which is exactly the launch
mechanism Designer's own materialize_assets endpoint uses (`dg launch
--assets ...`). So: pull the N most recent runs once, and for each
requested asset key take the status of the newest run whose
asset_selection contains it.

Usage: python -m scripts.extract_asset_run_status <dagster_home> <asset_key1,asset_key2,...>
Asset keys with a "/" are split into a multi-segment AssetKey (matching
how Designer represents multi-part keys as slash-joined strings
elsewhere); keys with no "/" become a single-segment AssetKey.

Prints one JSON object to stdout:
    {"<asset_key>": {"status": "success"|"failure", "timestamp": 1234567.89, "run_id": "..."}, ...}
An asset key with no run that selected it yet (never run) is simply
omitted -- never raises, so a bad key in the batch doesn't lose the
others.
"""
import sys
import json
import warnings

# Same reasoning as extract_run_metadata.py: a stray warning printed to
# stdout would corrupt the single JSON line the caller parses.
warnings.filterwarnings('ignore')

# How far back to look for a run that selected each asset. Designer's own
# materialize flow fires one `dg launch` per click, so even a moderately
# active project accumulates runs fast -- this just needs to comfortably
# cover "the last time each asset in the project was touched", not every
# run ever.
RUN_SEARCH_LIMIT = 500


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: extract_asset_run_status.py <dagster_home> <asset_keys>"}))
        sys.exit(1)

    dagster_home = sys.argv[1]
    asset_keys = [k for k in sys.argv[2].split(",") if k]

    try:
        from dagster import DagsterInstance, AssetKey
        from dagster._core.storage.dagster_run import DagsterRunStatus
    except Exception as e:
        print(json.dumps({"error": f"Could not import dagster: {e}"}))
        sys.exit(1)

    try:
        instance = DagsterInstance.from_config(dagster_home)
    except Exception as e:
        print(json.dumps({"error": f"Failed to open instance at {dagster_home}: {e}"}))
        sys.exit(1)

    try:
        # Newest-first by default (confirmed live) -- the first match per
        # asset key below is therefore already the most recent one.
        records = instance.get_run_records(limit=RUN_SEARCH_LIMIT)
    except Exception as e:
        print(json.dumps({"error": f"Failed to read run records: {e}"}))
        sys.exit(1)

    target_keys = {}
    for asset_key in asset_keys:
        path = asset_key.split("/") if "/" in asset_key else [asset_key]
        target_keys[asset_key] = AssetKey(path)

    out: dict = {}
    remaining = set(target_keys.keys())
    for rec in records:
        if not remaining:
            break
        run = rec.dagster_run
        if run.status not in (DagsterRunStatus.SUCCESS, DagsterRunStatus.FAILURE):
            continue  # in-progress / queued / canceled runs aren't a "last status" yet
        selection = run.asset_selection or frozenset()
        matched = [ak for ak in remaining if target_keys[ak] in selection]
        for ak in matched:
            out[ak] = {
                "status": "success" if run.status == DagsterRunStatus.SUCCESS else "failure",
                "timestamp": rec.update_timestamp.timestamp(),
                "run_id": run.run_id,
            }
            remaining.discard(ak)

    print(json.dumps(out))


if __name__ == "__main__":
    main()
