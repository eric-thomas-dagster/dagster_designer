import { extractComponentId } from './componentId';
import { classifyGenericField, type GenericFieldGroupKey } from './genericFields';

/**
 * Logic behind the guided "Add data" wizard for SaaS ingestion components
 * (the ~170 `*_ingestion` templates). They all share one shape -- a few
 * connection fields, a few "what to pull" fields, a dlt-style destination
 * block, then the same catalog/scheduling boilerplate -- so the wizard is
 * driven by the component's own schema rather than written per component.
 */

export interface FieldEntry {
  name: string;
  schema: any;
}

export interface WizardFields {
  /** asset_name, credentials and other connection details. */
  connect: FieldEntry[];
  /** Resources, date ranges, filters -- what to pull. */
  load: FieldEntry[];
  /** destination / dataset / credentials for where it lands. */
  destination: FieldEntry[];
  /** Catalog + scheduling boilerplate, kept out of the main flow. */
  more: Record<GenericFieldGroupKey, FieldEntry[]>;
}

// Components with (or planned to have) their own dedicated wizard; the generic
// one must not claim them even though their schemas look similar.
const OWN_WIZARD = new Set([
  'database_replication',
  'sling_replication_asset',
  'sql_to_database_asset',
  'dlt_rest_api_source',
  'dlt_pipeline_assets',
  'dlt_dataframe_writer',
  'rest_api_ingestion',
]);

const DESTINATION_FIELDS = new Set([
  'destination',
  'dataset_name',
  'persist_only',
  'destination_credentials_url',
  'destination_credentials_env_var',
  'bucket_url',
  'athena_query_result_bucket',
]);

const CONNECTION_PATTERN =
  /(key|token|secret|password|passwd|credential|auth|client_id|url|domain|subdomain|host|account|site|workspace|org|tenant|region|username|email|instance|api_version)/i;
const SECRET_PATTERN = /(key|token|secret|password|passwd|credential)/i;

/** The short template id for any component_type shape (`pkg.components.<id>.component.Cls` or `pkg.Cls`). */
export function ingestionComponentKey(componentType: string): string {
  const id = extractComponentId(componentType);
  if (id !== componentType) return id;
  const cls = componentType.split('.').pop() ?? componentType;
  return cls
    .replace(/Component$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** True for a new-instance schema shaped like a SaaS ingestion: it names its asset and either
 *  carries the dlt-style destination block or is a `*_ingestion` template (the DataFrame-only
 *  ones have no destination fields), and no dedicated wizard owns it. */
export function isSaasIngestionSchema(componentType: string, properties: Record<string, any> | undefined): boolean {
  if (!properties || !('asset_name' in properties)) return false;
  const key = ingestionComponentKey(componentType);
  if (OWN_WIZARD.has(key)) return false;
  const hasDestinationBlock = 'destination' in properties && 'destination_credentials_url' in properties;
  return hasDestinationBlock || key.endsWith('_ingestion');
}

export function isSecretField(name: string, schema?: any): boolean {
  // An explicit `x-dagster-secret` in the template's schema.json wins over the name guess.
  if (schema && typeof schema['x-dagster-secret'] === 'boolean') return schema['x-dagster-secret'];
  // `*_env_var` fields already hold the NAME of an environment variable, and `*_resource_key` the key of a resource.
  return SECRET_PATTERN.test(name) && !/(^|_)resource_(key|name)$/.test(name) && !/_env(_var)?$/.test(name);
}

export function classifyIngestionFields(properties: Record<string, any>, required: string[] = []): WizardFields {
  const out: WizardFields = {
    connect: [],
    load: [],
    destination: [],
    more: { metadata: [], freshness: [], partition: [], retry: [], preview: [], dependencies: [] },
  };
  const req = new Set(required);
  for (const [name, schema] of Object.entries(properties)) {
    const lower = name.toLowerCase();
    const entry = { name, schema };
    if (lower === 'asset_name') {
      out.connect.unshift(entry);
      continue;
    }
    if (DESTINATION_FIELDS.has(lower) || schema?.['x-dagster-destination-fields']) {
      out.destination.push(entry);
      continue;
    }
    // An explicit `x-dagster-step` in the template's schema.json wins over the name guesses below.
    const step: unknown = schema?.['x-dagster-step'];
    if (step === 'connect' || step === 'load' || step === 'destination') {
      out[step].push(entry);
      continue;
    }
    if (step === 'advanced') {
      out.more.metadata.push(entry);
      continue;
    }
    const boiler = classifyGenericField(name);
    if (boiler) {
      out.more[boiler].push(entry);
      continue;
    }
    // `partition_*` siblings that don't match the generic patterns (partition_dimensions etc. are matched; these are not)
    if (/^(backfill_|column_lineage$|deps$)/.test(lower)) {
      out.more.partition.push(entry);
      continue;
    }
    const isConnection =
      !(/(^|_)resource_(key|name)$/.test(lower)) && (req.has(name) || CONNECTION_PATTERN.test(lower)) && !/(^|_)(resources|streams)$/.test(lower);
    (isConnection ? out.connect : out.load).push(entry);
  }
  return out;
}

/** Missing required fields among `entries`, judged against the current form values. */
export function missingRequired(entries: FieldEntry[], required: string[], values: Record<string, any>): string[] {
  const req = new Set(required);
  return entries
    .filter((e) => req.has(e.name))
    .filter((e) => {
      const v = values[e.name];
      if (v === undefined || v === null) return true;
      if (typeof v === 'string') return v.trim() === '';
      if (Array.isArray(v)) return v.length === 0;
      return false;
    })
    .map((e) => e.name);
}

/** Options to offer as chips for a field: an explicit `x-dagster-options` list, else an array
 *  field's `items.enum`, else whatever the description lists in prose. */
export function optionsFor(schema: any): string[] {
  const explicit = schema?.['x-dagster-options'];
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.map(String);
  const itemEnum = schema?.items?.enum;
  if (Array.isArray(itemEnum) && itemEnum.length > 0) return itemEnum.map(String);
  if (schema?.type === 'array' || schema?.type === 'string') return parseOptionList(schema?.description);
  return [];
}

const TOKEN = /^[A-Za-z][A-Za-z0-9_\-]{0,39}$/;

/** Option names a field's own description lists, e.g.
 *  "Comma-separated list of resources to extract: employees, performance_cycles"
 *  or "Resources (customers, orders, products)". Empty when nothing reliable is found. */
export function parseOptionList(description: string | undefined): string[] {
  if (!description) return [];
  const candidates: string[] = [];
  const colon = description.match(/:\s*([^:.\n]+?)\s*(?:\.|$)/);
  if (colon) candidates.push(colon[1]);
  const paren = description.match(/\(([^()]+)\)/g);
  if (paren) for (const p of paren) candidates.push(p.slice(1, -1).replace(/^(e\.g\.|eg|such as|options?:)\s*/i, ''));
  for (const c of candidates) {
    const parts = c.split(/\s*,\s*/).map((p) => p.trim().replace(/^(and|or)\s+/, ''));
    if (parts.length >= 2 && parts.length <= 40 && parts.every((p) => TOKEN.test(p))) return parts;
  }
  return [];
}

/** Read a list-ish field value (array, or comma-separated string) as names. */
export function selectedOptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Toggle one option, keeping the field's own representation (array stays array, string stays comma-separated). */
export function toggleOption(current: unknown, option: string, fieldType: string | undefined): string[] | string {
  const sel = selectedOptions(current);
  const next = sel.includes(option) ? sel.filter((s) => s !== option) : [...sel, option];
  return fieldType === 'array' || Array.isArray(current) ? next : next.join(',');
}

/** `${SERVICE_FIELD}` style env-var reference for a secret field. */
export function envVarReference(componentType: string, fieldName: string): string {
  const base = ingestionComponentKey(componentType).replace(/_ingestion$/, '');
  return '${' + `${base}_${fieldName}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_') + '}';
}
