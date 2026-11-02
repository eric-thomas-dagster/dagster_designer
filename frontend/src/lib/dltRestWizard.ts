import { ingestionComponentKey } from './ingestionWizard';

/**
 * Form model <-> the raw `client` / `resources` objects of the dlt REST API source component
 * (dlt's `rest_api_source` config). The wizard edits the friendly model; these functions
 * build the exact structure the component expects -- and read an existing one back.
 * Secrets are never written literally: the user gives an environment variable NAME and the
 * YAML gets `{{ env.NAME }}`, which dg resolves before the component sees it.
 */

export function isDltRestSchema(componentType: string, properties: Record<string, any> | undefined): boolean {
  return !!properties && ingestionComponentKey(componentType) === 'dlt_rest_api_source' && 'client' in properties && 'resources' in properties;
}

export type AuthType = 'none' | 'bearer' | 'api_key' | 'http_basic' | 'oauth2_client_credentials';
export type PaginatorType = 'auto' | 'cursor' | 'json_link' | 'header_link' | 'single_page';
export type WriteDisposition = 'append' | 'replace' | 'merge';

export interface ApiModel {
  baseUrl: string;
  authType: AuthType;
  /** bearer token / api key / basic password / oauth client secret -- an env var NAME. */
  secretEnv: string;
  /** api_key: header or query-param name. */
  apiKeyName: string;
  apiKeyLocation: 'header' | 'query';
  /** http_basic username (plain text or a pasted `{{ env.X }}`) / oauth client id (env var NAME). */
  username: string;
  tokenUrl: string;
  paginator: PaginatorType;
  cursorParam: string;
  cursorPath: string;
  nextUrlPath: string;
}

export interface ResourceModel {
  name: string;
  path: string;
  dataSelector: string;
  /** One `key=value` per line. */
  params: string;
  primaryKey: string;
  writeDisposition: WriteDisposition;
}

export const emptyApi = (): ApiModel => ({
  baseUrl: '', authType: 'none', secretEnv: '', apiKeyName: '', apiKeyLocation: 'header', username: '', tokenUrl: '',
  paginator: 'auto', cursorParam: '', cursorPath: '', nextUrlPath: '',
});

export const emptyResource = (): ResourceModel => ({ name: '', path: '', dataSelector: '', params: '', primaryKey: '', writeDisposition: 'append' });

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESOURCE_NAME = /^[a-z_][a-z0-9_]*$/;
const envRef = (name: string) => `{{ env.${name.trim()} }}`;
const ENV_REF = /^\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const readEnv = (v: unknown): string => {
  const m = typeof v === 'string' ? v.match(ENV_REF) : null;
  return m ? m[1] : '';
};

export function buildClient(m: ApiModel): Record<string, any> {
  const client: Record<string, any> = { base_url: m.baseUrl.trim() };
  switch (m.authType) {
    case 'bearer':
      client.auth = { type: 'bearer', token: envRef(m.secretEnv) };
      break;
    case 'api_key':
      client.auth = { type: 'api_key', name: m.apiKeyName.trim(), api_key: envRef(m.secretEnv), location: m.apiKeyLocation };
      break;
    case 'http_basic':
      client.auth = { type: 'http_basic', username: m.username.trim(), password: envRef(m.secretEnv) };
      break;
    case 'oauth2_client_credentials':
      client.auth = {
        type: 'oauth2_client_credentials',
        access_token_url: m.tokenUrl.trim(),
        client_id: envRef(m.username),
        client_secret: envRef(m.secretEnv),
      };
      break;
    default:
      break;
  }
  if (m.paginator === 'cursor') client.paginator = { type: 'cursor', cursor_param: m.cursorParam.trim(), cursor_path: m.cursorPath.trim() };
  else if (m.paginator === 'json_link') client.paginator = { type: 'json_link', next_url_path: m.nextUrlPath.trim() };
  else if (m.paginator === 'header_link') client.paginator = { type: 'header_link' };
  else if (m.paginator === 'single_page') client.paginator = { type: 'single_page' };
  return client;
}

export function parseClient(client: unknown): ApiModel {
  const m = emptyApi();
  if (!client || typeof client !== 'object') return m;
  const c = client as Record<string, any>;
  m.baseUrl = typeof c.base_url === 'string' ? c.base_url : '';
  const a = c.auth;
  if (a && typeof a === 'object') {
    if (a.type === 'bearer') { m.authType = 'bearer'; m.secretEnv = readEnv(a.token); }
    else if (a.type === 'api_key') { m.authType = 'api_key'; m.secretEnv = readEnv(a.api_key); m.apiKeyName = a.name ?? ''; m.apiKeyLocation = a.location === 'query' ? 'query' : 'header'; }
    else if (a.type === 'http_basic') { m.authType = 'http_basic'; m.username = a.username ?? ''; m.secretEnv = readEnv(a.password); }
    else if (a.type === 'oauth2_client_credentials') { m.authType = 'oauth2_client_credentials'; m.tokenUrl = a.access_token_url ?? ''; m.username = readEnv(a.client_id); m.secretEnv = readEnv(a.client_secret); }
  }
  const p = c.paginator;
  if (p && typeof p === 'object') {
    if (p.type === 'cursor') { m.paginator = 'cursor'; m.cursorParam = p.cursor_param ?? ''; m.cursorPath = p.cursor_path ?? ''; }
    else if (p.type === 'json_link') { m.paginator = 'json_link'; m.nextUrlPath = p.next_url_path ?? ''; }
    else if (p.type === 'header_link') m.paginator = 'header_link';
    else if (p.type === 'single_page') m.paginator = 'single_page';
  }
  return m;
}

const coerce = (v: string): string | number | boolean => {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  return t;
};

export function parseParams(text: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = coerce(line.slice(i + 1));
  }
  return out;
}

export function buildResources(rows: ResourceModel[]): Record<string, any>[] {
  return rows.map((r) => {
    const endpoint: Record<string, any> = { path: r.path.trim() };
    if (r.dataSelector.trim()) endpoint.data_selector = r.dataSelector.trim();
    const params = parseParams(r.params);
    if (Object.keys(params).length > 0) endpoint.params = params;
    const res: Record<string, any> = { name: r.name.trim(), endpoint };
    const pk = r.primaryKey.split(',').map((s) => s.trim()).filter(Boolean);
    if (pk.length === 1) res.primary_key = pk[0];
    else if (pk.length > 1) res.primary_key = pk;
    if (r.writeDisposition !== 'append') res.write_disposition = r.writeDisposition;
    return res;
  });
}

/** Resources a form can show faithfully. A dependent (`resolve`) resource isn't one: the wizard
 *  can't edit it without flattening it, so the caller should offer the advanced form instead. */
export function resourcesAreWizardEditable(resources: unknown): boolean {
  if (!Array.isArray(resources)) return resources === undefined || resources === null;
  return resources.every((r) => {
    if (!r || typeof r !== 'object') return false;
    const params = r.endpoint?.params;
    const hasResolve = params && typeof params === 'object' && Object.values(params).some((v) => v && typeof v === 'object');
    return !hasResolve && !r.endpoint?.paginator && !r.include_from_parent && !r.processing_steps;
  });
}

export function parseResources(resources: unknown): ResourceModel[] {
  if (!Array.isArray(resources)) return [];
  return resources.map((r: any) => {
    const m = emptyResource();
    m.name = r?.name ?? '';
    m.path = r?.endpoint?.path ?? '';
    m.dataSelector = r?.endpoint?.data_selector ?? '';
    const p = r?.endpoint?.params;
    m.params = p && typeof p === 'object' ? Object.entries(p).map(([k, v]) => `${k}=${v}`).join('\n') : '';
    m.primaryKey = Array.isArray(r?.primary_key) ? r.primary_key.join(', ') : r?.primary_key ?? '';
    m.writeDisposition = r?.write_disposition === 'replace' || r?.write_disposition === 'merge' ? r.write_disposition : 'append';
    return m;
  });
}

export function apiProblems(m: ApiModel): string[] {
  const errs: string[] = [];
  if (!/^https?:\/\/[^\s/]+/i.test(m.baseUrl.trim())) errs.push('The base URL must start with http:// or https://.');
  const needsEnv = m.authType !== 'none';
  if (needsEnv && !ENV_NAME.test(m.secretEnv.trim())) {
    errs.push('Enter the NAME of the environment variable that holds the secret (letters, digits and underscores) -- not the secret itself.');
  }
  if (m.authType === 'api_key' && !m.apiKeyName.trim()) errs.push('Say which header or query parameter carries the API key.');
  if (m.authType === 'http_basic' && !m.username.trim()) errs.push('Enter the username.');
  if (m.authType === 'oauth2_client_credentials') {
    if (!/^https?:\/\//i.test(m.tokenUrl.trim())) errs.push('Enter the token URL (https://...).');
    if (!ENV_NAME.test(m.username.trim())) errs.push('Enter the NAME of the environment variable that holds the client id.');
  }
  if (m.paginator === 'cursor' && (!m.cursorParam.trim() || !m.cursorPath.trim())) errs.push('Cursor pagination needs the request parameter and the response path of the next cursor.');
  if (m.paginator === 'json_link' && !m.nextUrlPath.trim()) errs.push('Link pagination needs the response path of the next-page URL.');
  return errs;
}

export function resourceProblems(rows: ResourceModel[]): string[] {
  const errs: string[] = [];
  if (rows.length === 0) return ['Add at least one endpoint.'];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const label = r.name.trim() || `Endpoint ${i + 1}`;
    if (!RESOURCE_NAME.test(r.name.trim())) errs.push(`${label}: the name must be lowercase letters, digits and underscores, starting with a letter.`);
    else if (seen.has(r.name.trim())) errs.push(`${label}: another endpoint already uses this name.`);
    seen.add(r.name.trim());
    if (!r.path.trim()) errs.push(`${label}: enter the path, e.g. customers or /v1/orders.`);
    if (r.writeDisposition === 'merge' && !r.primaryKey.trim()) errs.push(`${label}: "merge" needs a primary key to match rows on.`);
  });
  return errs;
}
