import { useEffect, useMemo, useState } from 'react';
import { Download, Cloud, Database, FileText, Globe, Sparkles, Boxes, CheckCircle2, AlertTriangle, Play, Settings, Activity, TrendingUp, Loader2, XCircle, Layers, CalendarClock, Clock, X } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, projectsApi, type IngestionEvent } from '@/services/api';
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
  const [events, setEvents] = useState<IngestionEvent[]>([]);
  const [window, setWindow] = useState<'24h' | '7d' | '30d'>('7d');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<SourceKind | 'all'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drawerFor, setDrawerFor] = useState<string | null>(null);
  const [runningBulk, setRunningBulk] = useState(false);

  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    assetsApi.knownSchemas(currentProject.id).then((s) => {
      if (!cancelled) setSchemas(s || {});
    }).catch(() => { /* empty is fine */ });
    assetsApi.ingestionHistory(currentProject.id, 5000).then((r) => {
      if (!cancelled) setEvents(r.events || []);
    }).catch(() => { /* empty is fine */ });
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  // Cross-reference schedule components in the project so each ingestion
  // row can show its cadence. A schedule "targets" an ingestion if the
  // schedule's target_asset_keys / asset_keys / selection includes the
  // ingestion's asset_name.
  const scheduleByAssetKey = useMemo(() => {
    const map = new Map<string, { label: string; cron?: string }[]>();
    if (!currentProject) return map;
    for (const c of currentProject.components) {
      if (!/Schedule(Component)?$|\bschedule\b/i.test(c.component_type)) continue;
      const targets: string[] = [];
      const attrs = (c.attributes || {}) as Record<string, any>;
      for (const key of ['target_asset_keys', 'asset_keys', 'asset_selection', 'assets']) {
        const v = attrs[key];
        if (typeof v === 'string' && v) targets.push(...v.split(',').map((s) => s.trim()));
        else if (Array.isArray(v)) targets.push(...v.map(String));
      }
      const cron = attrs.cron || attrs.cron_schedule || attrs.schedule;
      for (const t of targets) {
        if (!map.has(t)) map.set(t, []);
        map.get(t)!.push({ label: c.label || c.id, cron });
      }
    }
    return map;
  }, [currentProject]);

  // Partition config lives on the graph node (Dagster's partitioning is
  // separate from the component's own attribute bag). A node with a
  // partition_config is Dagster's incremental / delta ingestion.
  const partitionByAssetKey = useMemo(() => {
    const map = new Map<string, { kind: string; description: string }>();
    if (!currentProject) return map;
    for (const n of currentProject.graph.nodes) {
      const cfg = (n.data as any)?.partition_config;
      if (!cfg) continue;
      const key = (n.data as any)?.asset_key || n.id;
      const kind = cfg.type || cfg.kind || 'partitioned';
      const bits: string[] = [];
      if (cfg.type) bits.push(cfg.type);
      if (cfg.start_date) bits.push(`from ${cfg.start_date}`);
      if (cfg.cron_schedule || cfg.schedule) bits.push(cfg.cron_schedule || cfg.schedule);
      if (cfg.partition_keys?.length) bits.push(`${cfg.partition_keys.length} keys`);
      map.set(key, { kind, description: bits.join(' · ') || 'partitioned' });
    }
    return map;
  }, [currentProject]);

  // Group ingestion events by asset_key so per-row widgets (sparkline,
  // freshness clock, drawer) don't have to re-filter on every render.
  const eventsByAssetKey = useMemo(() => {
    const map = new Map<string, IngestionEvent[]>();
    for (const e of events) {
      if (!map.has(e.asset_key)) map.set(e.asset_key, []);
      map.get(e.asset_key)!.push(e);
    }
    // Sort ascending so sparklines read left→right in time order.
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    }
    return map;
  }, [events]);

  const ingestions = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.components
      .filter((c) => isIngestionType(c.component_type))
      .map((c) => {
        const kind = classifyType(c.component_type, c.label || c.id);
        const assetKey = (c.attributes?.asset_name as string) || c.id;
        const configured = isConfigured(c.attributes || {});
        const schema = schemas[assetKey];
        const history = eventsByAssetKey.get(assetKey) ?? [];
        const materializes = history.filter((e) => e.type === 'materialize');
        const lastRun = materializes[materializes.length - 1];
        const previews = history.filter((e) => e.type === 'preview');
        const lastPreview = previews[previews.length - 1];
        const partition = partitionByAssetKey.get(assetKey);
        const schedules = scheduleByAssetKey.get(assetKey) ?? [];
        return {
          component: c,
          assetKey,
          kind,
          configured,
          columnCount: schema?.columns?.length ?? null,
          previewed: !!schema,
          history,
          materializes,
          lastRun,
          lastPreview,
          partition,
          schedules,
          latestStatus: lastRun?.status ?? null,
        };
      });
  }, [currentProject, schemas, eventsByAssetKey, partitionByAssetKey, scheduleByAssetKey]);

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

  // Recently-failed ingestions power the alerts strip at the top so
  // "this thing needs my attention" is the first thing the user sees.
  const recentFailures = useMemo(() => {
    const dayAgo = Date.now() - 24 * 3600e3;
    return ingestions
      .filter((i) => {
        const last = i.materializes[i.materializes.length - 1];
        return last && last.status === 'failure' && new Date(last.ts).getTime() >= dayAgo;
      })
      .map((i) => ({
        assetKey: i.assetKey,
        label: i.component.label || i.component.id,
        when: i.materializes[i.materializes.length - 1]?.ts,
      }));
  }, [ingestions]);

  // Filtered view for the table — driven by search box + kind selector.
  const filteredIngestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ingestions.filter((i) => {
      if (kindFilter !== 'all' && i.kind !== kindFilter) return false;
      if (q) {
        const blob = (
          i.component.label + ' ' + i.component.id + ' ' + i.assetKey + ' ' + i.component.component_type
        ).toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [ingestions, search, kindFilter]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllFiltered = () => {
    setSelectedIds(new Set(filteredIngestions.filter((i) => i.configured).map((i) => i.component.id)));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleRunSelected = async () => {
    if (!currentProject || selectedIds.size === 0) return;
    const assetKeys = ingestions
      .filter((i) => selectedIds.has(i.component.id) && i.configured)
      .map((i) => i.assetKey);
    if (assetKeys.length === 0) return;
    setRunningBulk(true);
    try {
      const r = await projectsApi.materialize(currentProject.id, assetKeys);
      if (!r.success) {
        notify.error(`Bulk materialize failed. See console.`);
        console.warn('[Ingestions] bulk stderr:', r.stderr);
      } else {
        notify.success(`Materialized ${assetKeys.length} ingestion${assetKeys.length === 1 ? '' : 's'}.`);
      }
      // Refresh the event log so KPIs + sparklines reflect the new runs.
      const fresh = await assetsApi.ingestionHistory(currentProject.id, 5000);
      setEvents(fresh.events || []);
      clearSelection();
    } catch (e: any) {
      notify.error(`Bulk materialize failed: ${e?.message ?? e}`);
    } finally {
      setRunningBulk(false);
    }
  };

  // Ingestion-only event view: filter the raw log down to events whose
  // asset_key belongs to one of the ingestion components we know about
  // in this project. Prevents transform / sink activity from muddying
  // the "state of your ingestions" KPIs.
  const ingestionAssetKeys = useMemo(
    () => new Set(ingestions.map((i) => i.assetKey)),
    [ingestions],
  );
  const ingestionEvents = useMemo(
    () => events.filter((e) => ingestionAssetKeys.has(e.asset_key)),
    [events, ingestionAssetKeys],
  );

  // Time-windowed analytics — 24h / 7d / 30d switch drives the KPIs
  // AND the trend chart together so users can pivot the whole board.
  const windowMs = window === '24h' ? 24 * 3600e3 : window === '7d' ? 7 * 24 * 3600e3 : 30 * 24 * 3600e3;
  const now = Date.now();
  const windowedEvents = useMemo(
    () => ingestionEvents.filter((e) => now - new Date(e.ts).getTime() <= windowMs),
    [ingestionEvents, windowMs, now],
  );

  // "Total rows ingested" — sum the LATEST successful preview row count
  // per asset (not cumulative across preview calls) so re-previewing a
  // static table doesn't double-count. Windowed variant only counts
  // assets that ran inside the window.
  const analytics = useMemo(() => {
    const latestPerAsset = new Map<string, IngestionEvent>();
    for (const e of ingestionEvents) {
      if (e.status !== 'success' || (e.rows ?? null) === null) continue;
      const prev = latestPerAsset.get(e.asset_key);
      if (!prev || new Date(e.ts) > new Date(prev.ts)) latestPerAsset.set(e.asset_key, e);
    }
    const totalRows = Array.from(latestPerAsset.values()).reduce((s, e) => s + (e.rows ?? 0), 0);
    const totalBytes = Array.from(latestPerAsset.values()).reduce((s, e) => s + (e.bytes ?? 0), 0);

    const windowMats = windowedEvents.filter((e) => e.type === 'materialize');
    const successes = windowMats.filter((e) => e.status === 'success').length;
    const failures = windowMats.filter((e) => e.status === 'failure').length;
    const running = ingestionEvents.filter((e) => e.status === 'running').length;
    const successRate = windowMats.length > 0 ? successes / windowMats.length : null;

    const durations = windowMats.filter((e) => e.duration_ms != null).map((e) => e.duration_ms!);
    const avgDurationMs = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;

    return { totalRows, totalBytes, successes, failures, running, successRate, avgDurationMs };
  }, [ingestionEvents, windowedEvents]);

  // Trend series — one bucket per day (or hour for 24h) of the window,
  // counting materializes. Simple SVG line + area chart below.
  const trend = useMemo(() => {
    const bucketMs = window === '24h' ? 3600e3 : 24 * 3600e3;      // 1h or 1d
    const bucketCount = window === '24h' ? 24 : window === '7d' ? 7 : 30;
    const startMs = now - bucketCount * bucketMs;
    const buckets: { t: number; success: number; failure: number; rows: number }[] = [];
    for (let i = 0; i < bucketCount; i++) {
      buckets.push({ t: startMs + i * bucketMs, success: 0, failure: 0, rows: 0 });
    }
    for (const e of windowedEvents) {
      const dt = new Date(e.ts).getTime();
      if (dt < startMs) continue;
      const idx = Math.min(bucketCount - 1, Math.floor((dt - startMs) / bucketMs));
      if (e.type === 'materialize') {
        if (e.status === 'success') buckets[idx].success++;
        else if (e.status === 'failure') buckets[idx].failure++;
      }
      if (e.type === 'preview' && e.status === 'success') {
        buckets[idx].rows += e.rows ?? 0;
      }
    }
    return { buckets, bucketMs, bucketCount };
  }, [windowedEvents, window, now]);

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
            Every data source flowing into the project, and how it's performing.
          </p>
        </div>
        <button
          onClick={() => setAddDataOpen(true)}
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent"
        >
          <Download className="w-4 h-4" /> Add data
        </button>
      </div>

      {/* Alerts strip — surfaced first because "which ingestions need my
          attention right now" is the whole reason to visit this page. */}
      {recentFailures.length > 0 && (
        <div className="mx-8 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 rounded-md flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-rose-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-rose-900">
              {recentFailures.length} ingestion{recentFailures.length === 1 ? '' : 's'} failed in the last 24h
            </div>
            <div className="text-xs text-rose-700 truncate">
              {recentFailures.slice(0, 4).map((f) => f.label).join(', ')}
              {recentFailures.length > 4 && ` +${recentFailures.length - 4} more`}
            </div>
          </div>
          <button
            onClick={() => {
              const firstFailed = recentFailures[0];
              const target = ingestions.find((i) => i.assetKey === firstFailed.assetKey);
              if (target) setDrawerFor(target.component.id);
            }}
            className="text-xs font-medium text-rose-700 hover:text-rose-900 flex-shrink-0"
          >
            Investigate →
          </button>
        </div>
      )}

      {/* KPI band + time-window switcher. The KPIs pivot with the switch
          so 24h / 7d / 30d all use one place. */}
      <div className="px-8 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Overview</h2>
          <div className="flex items-center gap-0.5 bg-gray-100 rounded p-0.5">
            {(['24h', '7d', '30d'] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-2.5 py-1 text-xs rounded ${
                  window === w ? 'bg-white text-gray-900 shadow-sm font-medium' : 'text-gray-600'
                }`}
              >
                Last {w}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard
            label="Total rows ingested"
            value={formatCompact(analytics.totalRows)}
            hint={analytics.totalBytes > 0 ? `≈ ${formatBytes(analytics.totalBytes)}` : 'across all sources'}
            icon={TrendingUp}
            tone="success"
          />
          <KpiCard
            label="Active now"
            value={String(analytics.running)}
            hint={analytics.running > 0 ? 'currently running' : 'no runs in flight'}
            icon={analytics.running > 0 ? Loader2 : Activity}
            iconSpin={analytics.running > 0}
            tone={analytics.running > 0 ? 'success' : 'neutral'}
          />
          <KpiCard
            label={`Successful runs (${window})`}
            value={String(analytics.successes)}
            hint={
              analytics.successRate !== null
                ? `${Math.round((analytics.successRate ?? 0) * 100)}% success rate`
                : 'no runs yet'
            }
            icon={CheckCircle2}
            tone="success"
          />
          <KpiCard
            label={`Failed runs (${window})`}
            value={String(analytics.failures)}
            hint={
              analytics.avgDurationMs !== null
                ? `avg run ${(analytics.avgDurationMs / 1000).toFixed(1)}s`
                : undefined
            }
            icon={XCircle}
            tone={analytics.failures > 0 ? 'warning' : 'neutral'}
          />
        </div>

        {/* Trend chart — successes/failures per bucket, area rows-ingested. */}
        <TrendChart trend={trend} window={window} />

        {/* Existing source-mix strip kept below the trend so users still
            see composition at a glance. */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-900">Source mix</h2>
            <span className="text-xs text-gray-500">{kpis.total} sources · {kpis.configured} configured · {kpis.unconfigured} needing config</span>
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
                      className={KIND_META[kind].color}
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
          {/* Table toolbar — search, kind filter, bulk actions. Stays
              visible even when the empty-state is showing so users
              understand the shape of the surface. */}
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-gray-900 mr-2">Ingestion sources</h2>
            <div className="relative flex-1 max-w-md">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sources…"
                className="w-full pl-2 pr-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as SourceKind | 'all')}
              className="text-xs border border-gray-300 rounded px-2 py-1"
            >
              <option value="all">All kinds</option>
              {(Object.keys(KIND_META) as SourceKind[]).map((k) => (
                <option key={k} value={k}>{KIND_META[k].label}</option>
              ))}
            </select>
            {selectedIds.size > 0 && (
              <>
                <div className="h-4 w-px bg-gray-200 mx-1" />
                <span className="text-xs text-gray-600">{selectedIds.size} selected</span>
                <button
                  onClick={handleRunSelected}
                  disabled={runningBulk}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-60"
                >
                  {runningBulk ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  {runningBulk ? 'Running…' : 'Materialize selected'}
                </button>
                <button
                  onClick={clearSelection}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  Clear
                </button>
              </>
            )}
            <div className="ml-auto text-xs text-gray-500">
              {filteredIngestions.length} of {ingestions.length}
            </div>
          </div>
          {filteredIngestions.length === 0 ? (
            <div className="p-8 text-center">
              <Download className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-600 mb-3">
                {ingestions.length === 0
                  ? "You don't have any ingestion sources in this project yet."
                  : 'No sources match the current search/filter.'}
              </p>
              {ingestions.length === 0 && (
                <button
                  onClick={() => setAddDataOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded"
                >
                  <Download className="w-4 h-4" /> Add your first source
                </button>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={selectedIds.size > 0 && filteredIngestions.every((i) => selectedIds.has(i.component.id) || !i.configured)}
                      onChange={(e) => (e.target.checked ? selectAllFiltered() : clearSelection())}
                      className="w-3.5 h-3.5"
                      title="Select all configured"
                    />
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Kind</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Cadence</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Last 8 runs</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Freshness</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredIngestions.map((row) => {
                  const { component, assetKey, kind, configured, materializes, lastRun, partition, schedules } = row;
                  const KindIcon = KIND_META[kind].icon;
                  const isSelected = selectedIds.has(component.id);
                  return (
                    <tr
                      key={component.id}
                      className={`border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer ${
                        isSelected ? 'bg-blue-50/40' : ''
                      }`}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest('button, input, select, a')) return;
                        setDrawerFor(component.id);
                      }}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(component.id)}
                          disabled={!configured}
                          className="w-3.5 h-3.5"
                          title={configured ? 'Select for bulk actions' : 'Configure first'}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-900 flex items-center gap-1.5">
                          {component.label || component.id}
                          {partition && (
                            <span
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded bg-indigo-50 text-indigo-700 border border-indigo-200"
                              title={`Partitioned (${partition.description}) — Dagster runs this incrementally per partition key.`}
                            >
                              <Layers className="w-2.5 h-2.5" /> incremental
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-500 font-mono truncate max-w-[240px]" title={component.component_type}>
                          {assetKey}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-block w-2 h-2 rounded-sm ${KIND_META[kind].color}`} />
                          <KindIcon className="w-3.5 h-3.5 text-gray-500" />
                          <span className="text-xs text-gray-700">{KIND_META[kind].label}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {schedules.length > 0 ? (
                          <div className="flex flex-col gap-0.5">
                            {schedules.slice(0, 2).map((s, i) => (
                              <div key={i} className="inline-flex items-center gap-1 text-gray-700" title={s.label}>
                                <CalendarClock className="w-3 h-3 text-gray-500" />
                                <span className="font-mono text-[11px]">{s.cron || 'scheduled'}</span>
                              </div>
                            ))}
                            {schedules.length > 2 && <span className="text-[10px] text-gray-400">+{schedules.length - 2}</span>}
                          </div>
                        ) : (
                          <span className="text-gray-400 italic">manual</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Sparkline runs={materializes} />
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {lastRun ? (
                          <div className="flex flex-col">
                            <span className="text-gray-700">{formatRelative(lastRun.ts)}</span>
                            {lastRun.duration_ms != null && (
                              <span className="text-[10px] text-gray-400">
                                took {(lastRun.duration_ms / 1000).toFixed(1)}s
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 italic">never run</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {!configured ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                            <AlertTriangle className="w-3 h-3" /> Needs config
                          </span>
                        ) : lastRun?.status === 'failure' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                            <XCircle className="w-3 h-3" /> Failed
                          </span>
                        ) : lastRun?.status === 'success' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="w-3 h-3" /> Healthy
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                            <Clock className="w-3 h-3" /> Idle
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
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

      {/* Row detail drawer — opens on row click. Shows recent runs and
          errors so users can debug without opening the modal. */}
      {drawerFor && (() => {
        const target = ingestions.find((i) => i.component.id === drawerFor);
        if (!target) return null;
        return (
          <RowDetailDrawer
            target={target}
            onClose={() => setDrawerFor(null)}
            onEdit={() => {
              onEditComponent(target.component);
              setDrawerFor(null);
            }}
            onRun={() => handleRun(target.assetKey, target.component.id)}
            running={runningId === target.component.id}
          />
        );
      })()}

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
  iconSpin = false,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: any;
  iconSpin?: boolean;
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
        <Icon className={`w-5 h-5 ${iconSpin ? 'animate-spin' : ''}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</div>
        <div className="flex items-baseline gap-1.5 mt-0.5">
          <div className="text-2xl font-semibold text-gray-900 tabular-nums">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </div>
          {hint && <div className="text-xs text-gray-500">{hint}</div>}
        </div>
      </div>
    </div>
  );
}

// Trend chart — one bar per bucket, green successes on top of red
// failures, with a rows-ingested area behind. Pure SVG so we don't pull
// in a charting lib for one view.
function TrendChart({
  trend,
  window,
}: {
  trend: { buckets: Array<{ t: number; success: number; failure: number; rows: number }>; bucketMs: number; bucketCount: number };
  window: '24h' | '7d' | '30d';
}) {
  const buckets = trend.buckets;
  const maxCount = Math.max(1, ...buckets.map((b) => b.success + b.failure));
  const maxRows = Math.max(1, ...buckets.map((b) => b.rows));
  const anyActivity = buckets.some((b) => b.success + b.failure + b.rows > 0);
  const width = 100; // percent
  const height = 100; // scaled via viewBox
  const barW = width / buckets.length;

  const fmtLabel = (t: number) => {
    const d = new Date(t);
    return window === '24h'
      ? d.toLocaleTimeString([], { hour: 'numeric' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const rowsPath = buckets
    .map((b, i) => {
      const x = i * barW + barW / 2;
      const y = height - (b.rows / maxRows) * (height * 0.9);
      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    })
    .join(' ');

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Ingestion activity</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {window === '24h' ? 'Hourly' : 'Daily'} runs + rows ingested across all sources
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-gray-500">
          <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-emerald-400 rounded-sm" /> success</div>
          <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-rose-400 rounded-sm" /> failure</div>
          <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-blue-400/60 rounded-sm" /> rows</div>
        </div>
      </div>
      {!anyActivity ? (
        <div className="py-8 text-center text-xs text-gray-400">
          No activity yet in the last {window}. Materialize or preview an ingestion to start populating this chart.
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-40">
            {/* rows-ingested line */}
            <path d={rowsPath} fill="none" stroke="rgb(59 130 246 / 0.6)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
            {/* bars */}
            {buckets.map((b, i) => {
              const failH = (b.failure / maxCount) * (height * 0.9);
              const succH = (b.success / maxCount) * (height * 0.9);
              const x = i * barW + barW * 0.15;
              const w = barW * 0.7;
              const failY = height - failH;
              const succY = failY - succH;
              return (
                <g key={i}>
                  {failH > 0 && <rect x={x} y={failY} width={w} height={failH} fill="rgb(251 113 133)" />}
                  {succH > 0 && <rect x={x} y={succY} width={w} height={succH} fill="rgb(52 211 153)" />}
                  {b.success + b.failure === 0 && b.rows === 0 && (
                    <rect x={x} y={height - 0.6} width={w} height={0.6} fill="rgb(229 231 235)" />
                  )}
                  <title>
                    {new Date(b.t).toLocaleString()} · {b.success} success · {b.failure} failure · {b.rows.toLocaleString()} rows
                  </title>
                </g>
              );
            })}
          </svg>
          <div className="mt-1 grid text-[10px] text-gray-400 tabular-nums" style={{ gridTemplateColumns: `repeat(${buckets.length}, 1fr)` }}>
            {buckets.map((b, i) => {
              const showLabel = window === '24h' ? i % 4 === 0 : window === '7d' ? true : i % 5 === 0;
              return (
                <div key={i} className="text-center truncate">
                  {showLabel ? fmtLabel(b.t) : ''}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function formatCompact(n: number): string {
  if (!isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(ts: string): string {
  const dt = Date.now() - new Date(ts).getTime();
  if (dt < 60_000) return 'just now';
  if (dt < 3600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 24 * 3600_000) return `${Math.floor(dt / 3600_000)}h ago`;
  if (dt < 7 * 24 * 3600_000) return `${Math.floor(dt / (24 * 3600_000))}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Per-row status squares — last N materializes, green/red left→right.
// Empty runs render as a light grey placeholder so the width is stable
// across rows even when a source has never been materialized.
function Sparkline({ runs, size = 8 }: { runs: IngestionEvent[]; size?: number }) {
  const N = 8;
  const recent = runs.slice(-N);
  const empty = N - recent.length;
  return (
    <div className="flex items-end gap-0.5" title={`Last ${recent.length} runs`}>
      {Array.from({ length: empty }).map((_, i) => (
        <div
          key={`e${i}`}
          style={{ width: size, height: size }}
          className="rounded-sm bg-gray-100"
        />
      ))}
      {recent.map((e, i) => {
        const color =
          e.status === 'success' ? 'bg-emerald-400'
          : e.status === 'failure' ? 'bg-rose-400'
          : 'bg-gray-300';
        return (
          <div
            key={i}
            style={{ width: size, height: size }}
            className={`rounded-sm ${color}`}
            title={`${new Date(e.ts).toLocaleString()} — ${e.status}${e.duration_ms != null ? ` (${(e.duration_ms / 1000).toFixed(1)}s)` : ''}`}
          />
        );
      })}
    </div>
  );
}

// Row-detail drawer — recent runs, errors, quick actions. Slides in on
// row click, gives users a debug surface without leaving the page.
function RowDetailDrawer({
  target,
  onClose,
  onEdit,
  onRun,
  running,
}: {
  target: any;
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  running: boolean;
}) {
  const runs = (target.materializes as IngestionEvent[]).slice(-20).reverse();
  const KindIcon = KIND_META[target.kind as SourceKind].icon;
  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <div
        className="w-[420px] max-w-full bg-white h-full shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <KindIcon className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <h3 className="text-sm font-semibold text-gray-900 truncate">
                {target.component.label || target.component.id}
              </h3>
            </div>
            <p className="text-[11px] text-gray-500 font-mono truncate mt-0.5" title={target.component.component_type}>
              {target.component.component_type.split('.').pop()}
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" aria-label="Close">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* Quick facts */}
        <div className="p-4 space-y-3 flex-shrink-0 border-b border-gray-100 bg-gray-50">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Fact label="Destination asset" value={target.assetKey} mono />
            <Fact label="Kind" value={KIND_META[target.kind as SourceKind].label} />
            <Fact
              label="Cadence"
              value={
                target.schedules.length > 0
                  ? target.schedules.map((s: any) => s.cron || 'scheduled').join(', ')
                  : 'manual'
              }
            />
            <Fact
              label="Partition"
              value={target.partition ? `${target.partition.kind} · ${target.partition.description}` : 'none'}
            />
            <Fact
              label="Configured"
              value={target.configured ? '✓ yes' : '⚠ needs config'}
              tone={target.configured ? 'success' : 'warning'}
            />
            <Fact
              label="Last run"
              value={target.lastRun ? formatRelative(target.lastRun.ts) : 'never'}
            />
          </div>
          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={onRun}
              disabled={!target.configured || running}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-40"
            >
              {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {running ? 'Running…' : 'Run now'}
            </button>
            <button
              onClick={onEdit}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded"
            >
              <Settings className="w-3 h-3" />
              Configure
            </button>
          </div>
        </div>

        {/* Recent runs */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3 border-b border-gray-100">
            <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Recent runs</h4>
          </div>
          {runs.length === 0 ? (
            <div className="p-8 text-center text-xs text-gray-400">
              No runs recorded yet. Materialize this ingestion to see history here.
            </div>
          ) : (
            <ul className="divide-y divide-gray-50">
              {runs.map((e, i) => (
                <li key={i} className="px-4 py-2 flex items-center gap-2 text-xs">
                  {e.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />}
                  {e.status === 'failure' && <XCircle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" />}
                  {e.status === 'running' && <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-gray-800">{formatRelative(e.ts)}</div>
                    <div className="text-[10px] text-gray-400 tabular-nums">
                      {new Date(e.ts).toLocaleString()}
                      {e.duration_ms != null && ` · ${(e.duration_ms / 1000).toFixed(1)}s`}
                      {e.rows != null && ` · ${e.rows.toLocaleString()} rows`}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'success' | 'warning';
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-700'
    : tone === 'warning' ? 'text-amber-700'
    : 'text-gray-800';
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${toneClass} break-all`}>{value}</span>
    </div>
  );
}
