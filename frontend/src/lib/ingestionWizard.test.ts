import { describe, expect, it } from 'vitest';
import {
  classifyIngestionFields, envVarReference, ingestionComponentKey, isSaasIngestionSchema, isSecretField,
  missingRequired, optionsFor, parseOptionList, selectedOptions, toggleOption,
} from './ingestionWizard';

const shopify = {
  asset_name: { type: 'string' }, shop_url: { type: 'string' }, private_app_password: { type: 'string' },
  resource_key: { type: 'string' }, resources: { type: 'array', description: 'Shopify resources to extract (customers, orders, products)' },
  start_date: { type: 'string' }, order_status: { type: 'string' },
  description: {}, group_name: {}, owners: {}, asset_tags: {}, kinds: {},
  freshness_max_lag_minutes: {}, freshness_cron: {}, include_preview_metadata: {}, preview_rows: {},
  deps: {}, partition_type: {}, partition_start: {}, retry_policy_max_retries: {}, column_lineage: {},
  destination: {}, dataset_name: {}, persist_only: {}, destination_credentials_url: { 'x-dagster-destination-fields': {} },
  destination_credentials_env_var: {}, bucket_url: {},
};

describe('ingestionComponentKey', () => {
  it('handles every component_type shape', () => {
    expect(ingestionComponentKey('ds_x.components.shopify_ingestion.component.ShopifyIngestionComponent')).toBe('shopify_ingestion');
    expect(ingestionComponentKey('dagster_community_components.ShopifyIngestionComponent')).toBe('shopify_ingestion');
    expect(ingestionComponentKey('shopify_ingestion')).toBe('shopify_ingestion');
  });
});

describe('isSaasIngestionSchema', () => {
  it('claims a SaaS ingestion', () => {
    expect(isSaasIngestionSchema('a.components.shopify_ingestion.component.ShopifyIngestionComponent', shopify)).toBe(true);
  });
  it('leaves replication/dlt components to their own wizards', () => {
    expect(isSaasIngestionSchema('a.components.dlt_rest_api_source.component.X', shopify)).toBe(false);
    expect(isSaasIngestionSchema('dagster_community_components.DatabaseReplicationComponent', shopify)).toBe(false);
  });
  it('also claims DataFrame-only *_ingestion templates that have no destination block', () => {
    expect(isSaasIngestionSchema('a.components.gong_calls_ingestion.component.X', { asset_name: {}, limit: {} })).toBe(true);
  });
  it('needs an asset name, and a destination block unless it is an *_ingestion template', () => {
    expect(isSaasIngestionSchema('a.components.x_reader.component.X', { asset_name: {} })).toBe(false);
    expect(isSaasIngestionSchema('a.components.x_ingestion.component.X', { limit: {} })).toBe(false);
    expect(isSaasIngestionSchema('a.components.x_ingestion.component.X', undefined)).toBe(false);
  });
});

describe('classifyIngestionFields', () => {
  const f = classifyIngestionFields(shopify, ['asset_name']);
  const names = (e: { name: string }[]) => e.map((x) => x.name);
  it('puts the asset name and credentials in connect', () => {
    expect(names(f.connect)).toEqual(['asset_name', 'shop_url', 'private_app_password']);
  });
  it('puts what-to-pull in load', () => {
    expect(names(f.load)).toEqual(['resource_key', 'resources', 'start_date', 'order_status']);
  });
  it('puts the destination block together', () => {
    expect(names(f.destination)).toEqual(['destination', 'dataset_name', 'persist_only', 'destination_credentials_url', 'destination_credentials_env_var', 'bucket_url']);
  });
  it('keeps catalog/scheduling boilerplate out of the main flow', () => {
    expect(names(f.more.freshness)).toEqual(['freshness_max_lag_minutes', 'freshness_cron']);
    expect(names(f.more.metadata)).toContain('owners');
    expect(names(f.more.metadata)).toContain('column_lineage');
    expect(names(f.more.retry)).toEqual(['retry_policy_max_retries']);
  });
  it('treats an unmatched required field as connection', () => {
    const g = classifyIngestionFields({ asset_name: {}, workspace_slug: {}, label_format: {} }, ['label_format']);
    expect(g.connect.map((x) => x.name)).toEqual(['asset_name', 'workspace_slug', 'label_format']);
  });
});

describe('missingRequired', () => {
  const entries = [{ name: 'a', schema: {} }, { name: 'b', schema: {} }, { name: 'c', schema: {} }];
  it('flags empty, blank and missing values but not zero/false', () => {
    expect(missingRequired(entries, ['a', 'b', 'c'], { a: '  ', b: 0, c: false })).toEqual(['a']);
    expect(missingRequired(entries, ['a', 'b'], { a: 'x' })).toEqual(['b']);
    expect(missingRequired(entries, ['a'], { a: [] })).toEqual(['a']);
  });
});

describe('parseOptionList', () => {
  it('reads colon lists and parenthesised lists', () => {
    expect(parseOptionList('Comma-separated list of resources to extract: employees, performance_cycles, manager_reviews')).toEqual(['employees', 'performance_cycles', 'manager_reviews']);
    expect(parseOptionList('Shopify resources to extract (customers, orders, products)')).toEqual(['customers', 'orders', 'products']);
    expect(parseOptionList('Filter orders by status (open, closed, cancelled, any)')).toEqual(['open', 'closed', 'cancelled', 'any']);
    expect(parseOptionList('Values (e.g. a, b, and c)')).toEqual(['a', 'b', 'c']);
  });
  it('ignores prose and single values', () => {
    expect(parseOptionList('Start date for incremental loading (YYYY-MM-DD)')).toEqual([]);
    expect(parseOptionList('Name of the asset that will hold the data')).toEqual([]);
    expect(parseOptionList('Base URL, e.g. https://api.example.com')).toEqual([]);
    expect(parseOptionList(undefined)).toEqual([]);
  });
});

describe('toggleOption', () => {
  it('keeps arrays as arrays and strings comma-separated', () => {
    expect(toggleOption(['a'], 'b', 'array')).toEqual(['a', 'b']);
    expect(toggleOption(['a', 'b'], 'a', 'array')).toEqual(['b']);
    expect(toggleOption('a,b', 'c', 'string')).toBe('a,b,c');
    expect(toggleOption('a,b', 'a', 'string')).toBe('b');
    expect(toggleOption(undefined, 'x', 'array')).toEqual(['x']);
    expect(selectedOptions('a, b ,')).toEqual(['a', 'b']);
  });
});

describe('isSecretField', () => {
  it('flags secrets but not env-var names or resource keys', () => {
    for (const n of ['api_key', 'client_secret', 'private_app_password', 'access_token', 'refresh_token']) expect(isSecretField(n)).toBe(true);
    for (const n of ['api_key_env_var', 'user_token_env', 'oauth_token_resource_key', 'shop_url', 'resource_key']) expect(isSecretField(n)).toBe(false);
  });
});

describe('envVarReference', () => {
  it('builds ${SERVICE_FIELD}', () => {
    expect(envVarReference('ds.components.shopify_ingestion.component.C', 'private_app_password')).toBe('${SHOPIFY_PRIVATE_APP_PASSWORD}');
  });
});

describe('explicit schema hints beat the heuristics', () => {
  it('x-dagster-step places a field', () => {
    const f = classifyIngestionFields({
      asset_name: {}, order_status: { 'x-dagster-step': 'connect' }, shop_url: { 'x-dagster-step': 'load' },
      timeout: { 'x-dagster-step': 'advanced' }, region: { 'x-dagster-step': 'destination' },
    });
    expect(f.connect.map((e) => e.name)).toEqual(['asset_name', 'order_status']);
    expect(f.load.map((e) => e.name)).toEqual(['shop_url']);
    expect(f.destination.map((e) => e.name)).toEqual(['region']);
    expect(f.more.metadata.map((e) => e.name)).toEqual(['timeout']);
  });
  it('x-dagster-secret overrides the name guess in both directions', () => {
    expect(isSecretField('client_code', { 'x-dagster-secret': true })).toBe(true);
    expect(isSecretField('api_key', { 'x-dagster-secret': false })).toBe(false);
    expect(isSecretField('api_key', {})).toBe(true);
  });
  it('optionsFor prefers x-dagster-options, then items.enum, then prose', () => {
    expect(optionsFor({ 'x-dagster-options': ['a', 'b'], description: 'x (c, d)' })).toEqual(['a', 'b']);
    expect(optionsFor({ type: 'array', items: { enum: ['orders', 'customers'] } })).toEqual(['orders', 'customers']);
    expect(optionsFor({ type: 'array', description: 'pull (orders, customers)' })).toEqual(['orders', 'customers']);
    expect(optionsFor({ type: 'object', description: 'pull (orders, customers)' })).toEqual([]);
  });
});
