import { describe, expect, it } from 'vitest';
import {
  apiProblems, buildClient, buildResources, emptyApi, emptyResource, isDltRestSchema, parseClient, parseParams,
  parseResources, resourceProblems, resourcesAreWizardEditable, type ApiModel,
} from './dltRestWizard';

const api = (o: Partial<ApiModel>): ApiModel => ({ ...emptyApi(), baseUrl: 'https://api.example.com/v1', ...o });

describe('isDltRestSchema', () => {
  it('matches the REST source only', () => {
    const props = { client: {}, resources: {}, asset_name: {} };
    expect(isDltRestSchema('dagster_community_components.DltRestApiSourceComponent', props)).toBe(true);
    expect(isDltRestSchema('x.components.dlt_rest_api_source.component.C', props)).toBe(true);
    expect(isDltRestSchema('dagster_community_components.DltPipelineAssetsComponent', props)).toBe(false);
    expect(isDltRestSchema('dagster_community_components.DltRestApiSourceComponent', { asset_name: {} })).toBe(false);
  });
});

describe('buildClient', () => {
  it('no auth, auto pagination is just the base url', () => {
    expect(buildClient(api({}))).toEqual({ base_url: 'https://api.example.com/v1' });
  });
  it('bearer', () => {
    expect(buildClient(api({ authType: 'bearer', secretEnv: 'MY_TOKEN' }))).toEqual({
      base_url: 'https://api.example.com/v1', auth: { type: 'bearer', token: '{{ env.MY_TOKEN }}' },
    });
  });
  it('api key in a query param', () => {
    expect(buildClient(api({ authType: 'api_key', secretEnv: 'K', apiKeyName: 'key', apiKeyLocation: 'query' })).auth)
      .toEqual({ type: 'api_key', name: 'key', api_key: '{{ env.K }}', location: 'query' });
  });
  it('basic keeps a plain username and an env password', () => {
    expect(buildClient(api({ authType: 'http_basic', username: 'me', secretEnv: 'PW' })).auth)
      .toEqual({ type: 'http_basic', username: 'me', password: '{{ env.PW }}' });
  });
  it('oauth2 client credentials', () => {
    expect(buildClient(api({ authType: 'oauth2_client_credentials', tokenUrl: 'https://a/token', username: 'CID', secretEnv: 'CSEC' })).auth)
      .toEqual({ type: 'oauth2_client_credentials', access_token_url: 'https://a/token', client_id: '{{ env.CID }}', client_secret: '{{ env.CSEC }}' });
  });
  it('paginators', () => {
    expect(buildClient(api({ paginator: 'cursor', cursorParam: 'cursor', cursorPath: 'next_cursor' })).paginator)
      .toEqual({ type: 'cursor', cursor_param: 'cursor', cursor_path: 'next_cursor' });
    expect(buildClient(api({ paginator: 'json_link', nextUrlPath: 'links.next' })).paginator).toEqual({ type: 'json_link', next_url_path: 'links.next' });
    expect(buildClient(api({ paginator: 'header_link' })).paginator).toEqual({ type: 'header_link' });
    expect(buildClient(api({ paginator: 'single_page' })).paginator).toEqual({ type: 'single_page' });
  });
});

describe('client round trip', () => {
  it('reads back what it builds', () => {
    for (const m of [
      api({}),
      api({ authType: 'bearer', secretEnv: 'T' }),
      api({ authType: 'api_key', secretEnv: 'K', apiKeyName: 'X-Key', apiKeyLocation: 'header', paginator: 'cursor', cursorParam: 'c', cursorPath: 'n' }),
      api({ authType: 'http_basic', username: 'u', secretEnv: 'P', paginator: 'json_link', nextUrlPath: 'next' }),
      api({ authType: 'oauth2_client_credentials', tokenUrl: 'https://t', username: 'ID', secretEnv: 'S' }),
    ]) expect(parseClient(buildClient(m))).toEqual(m);
  });
  it('tolerates junk', () => {
    expect(parseClient(null)).toEqual(emptyApi());
    expect(parseClient('x')).toEqual(emptyApi());
  });
});

describe('resources', () => {
  const row = { ...emptyResource(), name: 'customers', path: 'customers.json' };
  it('builds the minimal resource', () => {
    expect(buildResources([row])).toEqual([{ name: 'customers', endpoint: { path: 'customers.json' } }]);
  });
  it('builds selector, params, key and disposition', () => {
    expect(buildResources([{ ...row, dataSelector: 'results', params: 'limit=100\nactive=true\nq=a=b\n=bad\nnoequals', primaryKey: 'id', writeDisposition: 'merge' }]))
      .toEqual([{ name: 'customers', endpoint: { path: 'customers.json', data_selector: 'results', params: { limit: 100, active: true, q: 'a=b' } }, primary_key: 'id', write_disposition: 'merge' }]);
    expect(buildResources([{ ...row, primaryKey: 'a, b' }])[0].primary_key).toEqual(['a', 'b']);
  });
  it('round trips', () => {
    const rows = [{ ...row, dataSelector: '$', params: 'limit=100', primaryKey: 'id', writeDisposition: 'replace' as const }];
    expect(parseResources(buildResources(rows))).toEqual(rows);
  });
  it('knows which resources a form cannot represent', () => {
    expect(resourcesAreWizardEditable([{ name: 'a', endpoint: { path: 'a' } }])).toBe(true);
    expect(resourcesAreWizardEditable(undefined)).toBe(true);
    expect(resourcesAreWizardEditable([{ name: 'b', endpoint: { path: 'b/{id}', params: { id: { type: 'resolve', resource: 'a', field: 'id' } } } }])).toBe(false);
    expect(resourcesAreWizardEditable([{ name: 'c', endpoint: { path: 'c', paginator: { type: 'cursor' } } }])).toBe(false);
    expect(resourcesAreWizardEditable('nope')).toBe(false);
  });
  it('parseParams ignores malformed lines', () => {
    expect(parseParams('a=1\n\nb\n=c\n d = x ')).toEqual({ a: 1, d: 'x' });
  });
});

describe('validation', () => {
  it('apiProblems', () => {
    expect(apiProblems(api({}))).toEqual([]);
    expect(apiProblems(api({ baseUrl: 'example.com' }))).toHaveLength(1);
    expect(apiProblems(api({ authType: 'bearer', secretEnv: '' }))).toHaveLength(1);
    expect(apiProblems(api({ authType: 'bearer', secretEnv: 'sk_live_abc 123!' }))).toHaveLength(1); // a pasted secret, not a name
    expect(apiProblems(api({ authType: 'bearer', secretEnv: 'MY_TOKEN' }))).toEqual([]);
    expect(apiProblems(api({ authType: 'api_key', secretEnv: 'K' }))).toHaveLength(1);
    expect(apiProblems(api({ authType: 'oauth2_client_credentials', secretEnv: 'S', username: 'ID', tokenUrl: 'x' }))).toHaveLength(1);
    expect(apiProblems(api({ paginator: 'cursor' }))).toHaveLength(1);
    expect(apiProblems(api({ paginator: 'json_link' }))).toHaveLength(1);
  });
  it('resourceProblems', () => {
    expect(resourceProblems([])).toEqual(['Add at least one endpoint.']);
    expect(resourceProblems([{ ...emptyResource(), name: 'a', path: 'a' }])).toEqual([]);
    expect(resourceProblems([{ ...emptyResource(), name: 'Bad Name', path: 'a' }])).toHaveLength(1);
    expect(resourceProblems([{ ...emptyResource(), name: 'a', path: '' }])).toHaveLength(1);
    expect(resourceProblems([{ ...emptyResource(), name: 'a', path: 'a' }, { ...emptyResource(), name: 'a', path: 'b' }])).toHaveLength(1);
    expect(resourceProblems([{ ...emptyResource(), name: 'a', path: 'a', writeDisposition: 'merge' }])).toHaveLength(1);
  });
});
