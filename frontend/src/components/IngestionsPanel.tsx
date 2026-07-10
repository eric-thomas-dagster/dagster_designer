import { useEffect, useMemo, useState } from 'react';
import { Download, Cloud, Database, FileText, Globe, Sparkles, Boxes, CheckCircle2, AlertTriangle, Clock, Play, Settings } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, projectsApi } from '@/services/api';
import { notify } from './Notifications';
import { AddDataDialog } from './AddDataDialog';
import type { ComponentInstance } from '@/types';

interface IngestionsPanelProps {
  onAddDataSource: (componentType: string) => void;
  onEditComponent: (component: ComponentInstance) => void;
}

// Same bin heuristics as AddDataDialog — keeping them local avoids a
// cyclic dep and lets the two views drift independently if we ever want
// different labels here.
type SourceKind = 'files' | 'databases' | 'saas' | 'apis' | 'synthetic' | 'other';
const KIND_META: Record<SourceKind, { label: string; icon: any; color: string }> = {
  files:      { label: 'Files & object storage', icon: FileText, color: 'bg-blue-500' },
  databases:  { label: 'Databases & warehouses', icon: Database, color: 'bg-emerald-500' },
  saas:       { label: 'SaaS connectors',        icon: Cloud,    color: 'bg-purple-500' },
  apis:       { label: 'APIs & webhooks',        icon: Globe,    color: 'bg-orange-500' },
  synthetic:  { label: 'Synthetic & demo data',  icon: Sparkles, color: 'bg-pink-500' },
  other:      { label: 'Other sources',          icon: Boxes,    color: 'bg-gray-400' },
};

function classifyType(componentType: string, label: string): SourceKind {
  const blob = (componentType + ' ' + label).toLowerCase();
  if (/csv|excel|xlsx|json|parquet|xml|tsv|feather|orc|avro|txt|file|upload|\bs3\b|gcs|azure_blob|adls|minio|ftp|sftp/.test(blob)) return 'files';
  if (/postgres|mysql|mariadb|sqlserver|mssql|oracle|snowflake|bigquery|redshift|clickhouse|duckdb|databricks|athena|presto|trino|singlestore|db2|firebolt|sqlite/.test(blob)) return 'databases';
  if (/salesforce|hubspot|servicenow|workday|adobe|google_analytics|google_ads|facebook|linkedin|twitter|shopify|stripe|zendesk|jira|asana|notion|airtable|slack|intercom|marketo|mailchimp|pipedrive|zoho|freshdesk|greenhouse|okta|auth0|braze|iterable|amplitude|segment|mixpanel|heap|posthog|klaviyo|onelogin/.test(blob)) return 'saas';
  if (/rest_api|api_|_api|webhook|graphql|soap|json_api/.test(blob)) return 'apis';
  if (/synthetic|mock|sample|demo|faker|generate/.test(blob)) return 'synthetic';
  return 'other';
}

// Heuristic: an ingestion is "configured" when its required-looking fields
// aren't blank or TODO placeholders. We can't inspect the schema here so we
// look at the raw attributes bag for anything obviously unset.
function isConfigured(attrs: Record<string, any>): boolean {
  if (!attrs) return false;
  for (const v of Object.values(attrs)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      if (v.trim() === '') continue;
      if (v.startsWith('TODO_') || v.startsWith('TODO ')) return false;
    }
  }
  // Must at least have SOME non-empty non-TODO value.
  const anyReal = Object.values(attrs).some((v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '' && !v.startsWith('TODO_') && !v.startsWith('TODO ');
    return true;
  });
  return anyReal;
}

// Rough heuristic to detect ingestion components in a project. We match on
// component_type substrings that the manifest categorizes as ingestion|source
// PLUS common built-in ingestion shapes (synthetic_data_generator, dbt seeds,
// csv_file, etc.). Anything downstream of a transformation is skipped.
const INGESTION_TYPE_PATTERNS = [
  /synthetic_data_generator/i,
  /ingest/i,
  /_reader\b/i,
  /file_reader/i,
  /csv_file/i,
  /parquet_file/i,
  /json_file/i,
  /_from_sql/i,
  /database_query/i,
  /_query_reader/i,
  /rest_api/i,
  /webhook_/i,
  /salesforce|hubspot|servicenow|workday|adobe|google_analytics|shopify|stripe|zendesk|jira|slack|marketo|mailchimp/i,
  /\bs3_?(reader|source|table|extract)/i,
];

function isIngestionType(componentType: string): boolean {
  return INGESTION_TYPE_PATTERNS.some((rx) => rx.test(componentType));
}

export function IngestionsPanel({ onAddDataSource, onEditComponent }: IngestionsPanelProps) {
  const { currentProject } = useProjectStore();
  const [addDataOpen, setAddDataOpen] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  // {asset_key: {columns, dtypes}} — powers the "rows ingested" hint.
  // Populated on any successful preview elsewhere in the app.
  const [schemas, setSchemas] = useState<Record<string, { columns: string[]; dtypes: Record<string, string> }>>({});

  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    assetsApi.knownSchemas(currentProject.id).then((s) => {
      if (!cancelled) setSchemas(s || {});
    }).catch(() => { /* empty is fine */ });
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  const ingestions = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.components
      .filter((c) => isIngestionType(c.component_type))
      .map((c) => {
        const kind = classifyType(c.component_type, c.label || c.id);
        const assetKey = (c.attributes?.asset_name as string) || c.id;
        const configured = isConfigured(c.attributes || {});
        const schema = schemas[assetKey];
        return {
          component: c,
          assetKey,
          kind,
          configured,
          columnCount: schema?.columns?.length ?? null,
          previewed: !!schema,
        };
      });
  }, [currentProject, schemas]);

  const kpis = useMemo(() => {
    const total = ingestions.length;
    const configured = ingestions.filter((i) => i.configured).length;
    const unconfigured = total - configured;
    const previewed = ingestions.filter((i) => i.previewed).length;
    const byKind: Record<SourceKind, number> = {
      files: 0, databases: 0, saas: 0, apis: 0, synthetic: 0, other: 0,
    };
    for (const i of ingestions) byKind[i.kind]++;
    return { total, configured, unconfigured, previewed, byKind };
  }, [ingestions]);

  const handleRun = async (assetKey: string, componentId: string) => {
    if (!currentProject) return;
    setRunningId(componentId);
    try {
      const r = await projectsApi.materialize(currentProject.id, [assetKey]);
      if (!r.success) {
        const tail = ((r.stderr || r.stdout || '') as string)
          .split('\n')
          .filter((l) => /error|failed/i.test(l))
          .slice(-3)
          .join(' | ') || 'unknown error';
        notify.error(`Run failed: ${tail}`);
      } else {
        notify.success(`Materialized ${assetKey}. Refresh schemas via preview.`);
      }
    } catch (e: any) {
      notify.error(`Run failed: ${e?.message ?? e}`);
    } finally {
      setRunningId(null);
    }
  };

  if (!currentProject) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        Open a project to see its ingestions.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Download className="w-6 h-6 text-primary" />
            Ingestions
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Every data source flowing into the project — Fivetran / Airbyte / dlt style.
          </p>
        </div>
        <button
          onClick={() => setAddDataOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent"
        >
          <Download className="w-4 h-4" /> Add data
        </button>
      </div>

      {/* KPI cards — the top-of-page vitals */}
      <div className="px-8 py-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="Total ingestions"
          value={kpis.total}
          icon={Download}
          tone="neutral"
        />
        <KpiCard
          label="Configured"
          value={kpis.configured}
          hint={kpis.total > 0 ? `${Math.round((kpis.configured / kpis.total) * 100)}%` : undefined}
          icon={CheckCircle2}
          tone="success"
        />
        <KpiCard
          label="Needs config"
          value={kpis.unconfigured}
          icon={AlertTriangle}
          tone={kpis.unconfigured > 0 ? 'warning' : 'neutral'}
        />
        <KpiCard
          label="Previewed at least once"
          value={kpis.previewed}
          hint={kpis.total > 0 ? `of ${kpis.total}` : undefined}
          icon={Clock}
          tone="neutral"
        />
      </div>

      {/* Source-mix visual — horizontal stacked bar segmented by kind */}
      <div className="px-8 pb-6">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Source mix</h2>
            <span className="text-xs text-gray-500">{kpis.total} sources</span>
          </div>
          {kpis.total === 0 ? (
            <div className="text-xs text-gray-400 py-4 text-center">No ingestion sources yet — click <strong>Add data</strong> to connect one.</div>
          ) : (
            <>
              <div className="h-6 rounded overflow-hidden flex bg-gray-100">
                {(Object.entries(kpis.byKind) as [SourceKind, number][]).map(([kind, n]) => {
                  if (n === 0) return null;
                  const pct = (n / kpis.total) * 100;
                  return (
                    <div
                      key={kind}
                      className={`${KIND_META[kind].color}`}
                      style={{ width: `${pct}%` }}
                      title={`${KIND_META[kind].label}: ${n}`}
                    />
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-3">
                {(Object.entries(kpis.byKind) as [SourceKind, number][]).map(([kind, n]) => {
                  if (n === 0) return null;
                  const Icon = KIND_META[kind].icon;
                  return (
                    <div key={kind} className="flex items-center gap-1.5 text-xs">
                      <span className={`inline-block w-2.5 h-2.5 rounded-sm ${KIND_META[kind].color}`} />
                      <Icon className="w-3.5 h-3.5 text-gray-500" />
                      <span className="text-gray-700">{KIND_META[kind].label}</span>
                      <span className="text-gray-500">({n})</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Ingestions table */}
      <div className="px-8 pb-8">
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">Ingestion sources</h2>
            <span className="text-xs text-gray-500">{ingestions.length} total</span>
          </div>
          {ingestions.length === 0 ? (
            <div className="p-8 text-center">
              <Download className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-600 mb-3">
                You don't have any ingestion sources in this project yet.
              </p>
              <button
                onClick={() => setAddDataOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded"
              >
                <Download className="w-4 h-4" /> Add your first source
              </button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Source type</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Destination asset</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Schema</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ingestions.map(({ component, assetKey, kind, configured, columnCount, previewed }) => {
                  const KindIcon = KIND_META[kind].icon;
                  return (
                    <tr key={component.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-900">{component.label || component.id}</div>
                        <div className="text-[11px] text-gray-500 font-mono truncate max-w-[240px]" title={component.component_type}>
                          {component.component_type.split('.').pop()}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-block w-2 h-2 rounded-sm ${KIND_META[kind].color}`} />
                          <KindIcon className="w-3.5 h-3.5 text-gray-500" />
                          <span className="text-xs text-gray-700">{KIND_META[kind].label}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-700">{assetKey}</td>
                      <td className="px-4 py-2.5">
                        {configured ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3" /> Configured
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                            <AlertTriangle className="w-3 h-3" /> Needs config
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {previewed ? (
                          <span className="text-gray-700">{columnCount} columns</span>
                        ) : (
                          <span className="text-gray-400 italic">not previewed</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => handleRun(assetKey, component.id)}
                            disabled={!configured || runningId === component.id}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
                            title={configured ? 'Materialize this ingestion now' : 'Configure required fields first'}
                          >
                            <Play className="w-3 h-3" />
                            {runningId === component.id ? 'Running…' : 'Run'}
                          </button>
                          <button
                            onClick={() => onEditComponent(component)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded"
                            title="Configure this ingestion"
                          >
                            <Settings className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <AddDataDialog
        open={addDataOpen}
        onOpenChange={setAddDataOpen}
        onSourcePicked={onAddDataSource}
      />
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  icon: any;
  tone: 'neutral' | 'success' | 'warning';
}) {
  const toneClasses = {
    neutral: 'text-gray-500 bg-gray-100',
    success: 'text-emerald-600 bg-emerald-50',
    warning: 'text-amber-600 bg-amber-50',
  }[tone];
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${toneClasses}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</div>
        <div className="flex items-baseline gap-1.5 mt-0.5">
          <div className="text-2xl font-semibold text-gray-900 tabular-nums">{value.toLocaleString()}</div>
          {hint && <div className="text-xs text-gray-500">{hint}</div>}
        </div>
      </div>
    </div>
  );
}
