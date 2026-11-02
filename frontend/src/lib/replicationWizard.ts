import { classifyGenericField, GENERIC_FIELD_GROUPS } from './genericFields';
import { ingestionComponentKey, type FieldEntry } from './ingestionWizard';
import type { WizardGroup, WizardStepDef } from './wizardTypes';

/**
 * Guided flow for the two table-to-table copy components:
 *   database_replication  (Sling: source/target type + connection env vars, tables, load mode)
 *   sql_to_database_asset (SQLAlchemy copy: source/destination URL env vars or resources, tables, if_exists)
 * Both are "pick a source database, a target database, which table, how to load it".
 */

export type ReplicationKind = 'database_replication' | 'sql_to_database_asset';

export function replicationKind(componentType: string): ReplicationKind | null {
  const key = ingestionComponentKey(componentType);
  return key === 'database_replication' || key === 'sql_to_database_asset' ? key : null;
}

export function isReplicationSchema(componentType: string, properties: Record<string, any> | undefined): boolean {
  return !!properties && replicationKind(componentType) !== null && 'asset_name' in properties;
}

// Field placement per component. Anything a schema lacks is skipped, anything not listed
// falls to the generic boilerplate groups or "Advanced load options".
const LAYOUT: Record<ReplicationKind, { source: string[]; target: string[]; tables: string[] }> = {
  database_replication: {
    source: ['source_type', 'source_connection_env_var'],
    target: ['target_type', 'target_connection_env_var'],
    tables: ['source_table', 'target_table', 'mode', 'incremental_column', 'primary_key'],
  },
  sql_to_database_asset: {
    source: ['source_url_env_var', 'source_resource_key'],
    target: ['destination_url_env_var', 'destination_resource_key'],
    tables: ['source_schema', 'source_table', 'source_query', 'destination_schema', 'destination_table', 'if_exists', 'watermark_column'],
  },
};

const ADVANCED_LOAD = new Set([
  'select_columns', 'where_clause', 'source_connection', 'target_connection', 'watermark_env_var', 'chunksize', 'column_mapping',
]);

export function replicationLayout(
  kind: ReplicationKind,
  properties: Record<string, any>,
): { steps: WizardStepDef[]; moreGroups: WizardGroup[] } {
  const layout = LAYOUT[kind];
  const pick = (names: string[]): FieldEntry[] =>
    names.filter((n) => n in properties).map((n) => ({ name: n, schema: properties[n] }));

  const placed = new Set<string>(['asset_name', ...layout.source, ...layout.target, ...layout.tables]);
  const advanced: FieldEntry[] = [];
  const groups: Record<string, FieldEntry[]> = {};
  for (const [name, schema] of Object.entries(properties)) {
    if (placed.has(name)) continue;
    const g = classifyGenericField(name);
    if (g) (groups[g] ??= []).push({ name, schema });
    else if (ADVANCED_LOAD.has(name)) advanced.push({ name, schema });
    else advanced.push({ name, schema }); // unknown extras stay reachable, just out of the way
  }

  const steps: WizardStepDef[] = [
    { key: 'source', title: 'Source', blurb: 'Which database are you copying from? Credentials stay in an environment variable, not in your project files.', entries: pick(layout.source) },
    { key: 'target', title: 'Target', blurb: 'Where should the copy land?', entries: pick(layout.target) },
    { key: 'tables', title: 'Tables & mode', blurb: 'Which table, whether to reload it fully or only pick up changes, and what to call the asset.', entries: pick([...layout.tables, 'asset_name']) },
  ];
  const moreGroups: WizardGroup[] = [
    { key: 'advanced', label: 'Advanced load options', entries: advanced },
    ...GENERIC_FIELD_GROUPS.map((g) => ({ key: g.key, label: g.label, entries: groups[g.key] ?? [] })),
  ];
  return { steps, moreGroups };
}

const CONNECTION_HINTS: Record<string, string> = {
  postgres: 'postgres://user:password@host:5432/database',
  mysql: 'mysql://user:password@host:3306/database',
  mariadb: 'mysql://user:password@host:3306/database',
  mssql: 'sqlserver://user:password@host:1433?database=name',
  oracle: 'oracle://user:password@host:1521/service_name',
  snowflake: 'snowflake://user:password@account/database/schema?warehouse=WH',
  bigquery: 'bigquery://project?credentials_path=/path/key.json',
  redshift: 'redshift://user:password@host:5439/database',
  databricks: 'databricks://token:TOKEN@host:443/http-path',
  clickhouse: 'clickhouse://user:password@host:9000/database',
  duckdb: 'duckdb:///path/to/file.duckdb',
  sqlite: 'sqlite:///path/to/file.db',
  db2: 'db2://user:password@host:50000/database',
};

/** A one-line "what goes in this variable" note for a connection field, or null. */
export function connectionNote(name: string, values: Record<string, any>): string | null {
  const isEnvVar = /(connection|url)_env_var$/.test(name);
  if (!isEnvVar) return null;
  const side = name.startsWith('source') ? 'source' : 'target';
  const type = String(values[`${side}_type`] ?? '').toLowerCase();
  const hint = CONNECTION_HINTS[type];
  const set = hint
    ? `Type the NAME of an environment variable (not the password). Set it to a URL like ${hint}.`
    : 'Type the NAME of an environment variable (not the password) that holds the connection URL.';
  return set;
}

const ENV_SAFE = /[^A-Z0-9_]/g;

/** Default env-var name for a connection once its database type is known, e.g. POSTGRES_SOURCE_URL. */
export function suggestEnvVarName(side: 'source' | 'target', dbType: string): string {
  return `${dbType.toUpperCase().replace(ENV_SAFE, '_')}_${side.toUpperCase()}_URL`;
}

const bareTable = (t: string): string => t.split('.').pop()!.replace(/["`\[\]]/g, '');

/**
 * Follow-on values when `field` changes, so the user types less:
 *  - choosing a database type fills an empty connection env-var name,
 *  - picking a source table fills an empty (or still auto-filled) target table and asset name.
 * Never overwrites something the user typed.
 */
export function deriveOnChange(
  kind: ReplicationKind,
  field: string,
  value: unknown,
  current: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  if (kind === 'database_replication' && (field === 'source_type' || field === 'target_type') && typeof value === 'string' && value) {
    const side = field === 'source_type' ? 'source' : 'target';
    const envField = `${side}_connection_env_var`;
    const prevAuto = typeof current[`${side}_type`] === 'string' ? suggestEnvVarName(side, current[`${side}_type`]) : '';
    if (!current[envField] || current[envField] === prevAuto) out[envField] = suggestEnvVarName(side, value);
  }
  if (field === 'source_table' && typeof value === 'string') {
    const targetField = kind === 'database_replication' ? 'target_table' : 'destination_table';
    const prevAutoTarget = typeof current.source_table === 'string' ? bareTable(current.source_table) : '';
    if (value && (!current[targetField] || current[targetField] === prevAutoTarget)) out[targetField] = bareTable(value);
    const prevAutoName = prevAutoTarget ? `${prevAutoTarget}_replica` : '';
    if (value && (!current.asset_name || current.asset_name === prevAutoName)) out.asset_name = `${bareTable(value)}_replica`;
  }
  return out;
}

/** Problems beyond "required field empty": either/or and conditional requirements. */
export function replicationStepErrors(kind: ReplicationKind, stepKey: string, v: Record<string, any>): string[] {
  const filled = (n: string) => typeof v[n] === 'string' ? v[n].trim() !== '' : v[n] !== undefined && v[n] !== null && !(Array.isArray(v[n]) && v[n].length === 0);
  const errs: string[] = [];
  if (kind === 'sql_to_database_asset') {
    if (stepKey === 'source' && !filled('source_url_env_var') && !filled('source_resource_key')) {
      errs.push('Give the source connection: an environment variable name, or a registered SQL resource.');
    }
    if (stepKey === 'target' && !filled('destination_url_env_var') && !filled('destination_resource_key')) {
      errs.push('Give the destination connection: an environment variable name, or a registered SQL resource.');
    }
    if (stepKey === 'tables' && !filled('source_table') && !filled('source_query')) {
      errs.push('Choose a source table, or write a source query.');
    }
  }
  if (kind === 'database_replication' && stepKey === 'tables' && v.mode === 'incremental') {
    if (!filled('incremental_column')) errs.push('Incremental loads need a watermark column (e.g. updated_at).');
    if (!filled('primary_key')) errs.push('Incremental loads need a primary key, so changed rows update instead of duplicating.');
  }
  return errs;
}
