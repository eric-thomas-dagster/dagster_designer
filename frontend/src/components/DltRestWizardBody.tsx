import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { GENERIC_FIELD_GROUPS } from '@/lib/genericFields';
import { classifyIngestionFields } from '@/lib/ingestionWizard';
import {
  apiProblems, buildClient, buildResources, emptyResource, parseClient, parseResources, resourceProblems,
  type ApiModel, type AuthType, type PaginatorType, type ResourceModel, type WriteDisposition,
} from '@/lib/dltRestWizard';
import type { WizardGroup, WizardStepDef } from '@/lib/wizardTypes';
import { GuidedWizard, type GuidedWizardProps } from './GuidedWizard';

type Props = Omit<GuidedWizardProps, 'steps' | 'moreGroups' | 'stepErrors' | 'fieldNote'>;

const INPUT = 'w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500';
const LABEL = 'block text-sm font-medium text-gray-700 mb-1';
const HELP = 'text-xs text-gray-500 mt-1';

const AUTH_LABELS: Record<AuthType, string> = {
  none: 'No authentication',
  bearer: 'Bearer token',
  api_key: 'API key (header or query parameter)',
  http_basic: 'Username and password',
  oauth2_client_credentials: 'OAuth 2 client credentials',
};
const PAGINATOR_LABELS: Record<PaginatorType, string> = {
  auto: 'Detect automatically',
  cursor: 'Cursor (next-cursor value in the response)',
  json_link: 'Next-page link in the response body',
  header_link: 'Next-page link in the Link header',
  single_page: 'No pagination',
};

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={LABEL}>{label}</label>
      {children}
      {help && <p className={HELP}>{help}</p>}
    </div>
  );
}

function ApiForm({ api, onChange }: { api: ApiModel; onChange: (m: ApiModel) => void }) {
  const set = <K extends keyof ApiModel>(k: K, v: ApiModel[K]) => onChange({ ...api, [k]: v });
  const secretLabel =
    api.authType === 'bearer' ? 'Token' : api.authType === 'api_key' ? 'API key' : api.authType === 'http_basic' ? 'Password' : 'Client secret';
  return (
    <div className="space-y-4">
      <Field label="Base URL" help="Every endpoint path is added to this, e.g. https://api.example.com/v1">
        <input className={INPUT} value={api.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.example.com/v1" aria-label="Base URL" />
      </Field>
      <Field label="Authentication">
        <select className={INPUT} value={api.authType} onChange={(e) => set('authType', e.target.value as AuthType)} aria-label="Authentication">
          {(Object.keys(AUTH_LABELS) as AuthType[]).map((a) => <option key={a} value={a}>{AUTH_LABELS[a]}</option>)}
        </select>
      </Field>
      {api.authType === 'api_key' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Parameter name" help="The header or query parameter, e.g. X-Api-Key">
            <input className={INPUT} value={api.apiKeyName} onChange={(e) => set('apiKeyName', e.target.value)} aria-label="Parameter name" />
          </Field>
          <Field label="Sent in">
            <select className={INPUT} value={api.apiKeyLocation} onChange={(e) => set('apiKeyLocation', e.target.value as 'header' | 'query')} aria-label="Sent in">
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </select>
          </Field>
        </div>
      )}
      {api.authType === 'http_basic' && (
        <Field label="Username">
          <input className={INPUT} value={api.username} onChange={(e) => set('username', e.target.value)} aria-label="Username" />
        </Field>
      )}
      {api.authType === 'oauth2_client_credentials' && (
        <>
          <Field label="Token URL">
            <input className={INPUT} value={api.tokenUrl} onChange={(e) => set('tokenUrl', e.target.value)} placeholder="https://auth.example.com/oauth/token" aria-label="Token URL" />
          </Field>
          <Field label="Client id: environment variable name">
            <input className={`${INPUT} font-mono`} value={api.username} onChange={(e) => set('username', e.target.value)} placeholder="EXAMPLE_CLIENT_ID" aria-label="Client id variable" />
          </Field>
        </>
      )}
      {api.authType !== 'none' && (
        <Field
          label={`${secretLabel}: environment variable name`}
          help="Type the NAME of an environment variable (not the secret). It is written to the project as {{ env.NAME }}, so the secret itself never lands in your files."
        >
          <input className={`${INPUT} font-mono`} value={api.secretEnv} onChange={(e) => set('secretEnv', e.target.value)} placeholder="EXAMPLE_API_TOKEN" aria-label={`${secretLabel} variable`} />
        </Field>
      )}
      <Field label="Pagination" help="Most APIs are detected automatically; set this only if rows are missing.">
        <select className={INPUT} value={api.paginator} onChange={(e) => set('paginator', e.target.value as PaginatorType)} aria-label="Pagination">
          {(Object.keys(PAGINATOR_LABELS) as PaginatorType[]).map((p) => <option key={p} value={p}>{PAGINATOR_LABELS[p]}</option>)}
        </select>
      </Field>
      {api.paginator === 'cursor' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cursor parameter" help="Request parameter that takes the cursor, e.g. cursor">
            <input className={INPUT} value={api.cursorParam} onChange={(e) => set('cursorParam', e.target.value)} aria-label="Cursor parameter" />
          </Field>
          <Field label="Cursor path in response" help="e.g. next_cursor or meta.next">
            <input className={INPUT} value={api.cursorPath} onChange={(e) => set('cursorPath', e.target.value)} aria-label="Cursor path" />
          </Field>
        </div>
      )}
      {api.paginator === 'json_link' && (
        <Field label="Next-page URL path in response" help="e.g. links.next">
          <input className={INPUT} value={api.nextUrlPath} onChange={(e) => set('nextUrlPath', e.target.value)} aria-label="Next-page URL path" />
        </Field>
      )}
    </div>
  );
}

function ResourcesForm({ rows, onChange }: { rows: ResourceModel[]; onChange: (r: ResourceModel[]) => void }) {
  const update = (i: number, patch: Partial<ResourceModel>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-4">
      {rows.map((r, i) => (
        <div key={i} className="border border-gray-200 rounded-md p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-800">Endpoint {i + 1}</span>
            {rows.length > 1 && (
              <button type="button" onClick={() => onChange(rows.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600" aria-label={`Remove endpoint ${i + 1}`}>
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Table name" help="Becomes the table name, e.g. customers">
              <input className={INPUT} value={r.name} onChange={(e) => update(i, { name: e.target.value })} aria-label={`Table name ${i + 1}`} />
            </Field>
            <Field label="Path" help="Added to the base URL, e.g. customers or /v1/orders">
              <input className={INPUT} value={r.path} onChange={(e) => update(i, { path: e.target.value })} aria-label={`Path ${i + 1}`} />
            </Field>
          </div>
          <Field label="Where the rows are in the response" help='Leave empty if the response is the list itself. Examples: results, data.items, $'>
            <input className={INPUT} value={r.dataSelector} onChange={(e) => update(i, { dataSelector: e.target.value })} aria-label={`Data selector ${i + 1}`} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Primary key (optional)" help="Comma-separate for several columns">
              <input className={INPUT} value={r.primaryKey} onChange={(e) => update(i, { primaryKey: e.target.value })} aria-label={`Primary key ${i + 1}`} />
            </Field>
            <Field label="On each run">
              <select className={INPUT} value={r.writeDisposition} onChange={(e) => update(i, { writeDisposition: e.target.value as WriteDisposition })} aria-label={`Write mode ${i + 1}`}>
                <option value="append">Add new rows</option>
                <option value="replace">Replace the table</option>
                <option value="merge">Update matching rows (needs a primary key)</option>
              </select>
            </Field>
          </div>
          <Field label="Query parameters (optional)" help="One per line, key=value. e.g. limit=100">
            <textarea className={`${INPUT} font-mono`} rows={2} value={r.params} onChange={(e) => update(i, { params: e.target.value })} aria-label={`Query parameters ${i + 1}`} />
          </Field>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, emptyResource()])} className="inline-flex items-center gap-1 text-sm text-blue-700 hover:text-blue-900">
        <Plus className="w-4 h-4" /> Add another endpoint
      </button>
      <p className={HELP}>Endpoints that depend on each other (one request per row of a parent) need the advanced form.</p>
    </div>
  );
}

/** Guided flow for the dlt REST API source: API connection, Endpoints, Destination, Review. */
export function DltRestWizardBody(props: Props) {
  const { properties, required, formData, onFieldChange } = props;
  const [api, setApi] = useState<ApiModel>(() => parseClient(formData.client));
  const [rows, setRows] = useState<ResourceModel[]>(() => {
    const parsed = parseResources(formData.resources);
    return parsed.length > 0 ? parsed : [emptyResource()];
  });

  // Keep the real form values (what gets saved) in step with the friendly models.
  useEffect(() => { onFieldChange('client', buildClient(api)); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onFieldChange('resources', buildResources(rows)); }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const fields = useMemo(() => {
    const rest = Object.fromEntries(Object.entries(properties).filter(([k]) => k !== 'client' && k !== 'resources'));
    return classifyIngestionFields(rest, required);
  }, [properties, required]);

  const steps = useMemo<WizardStepDef[]>(
    () => [
      {
        key: 'api',
        title: 'API',
        blurb: 'Name this data and tell Dagster how to reach the API.',
        entries: fields.connect.filter((e) => e.name === 'asset_name'),
        custom: () => <ApiForm api={api} onChange={setApi} />,
        summary: () => [
          { label: 'Base URL', value: api.baseUrl },
          { label: 'Authentication', value: AUTH_LABELS[api.authType] + (api.authType !== 'none' && api.secretEnv ? ` (${'{{ env.' + api.secretEnv + ' }}'})` : '') },
          ...(api.paginator !== 'auto' ? [{ label: 'Pagination', value: PAGINATOR_LABELS[api.paginator] }] : []),
        ],
      },
      {
        key: 'endpoints',
        title: 'Endpoints',
        blurb: 'Each endpoint becomes a table. Give its path and where the rows sit in the response.',
        entries: [],
        custom: () => <ResourcesForm rows={rows} onChange={setRows} />,
        summary: () => rows.map((r, i) => ({ label: r.name.trim() || `Endpoint ${i + 1}`, value: r.path || '(no path yet)' })),
      },
      {
        key: 'destination',
        title: 'Where it goes',
        blurb: 'Pick a warehouse, or leave it empty to keep the data in memory as a DataFrame for transforms.',
        entries: fields.destination,
      },
    ],
    [fields, api, rows],
  );

  const moreGroups = useMemo<WizardGroup[]>(
    () => [
      { key: 'advanced', label: 'Other options', entries: [...fields.connect.filter((e) => e.name !== 'asset_name'), ...fields.load] },
      ...GENERIC_FIELD_GROUPS.map((g) => ({ key: g.key, label: g.label, entries: fields.more[g.key] })),
    ],
    [fields],
  );

  return (
    <GuidedWizard
      {...props}
      steps={steps}
      moreGroups={moreGroups}
      stepErrors={(stepKey, values) =>
        stepKey === 'api' ? apiProblems(parseClient(values.client)) : stepKey === 'endpoints' ? resourceProblems(parseResources(values.resources)) : []
      }
    />
  );
}
