import { describe, expect, it } from 'vitest';
import {
  connectionNote, deriveOnChange, isReplicationSchema, replicationKind, replicationLayout, replicationStepErrors, suggestEnvVarName,
} from './replicationWizard';

const dbRep: Record<string, any> = {
  asset_name: {}, source_connection_env_var: {}, target_connection_env_var: {}, source_type: {}, target_type: {},
  source_table: {}, target_table: {}, mode: {}, incremental_column: {}, primary_key: {}, select_columns: {}, where_clause: {},
  group_name: {}, description: {}, owners: {}, asset_tags: {}, kinds: {}, deps: {}, source_connection: {}, target_connection: {},
};
const names = (e: { name: string }[]) => e.map((x) => x.name);

describe('replicationKind / isReplicationSchema', () => {
  it('recognises both components in either type shape', () => {
    expect(replicationKind('dagster_community_components.DatabaseReplicationComponent')).toBe('database_replication');
    expect(replicationKind('ds.components.sql_to_database_asset.component.SQLToDatabaseAssetComponent')).toBe('sql_to_database_asset');
    expect(replicationKind('ds.components.shopify_ingestion.component.X')).toBeNull();
    expect(isReplicationSchema('dagster_community_components.DatabaseReplicationComponent', dbRep)).toBe(true);
    expect(isReplicationSchema('dagster_community_components.DatabaseReplicationComponent', {})).toBe(false);
  });
});

describe('replicationLayout (database_replication)', () => {
  const { steps, moreGroups } = replicationLayout('database_replication', dbRep);
  const step = (k: string) => names(steps.find((s) => s.key === k)!.entries);
  it('splits the form into source, target, and tables (ending with the asset name)', () => {
    expect(step('source')).toEqual(['source_type', 'source_connection_env_var']);
    expect(step('target')).toEqual(['target_type', 'target_connection_env_var']);
    expect(step('tables')).toEqual(['source_table', 'target_table', 'mode', 'incremental_column', 'primary_key', 'asset_name']);
  });
  it('tucks everything else under optional settings, nothing lost', () => {
    const more = Object.fromEntries(moreGroups.map((g) => [g.key, names(g.entries)]));
    expect(more.advanced).toEqual(['select_columns', 'where_clause', 'source_connection', 'target_connection']);
    expect(more.metadata).toEqual(expect.arrayContaining(['group_name', 'description', 'owners', 'asset_tags', 'kinds']));
    const shown = [...steps.flatMap((s) => names(s.entries)), ...moreGroups.flatMap((g) => names(g.entries))];
    expect(new Set(shown)).toEqual(new Set(Object.keys(dbRep)));
    expect(shown.length).toBe(Object.keys(dbRep).length);
  });
});

describe('replicationLayout (sql_to_database_asset)', () => {
  const props: Record<string, any> = {
    asset_name: {}, source_url_env_var: {}, destination_url_env_var: {}, source_table: {}, source_schema: {}, source_query: {},
    destination_table: {}, destination_schema: {}, if_exists: {}, watermark_column: {}, watermark_env_var: {}, chunksize: {},
    column_mapping: {}, source_resource_key: {}, destination_resource_key: {}, partition_type: {}, retry_policy_max_retries: {},
  };
  const { steps, moreGroups } = replicationLayout('sql_to_database_asset', props);
  it('lays out with the same steps and keeps every field reachable', () => {
    expect(names(steps[0].entries)).toEqual(['source_url_env_var', 'source_resource_key']);
    expect(names(steps[1].entries)).toEqual(['destination_url_env_var', 'destination_resource_key']);
    const shown = [...steps.flatMap((s) => names(s.entries)), ...moreGroups.flatMap((g) => names(g.entries))];
    expect(new Set(shown)).toEqual(new Set(Object.keys(props)));
    expect(shown.length).toBe(Object.keys(props).length);
  });
});

describe('deriveOnChange', () => {
  it('suggests a connection env-var name for a chosen database type, never over a typed one', () => {
    expect(deriveOnChange('database_replication', 'source_type', 'postgres', {})).toEqual({ source_connection_env_var: 'POSTGRES_SOURCE_URL' });
    expect(deriveOnChange('database_replication', 'target_type', 'snowflake', {})).toEqual({ target_connection_env_var: 'SNOWFLAKE_TARGET_URL' });
    expect(deriveOnChange('database_replication', 'source_type', 'mysql', { source_connection_env_var: 'MY_OWN' })).toEqual({});
    // switching type re-suggests while the name is still the previous suggestion
    expect(deriveOnChange('database_replication', 'source_type', 'mysql', { source_type: 'postgres', source_connection_env_var: 'POSTGRES_SOURCE_URL' }))
      .toEqual({ source_connection_env_var: 'MYSQL_SOURCE_URL' });
  });
  it('fills target table and asset name from the source table, until the user edits them', () => {
    expect(deriveOnChange('database_replication', 'source_table', 'public.orders', {}))
      .toEqual({ target_table: 'orders', asset_name: 'orders_replica' });
    expect(deriveOnChange('database_replication', 'source_table', 'public.customers', { source_table: 'public.orders', target_table: 'orders', asset_name: 'orders_replica' }))
      .toEqual({ target_table: 'customers', asset_name: 'customers_replica' });
    expect(deriveOnChange('database_replication', 'source_table', 'public.customers', { source_table: 'public.orders', target_table: 'dw.orders_v2', asset_name: 'my_asset' }))
      .toEqual({});
  });
  it('uses destination_table for sql_to_database_asset', () => {
    expect(deriveOnChange('sql_to_database_asset', 'source_table', 'orders', {})).toEqual({ destination_table: 'orders', asset_name: 'orders_replica' });
  });
});

describe('replicationStepErrors', () => {
  it('requires a watermark column and primary key for incremental loads', () => {
    expect(replicationStepErrors('database_replication', 'tables', { mode: 'incremental' })).toHaveLength(2);
    expect(replicationStepErrors('database_replication', 'tables', { mode: 'incremental', incremental_column: 'updated_at', primary_key: ['id'] })).toEqual([]);
    expect(replicationStepErrors('database_replication', 'tables', { mode: 'full_refresh' })).toEqual([]);
  });
  it('needs a connection and a table (or query) for sql_to_database_asset', () => {
    expect(replicationStepErrors('sql_to_database_asset', 'source', {})).toHaveLength(1);
    expect(replicationStepErrors('sql_to_database_asset', 'source', { source_resource_key: 'wh' })).toEqual([]);
    expect(replicationStepErrors('sql_to_database_asset', 'target', { destination_url_env_var: 'X' })).toEqual([]);
    expect(replicationStepErrors('sql_to_database_asset', 'tables', {})).toHaveLength(1);
    expect(replicationStepErrors('sql_to_database_asset', 'tables', { source_query: 'select 1' })).toEqual([]);
  });
});

describe('connectionNote', () => {
  it('explains the env var and shows the URL shape for the chosen database', () => {
    expect(connectionNote('source_connection_env_var', { source_type: 'postgres' })).toContain('postgres://user:password@host:5432/database');
    expect(connectionNote('target_connection_env_var', { target_type: 'snowflake' })).toContain('snowflake://');
    expect(connectionNote('source_url_env_var', {})).toContain('NAME of an environment variable');
    expect(connectionNote('source_table', {})).toBeNull();
  });
  it('suggestEnvVarName sanitises', () => {
    expect(suggestEnvVarName('source', 'sql-server')).toBe('SQL_SERVER_SOURCE_URL');
  });
});
