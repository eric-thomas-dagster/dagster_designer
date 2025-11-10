# State-Backed Components (Dagster 1.12+)

## Overview

**State-backed components** were introduced in Dagster 1.12 to enable components that maintain state across materializations. This is crucial for incremental data loading, change data capture (CDC), and maintaining sync state.

## What Are State-Backed Components?

### Traditional Components
```python
# Regular component - stateless
class MyComponent(Component):
    def build_defs(self, context):
        # No memory of previous runs
        @asset
        def my_asset():
            return load_all_data()  # Reloads everything
```

### State-Backed Components
```python
# State-backed component - maintains state
class MyStatefulComponent(Component):
    def build_defs(self, context):
        @asset
        def my_asset(context):
            # Access state from previous run
            last_sync = context.instance.get_asset_state(...)
            return load_incremental_data(since=last_sync)
```

## Use Cases

### 1. Incremental Loading
```yaml
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
  # Fivetran maintains sync state automatically
  # Only loads changed records since last sync
```

**State Maintained:**
- Last sync timestamp
- Watermark for each table
- Row counts and changes

### 2. CDC (Change Data Capture)
```yaml
type: dagster_dlt.DltLoadCollectionComponent
attributes:
  loads:
    - source: .loads.database_cdc
      pipeline: .loads.cdc_pipeline
  # dlt tracks CDC position automatically
```

**State Maintained:**
- CDC log position
- Transaction IDs processed
- Schema versions

### 3. API Pagination
```yaml
type: custom.APILoaderComponent
attributes:
  api_endpoint: https://api.example.com/data
  # Component remembers last page/cursor
```

**State Maintained:**
- Last cursor/page token
- Last successful fetch timestamp
- Records processed count

## How State Works

### State Storage

Dagster stores component state in the instance storage (database):

```
dagster_instance_db/
└── component_state/
    ├── fivetran_sync/
    │   ├── salesforce_accounts: {last_sync: "2024-01-15T10:00:00Z"}
    │   └── hubspot_contacts: {last_sync: "2024-01-15T10:05:00Z"}
    └── dlt_pipeline/
        └── database_cdc: {position: "log_pos:12345"}
```

### Accessing State

```python
# In component build_defs
def build_defs(self, context: ComponentLoadContext):
    @asset
    def my_asset(context: AssetExecutionContext):
        # Get previous state
        state = context.instance.get_dynamic_partitions("state_key")

        # Load data incrementally
        data = fetch_data_since(state.last_timestamp)

        # Update state
        context.instance.add_dynamic_partitions(
            "state_key",
            {"last_timestamp": datetime.now()}
        )

        return data
```

## Component Examples

### Fivetran (State-Backed)

**State Managed:**
- Connector sync timestamps
- Table-level watermarks
- Schema changes

**YAML:**
```yaml
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
    api_key: "{{ env.FIVETRAN_API_KEY }}"
  connector_selector:
    by_name:
      - salesforce_connector
  # State automatically maintained by Fivetran
```

**What Happens:**
1. First run: Full sync
2. Subsequent runs: Incremental sync based on saved state
3. Fivetran tracks last_modified timestamps per table

### dlt (State-Backed)

**State Managed:**
- Source-specific cursors
- Schema evolution tracking
- Last successful load time

**YAML:**
```yaml
type: dagster_dlt.DltLoadCollectionComponent
attributes:
  loads:
    - source: .loads.github_source
      pipeline: .loads.github_pipeline
  # dlt maintains state in state directory
```

**What Happens:**
1. First run: Full load
2. Subsequent runs: Incremental based on saved cursors
3. dlt stores state in `~/.dlt/pipelines/`

### Sling (State-Backed)

**State Managed:**
- Replication watermarks
- Batch processing state
- Last successful run

**YAML:**
```yaml
type: dagster_sling.SlingReplicationCollectionComponent
attributes:
  replications:
    - path: ./replication.yaml
  # Sling tracks incremental sync state
```

## Designer Integration

### In the UI

When configuring a state-backed component:

```
┌────────────────────────────────────────┐
│ 🏭 Asset Factory Component             │
│ 📊 State-Backed (Incremental Loading)  │ ← New indicator
│                                        │
│ This component maintains state across  │
│ materializations for incremental data  │
│ loading.                               │
└────────────────────────────────────────┘
```

### Asset Preview

State-backed components show special indicators:

```
Generated Assets (127 assets)

┌────────────────────────────────────────┐
│ fivetran/salesforce/accounts           │
│ Group: salesforce                      │
│ 📊 Incremental (state-backed)          │ ← Indicator
│ Last sync: 2024-01-15 10:00:00        │ ← State info
└────────────────────────────────────────┘
```

## Configuration Considerations

### State Reset

Sometimes you need to reset state (full reload):

```python
# Reset Fivetran connector state
POST /api/fivetran/v1/connectors/{id}/force-update

# Or delete state manually
dagster instance delete-state --asset-key fivetran/salesforce/accounts
```

### State Cleanup

Old state can accumulate:

```bash
# Clean up old state
dagster instance clean-state --older-than 30d
```

### State Backup

Important for disaster recovery:

```bash
# Backup instance database (includes state)
pg_dump dagster_instance > backup.sql
```

## Best Practices

### 1. Design for Idempotency

Even with state, assets should be idempotent:

```python
@asset
def my_asset(context):
    state = get_state()

    # Load incrementally
    new_data = fetch_since(state.last_timestamp)

    # But ensure idempotency
    if not new_data:
        return load_current_snapshot()

    return new_data
```

### 2. Handle State Corruption

```python
@asset
def my_asset(context):
    try:
        state = get_state()
    except StateCorruptionError:
        # Fallback to full reload
        state = None
        context.log.warning("State corrupted, doing full reload")

    return load_data(since=state.last_timestamp if state else None)
```

### 3. Monitor State Growth

```python
@asset
def my_asset(context):
    state_size = get_state_size()

    if state_size > MAX_STATE_SIZE:
        # Compact or reset state
        compact_state()

    return load_data()
```

### 4. Document State Schema

```yaml
# In component YAML, add comments
type: dagster_fivetran.FivetranAccountComponent
attributes:
  workspace:
    account_id: my_account
# State schema:
# - last_sync: ISO timestamp of last successful sync
# - table_watermarks: Dict[table_name, timestamp]
# - row_counts: Dict[table_name, int]
```

## Testing State-Backed Components

### Test Incremental Loading

```python
def test_incremental_loading():
    # First run
    result1 = materialize_asset(my_asset)
    assert len(result1) == 1000  # Full load

    # Second run (with state)
    result2 = materialize_asset(my_asset)
    assert len(result2) == 10  # Only new records
```

### Test State Reset

```python
def test_state_reset():
    # Load with state
    result1 = materialize_asset(my_asset)

    # Reset state
    instance.delete_asset_state(my_asset.key)

    # Should do full reload
    result2 = materialize_asset(my_asset)
    assert len(result2) == 1000
```

## Migration to State-Backed Components

### Before (Stateless)

```yaml
type: custom.MyComponent
attributes:
  full_reload: true  # Always reloads everything
```

### After (State-Backed)

```yaml
type: custom.MyStatefulComponent
attributes:
  incremental: true  # Uses state for incremental loads
```

**Migration Steps:**
1. Update component to use state
2. Test incremental loading
3. Deploy new version
4. Monitor state growth
5. Set up state backup/cleanup

## Troubleshooting

### State Not Persisting

**Problem:** State resets on each run

**Solutions:**
- Check instance database is writable
- Verify state storage configuration
- Ensure asset key is consistent

### State Growing Too Large

**Problem:** State size increasing unbounded

**Solutions:**
- Implement state compaction
- Use rolling windows for historical data
- Periodically reset old state

### Inconsistent State

**Problem:** State doesn't match actual data

**Solutions:**
- Add state validation
- Implement state reconciliation
- Force full reload if drift detected

## Resources

- [Dagster 1.12 Release Notes](https://dagster.io/blog/dagster-1-12-monster-mash)
- [State-Backed Components Guide](https://docs.dagster.io/guides/build/components/state-backed-components)
- [Component State API](https://docs.dagster.io/\_apidocs/components#state)

## Summary

**State-backed components** enable:
✅ Incremental data loading
✅ CDC (Change Data Capture)
✅ API pagination/cursor tracking
✅ Efficient sync operations
✅ Reduced data transfer and processing

**Key Points:**
- State stored in Dagster instance database
- Automatic state management by many built-in components
- Fallback to full reload on state issues
- Monitor and clean up state regularly
- Test incremental behavior thoroughly

**In the Designer:**
- 📊 indicator for state-backed components
- State information in asset preview
- Automatic handling of state by Dagster CLI
