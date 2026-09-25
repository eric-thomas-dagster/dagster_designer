"""
Fetch the latest materialization metadata for a set of asset keys from a
project's persistent local Dagster instance (see DAGSTER_HOME pinning in
projects.py's materialize_assets -- without a fixed, persistent instance
directory, `dg launch` creates a throwaway one per invocation and this
data is unrecoverable the moment the subprocess exits).

Runs in the project's own venv (like scripts/preview_asset.py) so it
matches whatever dagster version that project has installed -- the
DagsterInstance/MetadataValue API surface isn't guaranteed identical
across versions. Verified against dagster 1.12.19's public API:
`instance.fetch_materializations(AssetKey(...), limit=1)` (the
non-deprecated replacement for get_event_records) returns an
EventRecordsResult whose .records[0].asset_materialization has
.metadata (a dict of label -> MetadataValue) and the containing
.event_log_entry.timestamp.

Usage: python -m scripts.extract_run_metadata <dagster_home> <asset_key1,asset_key2,...>
Asset keys with a "/" are split into a multi-segment AssetKey (matching
how Designer represents multi-part keys as slash-joined strings
elsewhere); keys with no "/" become a single-segment AssetKey.

Prints one JSON object to stdout:
    {"<asset_key>": {"timestamp": 1234567.89, "metadata": [
        {"label": "...", "description": null, "type": "float", "value": ...}, ...
    ]}, ...}
`type`/`value` are normalized into the SAME {label, description, type,
value} shape (and the same lowercase type enum: float/int/text/markdown/
url/path/json/bool/timestamp/other) that
dagster_plus_client.normalize_metadata_entries produces for cloud
projects -- see _METADATA_TYPE_MAP below, which mirrors that module's
map one-for-one (MetadataValue class names vs the GraphQL
MetadataEntry typenames it's keyed on, e.g. FloatMetadataValue <->
FloatMetadataEntry). Frontend code (MetadataEntryList) renders both
local and cloud events through the one shape without knowing which
produced it. A MetadataValue variant with no cloud equivalent in that
map (Table, TableSchema, Notebook, PythonArtifact, asset/job/run
references, ...) becomes type="other"/value=None here too, for the
exact same reason: predictable behavior regardless of source, not
"local shows more than cloud ever could."

An asset key with no materialization yet, or one that errors, is simply
omitted (or carries an "error" string) -- never raises, so a bad key in
the batch doesn't lose the others.
"""
import sys
import json
import warnings

# Same reasoning as preview_asset.py: a stray DeprecationWarning/UserWarning
# printed to stdout would corrupt the single JSON line the caller parses.
warnings.filterwarnings('ignore')


_METADATA_TYPE_MAP = {
    "FloatMetadataValue": "float",
    "IntMetadataValue": "int",
    "TextMetadataValue": "text",
    "MarkdownMetadataValue": "markdown",
    "UrlMetadataValue": "url",
    "PathMetadataValue": "path",
    "JsonMetadataValue": "json",
    "BoolMetadataValue": "bool",
    "TimestampMetadataValue": "timestamp",
}


def _serialize_value(v):
    """MetadataValue.value can be almost anything (float/int/str/dict/
    list/TableSchema/...) -- coerce whatever isn't already JSON-safe to a
    string rather than crashing json.dumps on an exotic type."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (list, dict)):
        try:
            json.dumps(v)
            return v
        except TypeError:
            return str(v)
    return str(v)


def _normalize_entry(label, mv):
    entry_type = _METADATA_TYPE_MAP.get(type(mv).__name__)
    if entry_type is None:
        return {"label": label, "description": None, "type": "other", "value": None}
    return {
        "label": label,
        "description": None,
        "type": entry_type,
        "value": _serialize_value(getattr(mv, "value", None)),
    }


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: extract_run_metadata.py <dagster_home> <asset_keys>"}))
        sys.exit(1)

    dagster_home = sys.argv[1]
    asset_keys = [k for k in sys.argv[2].split(",") if k]

    try:
        from dagster import DagsterInstance, AssetKey
    except Exception as e:
        print(json.dumps({"error": f"Could not import dagster: {e}"}))
        sys.exit(1)

    out: dict = {}
    try:
        instance = DagsterInstance.from_config(dagster_home)
    except Exception as e:
        print(json.dumps({"error": f"Failed to open instance at {dagster_home}: {e}"}))
        sys.exit(1)

    for asset_key in asset_keys:
        try:
            path = asset_key.split("/") if "/" in asset_key else [asset_key]
            result = instance.fetch_materializations(AssetKey(path), limit=1)
        except Exception as e:
            out[asset_key] = {"error": str(e)}
            continue
        if not result.records:
            continue
        record = result.records[0]
        mat = record.asset_materialization
        entries = [_normalize_entry(label, mv) for label, mv in (mat.metadata or {}).items()]
        out[asset_key] = {
            "timestamp": record.event_log_entry.timestamp,
            "metadata": entries,
        }

    print(json.dumps(out))


if __name__ == "__main__":
    main()
