import React, { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Play, ChevronRight, ChevronDown, Layers as LayersIcon, Database, CheckCircle2, AlertTriangle,
  Book, Filter as FilterIcon, Clock, Zap, Timer, Users as UsersIcon,
  ExternalLink, Copy, GitBranch, Tag as TagIcon, Pencil, X, Check, Loader2, ArrowLeft,
  History, Calendar, ArrowUpRight, ArrowDownRight, Ban, Download, BarChart3, MinusCircle,
} from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, assetsApi, partitionsApi, primitivesApi, dagsterPlusOrgBaseUrl, type BackfillRequest, type AssetChangeEntry } from '@/services/api';
import { classifyStatus, statusTextClass } from '@/lib/status';
import { notify } from './Notifications';
import { PartitionBackfill } from './PartitionBackfill';
import { StartDgDevButton } from './RunsPanel';
import { InsightMetricCard } from './InsightMetricCard';
import { MetadataEntryList } from './MetadataEntryList';
import type { GraphNode, ComponentInstance } from '@/types';

const isDbtComponentType = (t: string | undefined | null): boolean => !!t && /\bdbt[_.]|^dbt/i.test(t);

function buildDagsterPlusAssetUrl(project: any, assetKey: string): string {
  const base = dagsterPlusOrgBaseUrl(project);
  const dep = project?.dagster_plus_deployment || '';
  const encoded = encodeURIComponent(assetKey);
  return dep ? `${base}/${dep}/assets/${encoded}` : `${base}/assets/${encoded}`;
}

/**
 * Full-screen asset detail view -- opens on top of the Assets tab when
 * a row in the catalog (or the "View full details" button in the
 * PropertyPanel) is clicked. Mirrors the layout of the Dagster+ native
 * asset page: header with breadcrumbs + status + Materialize action,
 * tab strip, and a two-column Overview panel.
 *
 * Data comes from the already-hydrated project graph node -- no new
 * network calls in this pass. Fields we can't populate cheaply yet
 * (row count on local, freshness detail) show as "N/A" rather than
 * fabricating a value.
 */
interface AssetDetailPageProps {
  nodeId: string;
  onClose: () => void;
  /** Route to the template builder for creating a fresh schedule /
   *  sensor / job / check that will target this asset. */
  onNewPrimitiveForAsset?: (
    category: 'schedule' | 'job' | 'sensor' | 'asset_check' | 'freshness_policy',
    assetKey: string,
  ) => void;
  /** Jump the detail page to a different node (e.g. clicking an
   *  upstream/downstream asset in the Lineage tab) without closing
   *  the overlay. */
  onNavigate?: (nodeId: string) => void;
  /** Jump to the Runs tab for a specific run id (e.g. clicking a
   *  materialization event in the Events tab). */
  onOpenRun?: (runId: string) => void;
  /** Open directly on a specific tab (e.g. drilling in from the
   *  deployment-level Insights page should land on Insights, not
   *  Overview). Defaults to 'overview'. */
  initialTab?: Tab;
}

export type Tab = 'overview' | 'partitions' | 'events' | 'checks' | 'lineage' | 'insights' | 'change_history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',       label: 'Overview' },
  { id: 'partitions',     label: 'Partitions' },
  { id: 'events',         label: 'Events' },
  { id: 'checks',         label: 'Checks' },
  { id: 'lineage',        label: 'Lineage' },
  { id: 'insights',       label: 'Insights' },
  { id: 'change_history', label: 'Change history' },
];

export function AssetDetailPage({ nodeId, onClose, onNewPrimitiveForAsset, onNavigate, onOpenRun, initialTab }: AssetDetailPageProps) {
  const { currentProject } = useProjectStore();
  const [activeTab, setActiveTab] = useState<Tab>(initialTab || 'overview');

  const node: GraphNode | undefined = useMemo(
    () => currentProject?.graph.nodes.find((n) => n.id === nodeId) as GraphNode | undefined,
    [currentProject, nodeId],
  );

  if (!currentProject || !node) return null;

  // Cast to `any` here -- our runtime asset-node data carries a lot of
  // fields (is_materializable, columns, tags, is_connection, etc.) that
  // aren't in the strict GraphNodeData interface. Keeping the cast
  // localized rather than widening the shared type.
  const data = node.data as any;
  const isCloud = !!(currentProject as any).is_dagster_plus;
  const assetKey = (data.asset_key as string) || nodeId;
  const displayName = assetKey.split('/').pop() || assetKey;
  const groupName = (data.group_name as string) || '';

  // Aggregate status from the check list + materialization signals we have.
  const checks: any[] = Array.isArray(data.checks) ? data.checks : [];
  const failingChecks = checks.filter((c) => {
    const s = (c.last_status || '').toLowerCase();
    return s === 'fail' || s === 'error' || s === 'failed';
  });
  const passingChecks = checks.filter((c) => {
    const s = (c.last_status || '').toLowerCase();
    return s === 'pass' || s === 'success' || s === 'succeeded';
  });
  const overallState: 'healthy' | 'degraded' | 'unknown' =
    failingChecks.length > 0 ? 'degraded'
      : passingChecks.length > 0 ? 'healthy'
      : 'unknown';

  return (
    <div className="w-full h-full flex flex-col bg-white">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-gray-200 px-6 py-3 flex items-start justify-between gap-4 bg-white">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {/* Back sits first/left, matching MonitorDetailPage's convention
              -- it used to be a small text link on the far right of the
              action row (after Materialize), easy to miss and inconsistent
              with every other detail page's navigation. */}
          <button
            onClick={onClose}
            className="p-1 mt-0.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded flex-shrink-0"
            title="Back to the asset graph / catalog"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 text-xs text-gray-500 mb-1 truncate">
              <span>Catalog</span>
              <ChevronRight className="w-3 h-3 flex-shrink-0" />
              <span>All assets</span>
              {groupName && (
                <>
                  <ChevronRight className="w-3 h-3 flex-shrink-0" />
                  <span className="text-gray-700 font-medium">{groupName}</span>
                </>
              )}
              <ChevronRight className="w-3 h-3 flex-shrink-0" />
              <span className="text-gray-900 font-semibold truncate">{displayName}</span>
            </div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold text-gray-900 truncate">{displayName}</h1>
              <StatusPill state={overallState} />
              <button
                onClick={() => { navigator.clipboard.writeText(assetKey); }}
                className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
                title={`Copy asset key: ${assetKey}`}
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            disabled={isCloud || !data.is_materializable}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            title={isCloud ? 'Not available on Dagster+ (read-only)' : !data.is_materializable ? 'Asset is not materializable' : 'Materialize this asset'}
          >
            <Play className="w-4 h-4" />
            Materialize
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 border-b border-gray-200 px-6 flex items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t.id
                ? 'text-blue-600 border-blue-600'
                : 'text-gray-600 border-transparent hover:text-gray-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto bg-gray-50">
        {activeTab === 'overview' && <OverviewTab node={node} isCloud={isCloud} onNewPrimitiveForAsset={onNewPrimitiveForAsset} onNavigate={onNavigate} />}
        {activeTab === 'checks' && <ChecksTab node={node} projectId={currentProject.id} onOpenRun={onOpenRun} />}
        {activeTab === 'lineage' && <LineageTab node={node} currentProject={currentProject} onNavigate={onNavigate} />}
        {activeTab === 'events' && <EventsTab node={node} projectId={currentProject.id} onOpenRun={onOpenRun} />}
        {activeTab === 'partitions' && <PartitionsTab node={node} isCloud={isCloud} projectId={currentProject.id} currentProject={currentProject} onOpenRun={onOpenRun} />}
        {activeTab === 'insights' && <InsightsTab node={node} isCloud={isCloud} projectId={currentProject.id} />}
        {activeTab === 'change_history' && <ChangeHistoryTab node={node} isCloud={isCloud} projectId={currentProject.id} />}
      </div>
    </div>
  );
}

// ---------- Checks tab ----------

function ChecksTab({ node, projectId, onOpenRun }: { node: GraphNode; projectId: string; onOpenRun?: (runId: string) => void }) {
  const data = node.data as any;
  const checks: any[] = Array.isArray(data.checks) ? data.checks : [];
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (checks.length === 0) {
    return (
      <div className="p-12 text-center text-gray-500">
        <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">No checks on this asset yet.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1000px] mx-auto space-y-3">
      {checks.map((c, i) => {
        const monitorId = c.key || `${data.asset_key}::${c.name || i}`;
        return (
          <CheckDetailRow
            key={monitorId}
            check={c}
            projectId={projectId}
            monitorId={monitorId}
            isExpanded={expandedKey === monitorId}
            onToggle={() => setExpandedKey(expandedKey === monitorId ? null : monitorId)}
            onOpenRun={onOpenRun}
          />
        );
      })}
    </div>
  );
}

function CheckDetailRow({
  check, projectId, monitorId, isExpanded, onToggle, onOpenRun,
}: {
  check: any;
  projectId: string;
  monitorId: string;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const c = classifyStatus(check.last_status);
  const ok = c === 'success';
  const bad = c === 'failure';

  const { data: history, isLoading } = useQuery({
    queryKey: ['monitor-history', projectId, monitorId],
    queryFn: () => projectsApi.getMonitorHistory(projectId, monitorId, 25),
    enabled: isExpanded,
    staleTime: 30_000,
  });

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-start gap-2.5 p-3 text-left hover:bg-gray-50/50">
        {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
          : bad ? <AlertTriangle className="w-4 h-4 text-rose-500 mt-0.5 flex-shrink-0" />
          : <span className="w-4 h-4 mt-0.5 flex-shrink-0 inline-block rounded-full border border-gray-300" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 truncate">{check.name || 'check'}</span>
            {check.blocking && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 border border-amber-200 text-amber-700">
                <Ban className="w-2.5 h-2.5" /> blocking
              </span>
            )}
          </div>
          {check.description && <p className="text-xs text-gray-500 mt-0.5">{check.description}</p>}
          <div className="flex items-center gap-3 mt-1 text-[11px] text-gray-500">
            <span>{check.last_status ? check.last_status.toLowerCase() : 'never run'}</span>
            {check.last_run_at && <span>· {formatRelative(check.last_run_at)}</span>}
            {Array.isArray(check.job_names) && check.job_names.length > 0 && (
              <span className="font-mono">· {check.job_names.join(', ')}</span>
            )}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
      </button>
      {isExpanded && (
        <div className="border-t border-gray-100 px-3 py-2 bg-gray-50/50">
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-gray-500 py-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading run history…</div>
          ) : !history?.events?.length ? (
            <p className="text-xs text-gray-400 italic py-1">No run history recorded yet.</p>
          ) : (
            <>
              {history.numeric_series.length > 1 && (
                <div className="pb-2 mb-2 border-b border-gray-100">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-1">
                    {history.numeric_label ?? 'value'} over time
                  </div>
                  <CheckMetricChart points={history.numeric_series} />
                </div>
              )}
              <ul className="divide-y divide-gray-100">
                {history.events.slice().reverse().map((e, i) => {
                  const ec = classifyStatus(e.status);
                  return (
                    <li key={i} className="py-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        {ec === 'success' ? <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                          : ec === 'failure' ? <AlertTriangle className="w-3 h-3 text-rose-500 flex-shrink-0" />
                          : ec === 'skipped' ? <MinusCircle className="w-3 h-3 text-gray-400 flex-shrink-0" />
                          : <span className="w-3 h-3 flex-shrink-0 inline-block rounded-full border border-gray-300" />}
                        <span className="text-gray-500 tabular-nums flex-shrink-0">{formatRelative(e.ts)}</span>
                        {e.value != null && (
                          <span className="text-gray-700 font-mono flex-shrink-0">
                            {formatMetricValue(e.value)} {e.value_label ?? ''}
                          </span>
                        )}
                        {e.message && <span className="text-gray-600 truncate">{e.message}</span>}
                        {e.run_id && onOpenRun && (
                          <button
                            onClick={() => onOpenRun(e.run_id!)}
                            className="ml-auto flex-shrink-0 text-indigo-600 hover:text-indigo-800 hover:underline font-mono"
                            title={`Open run ${e.run_id}`}
                          >
                            view run
                          </button>
                        )}
                      </div>
                      <MetadataEntryList entries={e.metadata} />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatMetricValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  if (Math.abs(v) < 0.01) return v.toExponential(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Bare SVG line chart for a check's numeric metadata over time (e.g.
 *  failed row count, execution duration) -- no charting library dep,
 *  small enough to hand-roll. */
function CheckMetricChart({ points }: { points: Array<{ ts: string; value: number }> }) {
  const width = 600;
  const height = 80;
  const paddingX = 6;
  const paddingY = 8;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - 2 * paddingX) / Math.max(1, points.length - 1);
  const y = (v: number) => paddingY + (1 - (v - min) / range) * (height - 2 * paddingY);
  const x = (i: number) => paddingX + i * stepX;
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const areaD = `${pathD} L ${x(points.length - 1)} ${height - paddingY} L ${x(0)} ${height - paddingY} Z`;
  const last = points[points.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
        <defs>
          <linearGradient id="check-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(99, 102, 241)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="rgb(99, 102, 241)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#check-chart-fill)" />
        <path d={pathD} fill="none" stroke="rgb(99, 102, 241)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={1.5} fill="rgb(99, 102, 241)" />
        ))}
      </svg>
      <div className="flex items-baseline justify-between text-[10px] text-gray-500 mt-1">
        <span>min {formatMetricValue(min)}</span>
        <span className="text-gray-900 font-medium">latest {formatMetricValue(last.value)}</span>
        <span>max {formatMetricValue(max)}</span>
      </div>
    </div>
  );
}

// ---------- Lineage tab ----------

function LineageTab({
  node, currentProject, onNavigate,
}: {
  node: GraphNode;
  currentProject: any;
  onNavigate?: (nodeId: string) => void;
}) {
  const data = node.data as any;
  const myKey = (data.asset_key as string) || '';
  const allNodes: GraphNode[] = currentProject?.graph.nodes || [];

  const byKey = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of allNodes) {
      const k = (n.data as any)?.asset_key as string | undefined;
      if (k) m.set(k, n);
    }
    return m;
  }, [allNodes]);

  const upstream1: string[] = Array.isArray(data.deps) ? data.deps : [];
  const downstream1: GraphNode[] = allNodes.filter((other) =>
    other.id !== node.id
    && Array.isArray(other.data?.deps)
    && (other.data.deps as string[]).includes(myKey)
  );

  const upstream2 = useMemo(() => {
    const seen = new Set<string>([myKey, ...upstream1]);
    const out: string[] = [];
    for (const k of upstream1) {
      const n = byKey.get(k);
      const deps: string[] = Array.isArray(n?.data?.deps) ? (n!.data.deps as string[]) : [];
      for (const d of deps) {
        if (!seen.has(d)) { seen.add(d); out.push(d); }
      }
    }
    return out;
  }, [upstream1, byKey, myKey]);

  const downstream2 = useMemo(() => {
    const seen = new Set<string>([myKey, ...downstream1.map((n) => (n.data as any).asset_key)]);
    const out: GraphNode[] = [];
    for (const n1 of downstream1) {
      const k1 = (n1.data as any).asset_key as string;
      for (const other of allNodes) {
        if (seen.has((other.data as any)?.asset_key)) continue;
        const deps: string[] = Array.isArray(other.data?.deps) ? (other.data.deps as string[]) : [];
        if (deps.includes(k1)) { seen.add((other.data as any).asset_key); out.push(other); }
      }
    }
    return out;
  }, [downstream1, allNodes, myKey]);

  if (!upstream1.length && !downstream1.length) {
    return (
      <div className="p-12 text-center text-gray-500">
        <GitBranch className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">This asset has no upstream or downstream dependencies in the current graph.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
      <LineageColumn
        title="Upstream"
        icon={<ArrowUpRight className="w-3.5 h-3.5" />}
        directKeys={upstream1}
        extendedKeys={upstream2}
        byKey={byKey}
        onNavigate={onNavigate}
        emptyLabel="No upstream dependencies -- this is a source."
      />
      <LineageColumn
        title="Downstream"
        icon={<ArrowDownRight className="w-3.5 h-3.5" />}
        directKeys={downstream1.map((n) => (n.data as any).asset_key)}
        extendedKeys={downstream2.map((n) => (n.data as any).asset_key)}
        byKey={byKey}
        onNavigate={onNavigate}
        emptyLabel="Nothing downstream -- this is a leaf."
      />
    </div>
  );
}

function LineageColumn({
  title, icon, directKeys, extendedKeys, byKey, onNavigate, emptyLabel,
}: {
  title: string;
  icon: React.ReactNode;
  directKeys: string[];
  extendedKeys: string[];
  byKey: Map<string, GraphNode>;
  onNavigate?: (nodeId: string) => void;
  emptyLabel: string;
}) {
  const row = (key: string) => {
    const target = byKey.get(key);
    const clickable = !!(target && onNavigate);
    return (
      <div
        key={key}
        onClick={clickable ? () => onNavigate!(target!.id) : undefined}
        title={key}
        className={`text-[11px] font-mono text-gray-700 truncate px-2 py-1.5 bg-white border border-gray-200 rounded ${
          clickable ? 'cursor-pointer hover:border-blue-300 hover:bg-blue-50/50' : ''
        }`}
      >
        {key}
      </div>
    );
  };
  return (
    <Section title={`${title} (${directKeys.length})`} icon={icon}>
      {directKeys.length ? (
        <div className="space-y-1">{directKeys.map(row)}</div>
      ) : (
        <p className="text-xs text-gray-500 italic">{emptyLabel}</p>
      )}
      {extendedKeys.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-100">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-1.5">
            2 hops out ({extendedKeys.length})
          </div>
          <div className="space-y-1">{extendedKeys.map(row)}</div>
        </div>
      )}
    </Section>
  );
}

// ---------- Events tab ----------

function EventsTab({ node, projectId, onOpenRun }: { node: GraphNode; projectId: string; onOpenRun?: (runId: string) => void }) {
  const data = node.data as any;
  const assetKey = (data.asset_key as string) || node.id;

  const { data: history, isLoading, error } = useQuery({
    queryKey: ['ingestion-history', projectId],
    queryFn: () => assetsApi.ingestionHistory(projectId, 2000),
    staleTime: 15_000,
  });

  const events = (history?.events || [])
    .filter((e) => e.asset_key === assetKey)
    .slice()
    .reverse();

  if (isLoading) {
    return <div className="p-12 text-center text-gray-500"><Loader2 className="w-5 h-5 mx-auto animate-spin" /></div>;
  }
  if (error) {
    return <div className="p-12 text-center text-rose-600 text-sm">Failed to load event history.</div>;
  }
  if (events.length === 0) {
    return (
      <div className="p-12 text-center text-gray-500">
        <History className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">No materialization events recorded for this asset yet.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[900px] mx-auto">
      <ul className="divide-y divide-gray-100 bg-white border border-gray-200 rounded-lg overflow-hidden">
        {events.map((e, i) => {
          const ok = e.status === 'success';
          const bad = e.status === 'failure';
          return (
            <li key={i} className="px-3 py-2.5 text-sm">
              <div className="flex items-center gap-3">
                {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                  : bad ? <AlertTriangle className="w-4 h-4 text-rose-500 flex-shrink-0" />
                  : <Loader2 className="w-4 h-4 text-blue-500 flex-shrink-0" />}
                <span className="text-gray-900 font-medium flex-shrink-0">{e.type === 'preview' ? 'Preview' : 'Materialize'}</span>
                <span className="text-gray-500 tabular-nums flex-shrink-0">{formatRelative(e.ts)}</span>
                {typeof e.rows === 'number' && <span className="text-gray-500 flex-shrink-0">{e.rows.toLocaleString()} rows</span>}
                {typeof e.duration_ms === 'number' && <span className="text-gray-400 flex-shrink-0">{(e.duration_ms / 1000).toFixed(1)}s</span>}
                {e.component && <span className="text-gray-400 truncate font-mono text-xs">{e.component}</span>}
                {e.run_id && onOpenRun && (
                  <button
                    onClick={() => onOpenRun(e.run_id!)}
                    className="ml-auto flex-shrink-0 text-[11px] text-indigo-600 hover:text-indigo-800 hover:underline font-mono"
                    title={`Open run ${e.run_id}`}
                  >
                    view run
                  </button>
                )}
              </div>
              <MetadataEntryList entries={e.metadata} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- Partitions tab ----------

const PARTITION_STATUS_TONE: Record<string, string> = {
  materialized: 'bg-emerald-500',
  failed: 'bg-rose-500',
  materializing: 'bg-blue-400 animate-pulse',
  missing: 'bg-gray-200',
};

function PartitionsTab({
  node, isCloud, projectId, currentProject, onOpenRun,
}: {
  node: GraphNode;
  isCloud: boolean;
  projectId: string;
  currentProject: any;
  onOpenRun?: (runId: string) => void;
}) {
  const data = node.data as any;
  const assetKey = (data.asset_key as string) || node.id;
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [selectedPartition, setSelectedPartition] = useState<string | null>(null);

  // Static definition (type/cadence/cron/timezone) -- local only, no
  // Dagster+ GraphQL equivalent surfaced yet.
  const { data: info } = useQuery({
    queryKey: ['partition-info', projectId, assetKey],
    queryFn: () => partitionsApi.getPartitionInfo(projectId, assetKey),
    enabled: !isCloud,
    staleTime: 30_000,
    retry: false,
  });

  // Per-partition materialization status -- the actual matrix. Same
  // endpoint for local (queries the project's own `dagster dev`) and
  // cloud (queries Dagster+), so this one query covers both.
  const { data: status, isLoading, error, refetch } = useQuery({
    queryKey: ['partition-status', projectId, assetKey],
    queryFn: () => partitionsApi.getPartitionStatus(projectId, assetKey),
    staleTime: 15_000,
    retry: false,
  });

  if (isLoading) {
    return <div className="p-12 text-center text-gray-500"><Loader2 className="w-5 h-5 mx-auto animate-spin" /></div>;
  }
  if (error) {
    const notReachable = /couldn't reach local dagster graphql/i.test(
      (error as any)?.response?.data?.detail || (error as any)?.message || String(error),
    );
    return (
      <div className="p-12 text-center text-gray-500">
        <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm text-rose-600 font-medium">Couldn't load partition status.</p>
        <p className="text-xs mt-1 text-gray-400 max-w-md mx-auto">
          {(error as any)?.response?.data?.detail || (error as any)?.message || String(error)}
        </p>
        {!isCloud && notReachable && (
          <div className="mt-4 flex justify-center">
            <StartDgDevButton onStarted={() => refetch()} />
          </div>
        )}
      </div>
    );
  }
  if (!status?.is_partitioned) {
    return (
      <div className="p-12 text-center text-gray-500">
        <Calendar className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">This asset isn't partitioned.</p>
      </div>
    );
  }

  const def = info?.partitions_def;

  return (
    <div className="p-6 max-w-[900px] mx-auto space-y-4">
      <Section title="Partition status" icon={<Calendar className="w-4 h-4 text-gray-500" />}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Kpi label="Total" value={status.total} />
          <Kpi label="Materialized" value={status.materialized} />
          <Kpi label="Failed" value={status.failed} />
          <Kpi label="Missing" value={status.missing} />
        </div>
        {def && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3 pt-3 border-t border-gray-100">
            <Kpi label="Type" value={def.type} />
            {def.cron_schedule && <Kpi label="Schedule" value={def.cron_schedule} />}
            {def.timezone && <Kpi label="Timezone" value={def.timezone} />}
          </div>
        )}
      </Section>
      <Section
        title={`Partition keys (${status.total})`}
        icon={<LayersIcon className="w-4 h-4 text-gray-500" />}
        headerRight={!isCloud ? (
          <button
            onClick={() => setBackfillOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100"
          >
            <Play className="w-3 h-3" /> Backfill
          </button>
        ) : (
          <a
            href={buildDagsterPlusAssetUrl(currentProject, assetKey)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100"
          >
            <ExternalLink className="w-3 h-3" /> Backfill in Dagster+
          </a>
        )}
      >
        {!status.supported ? (
          <p className="text-xs text-gray-500 italic">
            This asset uses multi-dimensional partitions -- the status matrix isn't supported for those yet.
          </p>
        ) : status.keys.length === 0 ? (
          <p className="text-xs text-gray-500 italic">No partition keys available.</p>
        ) : (
          <>
            {status.truncated && (
              <p className="text-[11px] text-gray-400 italic mb-2">
                Showing the most recent {status.keys.length.toLocaleString()} of {status.total.toLocaleString()} partitions.
              </p>
            )}
            <PartitionHeatmap keys={status.keys} onSelect={setSelectedPartition} />
            <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-500">
              {(['materialized', 'failed', 'materializing', 'missing'] as const).map((s) => (
                <span key={s} className="inline-flex items-center gap-1">
                  <span className={`inline-block w-2.5 h-2.5 rounded-sm ${PARTITION_STATUS_TONE[s]}`} /> {s}
                </span>
              ))}
            </div>
          </>
        )}
      </Section>
      {selectedPartition && (
        <PartitionDetailPanel
          projectId={projectId}
          assetKey={assetKey}
          partition={selectedPartition}
          isCloud={isCloud}
          onClose={() => setSelectedPartition(null)}
          onOpenRun={onOpenRun}
        />
      )}
      {backfillOpen && (
        <PartitionBackfill
          open={backfillOpen}
          onOpenChange={setBackfillOpen}
          projectId={projectId}
          assetKey={assetKey}
          onLaunch={async (request: BackfillRequest) => {
            const r = await partitionsApi.launchBackfill(projectId, request);
            if (r.success) notify.success(`Backfill launched for ${assetKey}.`);
            else notify.error(`Backfill failed: ${r.message}`);
          }}
        />
      )}
    </div>
  );
}

/** GitHub-contribution-style heatmap -- one small square per partition
 *  key, colored by materialization status, hoverable for the exact key.
 *  Flat wrapping grid rather than a calendar layout since partition
 *  cadence varies (daily/hourly/static) and a generic grid reads fine
 *  for all of them without needing to know the cadence. */
function PartitionHeatmap({
  keys, onSelect,
}: {
  keys: Array<{ key: string; status: string }>;
  onSelect: (key: string) => void;
}) {
  const [hovered, setHovered] = useState<{ key: string; status: string } | null>(null);
  return (
    <div>
      {hovered && (
        <div className="text-xs text-gray-700 font-mono mb-1.5 h-4">
          {hovered.key} · <span className="capitalize">{hovered.status}</span> · click for details
        </div>
      )}
      <div className="flex flex-wrap gap-[3px] max-h-64 overflow-y-auto">
        {keys.map((p) => (
          <button
            key={p.key}
            onMouseEnter={() => setHovered(p)}
            onMouseLeave={() => setHovered((h) => (h?.key === p.key ? null : h))}
            onClick={() => onSelect(p.key)}
            className={`inline-block w-3 h-3 rounded-sm cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-gray-400 ${PARTITION_STATUS_TONE[p.status] || 'bg-gray-200'}`}
            title={`${p.key} · ${p.status}`}
          />
        ))}
      </div>
    </div>
  );
}

/** Click-through detail for one partition -- last run (linkable) + last
 *  materialization timestamp, plus a "materialize this partition"
 *  action. Fetched on demand (see getPartitionDetail) rather than
 *  prefetched for the whole matrix. */
function PartitionDetailPanel({
  projectId, assetKey, partition, isCloud, onClose, onOpenRun,
}: {
  projectId: string;
  assetKey: string;
  partition: string;
  isCloud: boolean;
  onClose: () => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [materializing, setMaterializing] = useState(false);
  const queryClient = useQueryClient();
  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['partition-detail', projectId, assetKey, partition],
    queryFn: () => partitionsApi.getPartitionDetail(projectId, assetKey, partition),
    staleTime: 10_000,
    retry: false,
  });

  const handleMaterialize = async () => {
    setMaterializing(true);
    try {
      if (isCloud) {
        const r = await partitionsApi.materializePartitionCloud(projectId, assetKey, partition);
        if (r.success) notify.success(r.message);
        else notify.error(r.message);
      } else {
        const r = await projectsApi.materialize(projectId, [assetKey], undefined, undefined, partition);
        if (r.success) notify.success(`Materialized ${assetKey} for ${partition}.`);
        else notify.error(r.message || r.stderr || 'Materialization failed.');
      }
      queryClient.invalidateQueries({ queryKey: ['partition-status', projectId, assetKey] });
      queryClient.invalidateQueries({ queryKey: ['partition-detail', projectId, assetKey, partition] });
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || String(e));
    } finally {
      setMaterializing(false);
    }
  };

  return (
    <Section
      title={`Partition: ${partition}`}
      icon={<Calendar className="w-4 h-4 text-gray-500" />}
      headerRight={
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100">
          <X className="w-3.5 h-3.5" />
        </button>
      }
    >
      {isLoading ? (
        <div className="py-4 text-center"><Loader2 className="w-4 h-4 mx-auto animate-spin text-gray-400" /></div>
      ) : error ? (
        <p className="text-xs text-rose-600">{(error as any)?.response?.data?.detail || (error as any)?.message || 'Failed to load partition detail.'}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-0.5">Last run</div>
              {detail?.last_run_id ? (
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${statusTextClass(detail.last_run_status)}`}>{detail.last_run_status || 'unknown'}</span>
                  {onOpenRun && (
                    <button onClick={() => onOpenRun(detail.last_run_id!)} className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline font-mono">
                      view run
                    </button>
                  )}
                </div>
              ) : <span className="text-xs text-gray-400 italic">no runs yet</span>}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-0.5">Last materialized</div>
              <span className="text-xs text-gray-700">
                {detail?.last_materialized_at ? new Date(detail.last_materialized_at * 1000).toLocaleString() : <span className="text-gray-400 italic">never</span>}
              </span>
            </div>
          </div>
          <button
            onClick={handleMaterialize}
            disabled={materializing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
          >
            {materializing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {materializing ? 'Materializing…' : `Materialize this partition${isCloud ? ' (Dagster+)' : ''}`}
          </button>
        </div>
      )}
    </Section>
  );
}

// ---------- Insights tab ----------
//
// Live Dagster+ Insights usage/cost/reliability metrics, fetched directly
// via MCP tools (see assets.py's insights-metrics endpoint) -- no LLM in
// the loop. This is pure fetch-and-display data, so routing it through a
// model for "summarization" would just add latency and cost for nothing;
// direct tool calls are the right fit here, same as this app's existing
// direct GraphQL calls for everything else.

function InsightsTab({ node, isCloud, projectId }: { node: GraphNode; isCloud: boolean; projectId: string }) {
  const data = node.data as any;
  const assetKey = (data.asset_key as string) || node.id;
  const [days, setDays] = useState(30);

  const { data: resp, isLoading, error } = useQuery({
    queryKey: ['asset-insights-metrics', projectId, assetKey, days],
    queryFn: () => assetsApi.getInsightsMetrics(projectId, assetKey, days),
    enabled: isCloud,
    staleTime: 60_000,
  });

  if (!isCloud) {
    return (
      <div className="p-12 text-center text-gray-500">
        <BarChart3 className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">Insights (usage, cost, and reliability metrics) is a Dagster+-only feature.</p>
        <p className="text-xs mt-2 text-gray-400">Not available for local projects.</p>
      </div>
    );
  }
  if (isLoading) {
    return <div className="p-12 text-center text-gray-500"><Loader2 className="w-5 h-5 mx-auto animate-spin" /></div>;
  }
  if (error) {
    return <div className="p-12 text-center text-rose-600 text-sm">Failed to load Insights metrics.</div>;
  }
  const metrics = resp?.metrics || [];

  return (
    <div className="p-6 max-w-[1200px] mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">Live from Dagster+ Insights — usage, cost, and reliability over time.</p>
        <div className="inline-flex rounded border border-gray-200 overflow-hidden flex-shrink-0">
          {[7, 30, 60, 90, 120].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-2.5 py-1 text-xs font-medium ${days === d ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>
      {metrics.length === 0 ? (
        <div className="p-12 text-center text-gray-500">
          <BarChart3 className="w-8 h-8 mx-auto mb-2 text-gray-300" />
          <p className="text-sm">No Insights data available for this asset in the last {days} days.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {metrics.map((m) => <InsightMetricCard key={m.metric_name} metric={m} />)}
        </div>
      )}
    </div>
  );
}

function StatusPill({ state }: { state: 'healthy' | 'degraded' | 'unknown' }) {
  if (state === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">
        <CheckCircle2 className="w-3 h-3" />
        Healthy
      </span>
    );
  }
  if (state === 'degraded') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-rose-50 border border-rose-200 text-rose-700">
        <AlertTriangle className="w-3 h-3" />
        Degraded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-gray-100 border border-gray-200 text-gray-600">
      Unknown
    </span>
  );
}

function OverviewTab({ node, isCloud, onNewPrimitiveForAsset, onNavigate }: {
  node: GraphNode;
  isCloud: boolean;
  onNewPrimitiveForAsset?: (category: 'schedule' | 'job' | 'sensor' | 'asset_check' | 'freshness_policy', assetKey: string) => void;
  onNavigate?: (nodeId: string) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const data = node.data as any;
  const assetKey = (data.asset_key as string) || node.id;
  const checks: any[] = Array.isArray(data.checks) ? data.checks : [];
  const columns: Record<string, any> = (data.columns as any) || {};
  const columnNames = Object.keys(columns);
  const schedules: any[] = Array.isArray(data.schedules) ? data.schedules : [];
  const sensors: any[] = Array.isArray(data.sensors) ? data.sensors : [];
  const jobs: any[] = Array.isArray(data.jobs) ? data.jobs : [];

  // Cloud hydration already puts freshness_policy/status/last_materialized
  // directly on the node -- no fetch needed there. Local has no such
  // node-level field (it's only ever surfaced through the primitives
  // list), so this is the one fetch that placeholder actually needed.
  const { data: localFreshness } = useQuery({
    queryKey: ['freshness-primitives', currentProject?.id],
    queryFn: () => primitivesApi.list(currentProject!.id, 'freshness_policy'),
    enabled: !isCloud && !!currentProject,
    staleTime: 30_000,
  });
  const localFreshnessPolicy = localFreshness?.primitives.find((p: any) => p.asset_key === assetKey);
  const freshnessPolicy = isCloud ? data.freshness_policy : localFreshnessPolicy?.policy;
  const freshnessStatus = isCloud ? data.freshness_status : localFreshnessPolicy?.status;
  const freshnessLastMaterialized = isCloud ? data.freshness_last_materialized : null;
  // owners/tags/kinds now consumed by DefinitionSection; keep only
  // what the left column still uses.
  const deps: string[] = Array.isArray(data.deps) ? data.deps : [];

  // Latest check status → recent activity summary for the Status row.
  const passing = checks.filter((c) => {
    const s = (c.last_status || '').toLowerCase();
    return s === 'pass' || s === 'success' || s === 'succeeded';
  }).length;
  const failing = checks.filter((c) => {
    const s = (c.last_status || '').toLowerCase();
    return s === 'fail' || s === 'error' || s === 'failed';
  }).length;
  const latestCheckAt = checks
    .map((c) => c.last_run_at)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];

  const [showFullDescription, setShowFullDescription] = useState(false);
  const [columnSearch, setColumnSearch] = useState('');
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [taggingIngestion, setTaggingIngestion] = useState(false);
  const filteredColumnNames = columnNames.filter((name) =>
    name.toLowerCase().includes(columnSearch.trim().toLowerCase())
  );
  const isTaggedIngestion = !!(currentProject?.manual_ingestion_asset_keys || []).includes(assetKey);

  const handleToggleIngestionTag = async () => {
    if (!currentProject) return;
    setTaggingIngestion(true);
    try {
      if (isTaggedIngestion) {
        await assetsApi.untagAsIngestion(currentProject.id, assetKey);
        notify.success('Removed from Ingestions.');
      } else {
        await assetsApi.tagAsIngestion(currentProject.id, assetKey);
        notify.success('Tagged as an ingestion source -- it now shows on the Ingestions tab.');
      }
      await loadProject(currentProject.id);
    } catch (e: any) {
      notify.error(`Failed to update tag: ${e?.message ?? e}`);
    } finally {
      setTaggingIngestion(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6 max-w-[1600px] mx-auto">
      {/* ------- LEFT COLUMN ------- */}
      <div className="lg:col-span-2 space-y-6">
        {/* Status KPIs */}
        <Section title="Status" icon={<span className="inline-block w-4 h-4 rounded-full border-2 border-gray-300" />}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Kpi label="Latest materialization" value={
              // We don't yet fetch per-asset last-materialization; showing the
              // asset type as a placeholder until we plumb it through.
              data.is_materializable ? 'Materializable' : (data.is_observable ? 'Observable' : 'External')
            } />
            <Kpi label="Latest check results" value={
              checks.length === 0
                ? '—'
                : `${passing}/${checks.length}${failing > 0 ? ` · ${failing} failing` : ''}`
            } tone={failing > 0 ? 'error' : passing > 0 ? 'success' : 'neutral'} />
            <Kpi label="Freshness policy" value={data.is_partitioned ? 'Partitioned' : '—'} />
            <Kpi label="Checks last ran" value={latestCheckAt ? formatRelative(latestCheckAt) : '—'} />
          </div>
        </Section>

        {/* Description */}
        <Section title="Description" icon={<Book className="w-4 h-4 text-gray-500" />}>
          {data.description ? (
            <div>
              <pre className={`text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded p-3 whitespace-pre-wrap font-mono ${!showFullDescription ? 'max-h-40 overflow-hidden relative' : ''}`}>
                {data.description}
              </pre>
              {(data.description || '').length > 300 && (
                <button
                  onClick={() => setShowFullDescription(!showFullDescription)}
                  className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-800"
                >
                  {showFullDescription ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500 italic">No description provided.</p>
          )}
        </Section>

        {/* Lineage -- upstream + downstream co-located. Users think of
            these together ("what feeds this / what depends on this")
            so splitting them across columns felt disjointed. */}
        {(() => {
          const myKey = (data.asset_key as string) || '';
          const consumers = (currentProject?.graph.nodes || []).filter((other) =>
            other.id !== node.id
            && Array.isArray(other.data?.deps)
            && (other.data.deps as string[]).includes(myKey)
          );
          if (!deps.length && !consumers.length) return null;
          // Upstream deps are asset KEYS, not node ids -- resolve each to
          // its node so a click can navigate there (downstream consumers
          // are already full nodes, no lookup needed).
          const byKey = new Map<string, GraphNode>();
          for (const n of (currentProject?.graph.nodes || [])) {
            const k = (n.data as any)?.asset_key as string | undefined;
            if (k) byKey.set(k, n);
          }
          const rowClass = (clickable: boolean) =>
            `text-[11px] font-mono text-gray-700 truncate px-2 py-1 bg-white border border-gray-200 rounded ${
              clickable ? 'cursor-pointer hover:border-blue-300 hover:bg-blue-50/50' : ''
            }`;
          return (
            <Section title="Lineage" icon={<GitBranch className="w-4 h-4 text-gray-500" />}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                      Upstream ({deps.length})
                    </div>
                  </div>
                  {deps.length ? (
                    <div className="space-y-1">
                      {deps.map((d) => {
                        const target = byKey.get(d);
                        const clickable = !!(target && onNavigate);
                        return (
                          <div
                            key={d}
                            onClick={clickable ? () => onNavigate!(target!.id) : undefined}
                            className={rowClass(clickable)}
                            title={d}
                          >
                            {d}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500 italic">No upstream dependencies -- this is a source.</p>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                      Downstream ({consumers.length})
                    </div>
                  </div>
                  {consumers.length ? (
                    <div className="space-y-1">
                      {consumers.map((c) => {
                        const clickable = !!onNavigate;
                        return (
                          <div
                            key={c.id}
                            onClick={clickable ? () => onNavigate!(c.id) : undefined}
                            className={rowClass(clickable)}
                            title={(c.data.asset_key as string) || c.id}
                          >
                            {(c.data.asset_key as string) || c.id}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500 italic">Nothing downstream -- this is a leaf.</p>
                  )}
                </div>
              </div>
            </Section>
          );
        })()}

        {/* Columns */}
        <Section
          title={`Columns${columnNames.length ? ` (${columnNames.length})` : ''}`}
          icon={<LayersIcon className="w-4 h-4 text-gray-500" />}
          headerRight={
            columnNames.length > 0 ? (
              <div className="relative">
                <FilterIcon className="w-3 h-3 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={columnSearch}
                  onChange={(e) => setColumnSearch(e.target.value)}
                  placeholder="Filter columns..."
                  className="pl-6 pr-2 py-1 text-xs border border-gray-200 rounded w-48 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            ) : null
          }
        >
          {columnNames.length === 0 ? (
            <p className="text-sm text-gray-500 italic">
              No column schema attached to this asset yet.
              {!isCloud && ' Run `dbt docs generate` to populate schema for dbt-backed assets.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Column name</th>
                  <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Type</th>
                  <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Description</th>
                </tr>
              </thead>
              <tbody>
                {filteredColumnNames.map((name) => {
                  const col = columns[name] || {};
                  return (
                    <tr key={name} className="border-t border-gray-100 hover:bg-gray-50/50">
                      <td className="px-3 py-2 font-mono text-xs text-gray-900">{name}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {col.data_type ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-100 text-indigo-700 font-mono text-[10px]">
                            {col.data_type}
                          </span>
                        ) : (
                          <span className="text-gray-400 italic">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {col.description || <span className="text-gray-400 italic">—</span>}
                      </td>
                    </tr>
                  );
                })}
                {filteredColumnNames.length === 0 && (
                  <tr><td colSpan={3} className="px-3 py-4 text-center text-xs text-gray-500 italic">No columns match filter.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </Section>

        {/* Checks summary + Auto Coverage button */}
        <Section
          title={`Checks (${checks.length})`}
          icon={<CheckCircle2 className="w-4 h-4 text-gray-500" />}
          headerRight={
            !isCloud ? (
              <button
                onClick={() => setCoverageOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100"
                title="Analyze this asset and propose a monitoring baseline (freshness / row count / uniqueness / null checks)."
              >
                <Zap className="w-3 h-3" />
                Auto coverage
              </button>
            ) : null
          }
        >
          {checks.length === 0 ? (
            <p className="text-sm text-gray-500 italic">
              No checks on this asset yet.
              {!isCloud && ' Click "Auto coverage" to get a suggested baseline.'}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {checks.map((c, i) => {
                const s = (c.last_status || '').toLowerCase();
                const ok = s === 'pass' || s === 'success' || s === 'succeeded';
                const bad = s === 'fail' || s === 'error' || s === 'failed';
                return (
                  <li key={c.key || c.name || i} className="py-2 px-1 flex items-start gap-2">
                    {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5" />
                      : bad ? <AlertTriangle className="w-4 h-4 text-rose-500 mt-0.5" />
                      : <span className="w-4 h-4 mt-0.5 inline-block rounded-full border border-gray-300" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{c.name || 'check'}</div>
                      {c.description && (
                        <div className="text-xs text-gray-500 mt-0.5">{c.description}</div>
                      )}
                    </div>
                    <div className="text-[10px] text-gray-500 tabular-nums flex-shrink-0">
                      {c.last_status ? c.last_status.toLowerCase() : 'never run'}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
        {coverageOpen && (
          <AutoCoverageModal
            assetKey={(data.asset_key as string) || node.id}
            onClose={() => setCoverageOpen(false)}
          />
        )}
      </div>

      {/* ------- RIGHT COLUMN ------- */}
      <div className="lg:col-span-1 space-y-6">
        <DefinitionSection node={node} isCloud={isCloud} />

        <AutomationSection
          node={node}
          isCloud={isCloud}
          jobs={jobs}
          schedules={schedules}
          sensors={sensors}
          onNewPrimitiveForAsset={onNewPrimitiveForAsset}
        />

        <Section title="Freshness policy" icon={<Timer className="w-4 h-4 text-gray-500" />} compact>
          {!freshnessPolicy ? (
            <p className="text-xs text-gray-500 italic">No freshness policy set on this asset.</p>
          ) : (
            <dl className="space-y-2 text-xs">
              {freshnessStatus && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Status</dt>
                  <dd className={`font-medium ${
                    freshnessStatus === 'HEALTHY' ? 'text-emerald-600'
                      : freshnessStatus === 'DEGRADED' ? 'text-rose-600'
                      : freshnessStatus === 'WARNING' ? 'text-amber-600'
                      : 'text-gray-600'
                  }`}>
                    {freshnessStatus}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between">
                <dt className="text-gray-500">Type</dt>
                <dd className="text-gray-800">{freshnessPolicy.type === 'time_window' ? 'Time window' : 'Cron deadline'}</dd>
              </div>
              {freshnessPolicy.fail_window_seconds != null && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Fails after</dt>
                  <dd className="text-gray-800">{formatFreshnessDuration(freshnessPolicy.fail_window_seconds)} stale</dd>
                </div>
              )}
              {freshnessPolicy.warn_window_seconds != null && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Warns after</dt>
                  <dd className="text-gray-800">{formatFreshnessDuration(freshnessPolicy.warn_window_seconds)} stale</dd>
                </div>
              )}
              {freshnessPolicy.deadline_cron && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Deadline cron</dt>
                  <dd className="text-gray-800 font-mono">{freshnessPolicy.deadline_cron}</dd>
                </div>
              )}
              {freshnessPolicy.timezone && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Timezone</dt>
                  <dd className="text-gray-800">{freshnessPolicy.timezone}</dd>
                </div>
              )}
              {freshnessLastMaterialized != null && (
                <div className="flex items-center justify-between">
                  <dt className="text-gray-500">Last materialized</dt>
                  <dd className="text-gray-800">{new Date(Number(freshnessLastMaterialized) * 1000).toLocaleString()}</dd>
                </div>
              )}
            </dl>
          )}
        </Section>

        {/* Ingestions tab tagging -- the automatic heuristic (component
            type / computeKind / description / "no upstream" sniffing)
            has no way to notice e.g. a plain Python asset that calls a
            REST API and writes to Snowflake. This override always
            surfaces the asset on the Ingestions tab regardless. */}
        <Section title="Ingestion source" icon={<Download className="w-4 h-4 text-gray-500" />} compact>
          <p className="text-xs text-gray-500 mb-2">
            {isTaggedIngestion
              ? 'Manually tagged -- shows up on the Ingestions tab even if the automatic detection misses it.'
              : "Not detected as an ingestion source. If this asset pulls data in from an external system, tag it so it shows up on the Ingestions tab."}
          </p>
          <button
            onClick={handleToggleIngestionTag}
            disabled={taggingIngestion}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border disabled:opacity-50 ${
              isTaggedIngestion
                ? 'text-gray-700 border-gray-200 hover:bg-gray-50'
                : 'text-blue-700 border-blue-200 bg-blue-50 hover:bg-blue-100'
            }`}
          >
            {taggingIngestion ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TagIcon className="w-3.5 h-3.5" />}
            {isTaggedIngestion ? 'Remove from Ingestions' : 'Mark as ingestion source'}
          </button>
        </Section>

        {/* Open in Dagster+ (cloud only) */}
        {isCloud && (
          <a
            href={buildDagsterPlusUrl(data.asset_key as string)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100"
          >
            <ExternalLink className="w-4 h-4" />
            Open in Dagster+
          </a>
        )}
      </div>
    </div>
  );

  function buildDagsterPlusUrl(assetKey: string): string {
    return buildDagsterPlusAssetUrl(currentProject, assetKey);
  }
}

// ---------- Change history tab ----------
//
// Deploy-over-deploy diffs for this asset's definition (code version,
// dependencies, tags, metadata, partitions def) -- Dagster+ only, and
// plan-gated on Dagster+'s own side, so some orgs simply don't have
// this data. Local has no equivalent (no distinct "deploy" step to
// diff against), so this tab is Dagster+-only.

const CHANGE_TYPE_LABEL: Record<string, string> = {
  NEW: 'New asset',
  CODE_VERSION: 'Code version',
  DEPENDENCIES: 'Dependencies',
  PARTITIONS_DEFINITION: 'Partitions definition',
  TAGS: 'Tags',
  METADATA: 'Metadata',
  REMOVED: 'Removed',
};

function ChangeHistoryTab({ node, isCloud, projectId }: { node: GraphNode; isCloud: boolean; projectId: string }) {
  const data = node.data as any;
  const assetKey = (data.asset_key as string) || node.id;

  const { data: history, isLoading } = useQuery({
    queryKey: ['asset-change-history', projectId, assetKey],
    queryFn: () => assetsApi.getChangeHistory(projectId, assetKey, 50),
    enabled: isCloud,
    staleTime: 60_000,
    retry: false,
  });

  if (!isCloud) {
    return (
      <div className="p-12 text-center text-gray-500">
        <Clock className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">Change history is a Dagster+ feature.</p>
        <p className="text-xs mt-2 text-gray-400 max-w-md mx-auto">
          It's a deploy-over-deploy diff of this asset's definition, tied to Dagster+'s code-location
          deploy history -- local projects don't have a distinct "deploy" step to diff against.
        </p>
      </div>
    );
  }
  if (isLoading) {
    return <div className="p-12 text-center text-gray-500"><Loader2 className="w-5 h-5 mx-auto animate-spin" /></div>;
  }
  if (!history?.available || history.entries.length === 0) {
    return (
      <div className="p-12 text-center text-gray-500">
        <Clock className="w-8 h-8 mx-auto mb-2 text-gray-300" />
        <p className="text-sm">No change history recorded for this asset.</p>
        <p className="text-xs mt-2 text-gray-400 max-w-md mx-auto">
          {history?.available === false
            ? "This org either hasn't redeployed this asset's code location yet, or doesn't have change history enabled."
            : 'Nothing recorded yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[800px] mx-auto space-y-3">
      {history.entries.map((entry, i) => (
        <ChangeHistoryEntryRow key={i} entry={entry} />
      ))}
    </div>
  );
}

function ChangeHistoryEntryRow({ entry }: { entry: AssetChangeEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!(
    entry.code_version_old || entry.code_version_new
    || entry.partitions_definition_old || entry.partitions_definition_new
    || entry.dependencies_added.length || entry.dependencies_changed.length || entry.dependencies_removed.length
    || entry.tags_added.length || entry.tags_changed.length || entry.tags_removed.length
    || entry.metadata_added.length || entry.metadata_changed.length || entry.metadata_removed.length
  );
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`w-full flex items-start gap-3 p-3 text-left ${hasDetail ? 'hover:bg-gray-50/50 cursor-pointer' : 'cursor-default'}`}
      >
        <Clock className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 tabular-nums">{new Date(entry.timestamp * 1000).toLocaleString()}</span>
            <span className="text-xs font-mono text-gray-400">· {entry.code_location}</span>
            {entry.git_commit_hash && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-50 border border-gray-200 rounded text-gray-600">
                {entry.git_commit_hash.slice(0, 7)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            {entry.change_types.map((t) => (
              <span key={t} className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                {CHANGE_TYPE_LABEL[t] || t}
              </span>
            ))}
          </div>
        </div>
        {hasDetail && (
          <ChevronDown className={`w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        )}
      </button>
      {expanded && hasDetail && (
        <div className="border-t border-gray-100 px-3 py-2.5 bg-gray-50/50 space-y-2 text-xs">
          {(entry.code_version_old || entry.code_version_new) && (
            <ChangeHistoryDiffRow label="Code version" oldValue={entry.code_version_old} newValue={entry.code_version_new} />
          )}
          {(entry.partitions_definition_old || entry.partitions_definition_new) && (
            <ChangeHistoryDiffRow label="Partitions definition" oldValue={entry.partitions_definition_old} newValue={entry.partitions_definition_new} />
          )}
          <ChangeHistoryKeysRow label="Dependencies" added={entry.dependencies_added} changed={entry.dependencies_changed} removed={entry.dependencies_removed} />
          <ChangeHistoryKeysRow label="Tags" added={entry.tags_added} changed={entry.tags_changed} removed={entry.tags_removed} />
          <ChangeHistoryKeysRow label="Metadata" added={entry.metadata_added} changed={entry.metadata_changed} removed={entry.metadata_removed} />
        </div>
      )}
    </div>
  );
}

function ChangeHistoryDiffRow({ label, oldValue, newValue }: { label: string; oldValue: string | null; newValue: string | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-0.5">{label}</div>
      <div className="flex items-center gap-2 font-mono">
        {oldValue && <span className="text-rose-600 line-through">{oldValue}</span>}
        {oldValue && newValue && <span className="text-gray-400">→</span>}
        {newValue && <span className="text-emerald-700">{newValue}</span>}
      </div>
    </div>
  );
}

function ChangeHistoryKeysRow({ label, added, changed, removed }: { label: string; added: string[]; changed: string[]; removed: string[] }) {
  if (added.length === 0 && changed.length === 0 && removed.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-0.5">{label}</div>
      <div className="flex flex-wrap gap-1">
        {added.map((k) => <span key={`a-${k}`} className="font-mono px-1.5 py-0.5 text-[10px] rounded bg-emerald-50 text-emerald-700 border border-emerald-200">+ {k}</span>)}
        {changed.map((k) => <span key={`c-${k}`} className="font-mono px-1.5 py-0.5 text-[10px] rounded bg-amber-50 text-amber-700 border border-amber-200">~ {k}</span>)}
        {removed.map((k) => <span key={`r-${k}`} className="font-mono px-1.5 py-0.5 text-[10px] rounded bg-rose-50 text-rose-700 border border-rose-200">− {k}</span>)}
      </div>
    </div>
  );
}

// ---------- Definition section (editable) ----------

/**
 * Definition card with an Edit mode. Reads from the graph node and,
 * when the user hits Save, writes back through the source component's
 * `translation` field (which every component supports via its YAML
 * codegen). Two save paths:
 *
 *   • dbt-backed asset -- mirrors the existing PropertyPanel
 *     customization flow: find-or-create a `DbtProjectComponent`
 *     with `select=<model>` + the new translation, and exclude the
 *     model from the original component. Per-asset translation.
 *
 *   • other community components -- patch the source component's
 *     `translation` field. Applies to every asset the component
 *     produces unless the component supports a `by_key` sub-key
 *     (which most do; we shim it in when the source is not dbt).
 *
 * Local + non-cloud only. Cloud shows read-only.
 */
function DefinitionSection({ node, isCloud }: { node: GraphNode; isCloud: boolean }) {
  const { currentProject, loadProject } = useProjectStore();
  const data = node.data as any;
  const kinds: string[] = Array.isArray(data.kinds) ? data.kinds : [];
  const owners: string[] = Array.isArray(data.owners) ? data.owners : [];
  const tags: string[] = Array.isArray(data.tags) ? data.tags : [];

  const sourceComponentId: string | undefined = (node as any).source_component || data.source_component;
  const sourceComponent: ComponentInstance | undefined = useMemo(() => {
    if (!currentProject || !sourceComponentId) return undefined;
    const bare = sourceComponentId.startsWith('community_')
      ? sourceComponentId.replace('community_', '')
      : sourceComponentId;
    return (currentProject.components || []).find((c) => c.id === bare || c.id === sourceComponentId);
  }, [currentProject, sourceComponentId]);

  const editable = !isCloud && !!sourceComponent;
  const isDbt = isDbtComponentType(sourceComponent?.component_type);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    description: (data.description as string) || '',
    group_name: (data.group_name as string) || '',
    owners: [...owners],
    tags: [...tags],
    kinds: [...kinds],
  });

  const openEdit = () => {
    setDraft({
      description: (data.description as string) || '',
      group_name: (data.group_name as string) || '',
      owners: [...owners],
      tags: [...tags],
      kinds: [...kinds],
    });
    setEditing(true);
  };

  const save = async () => {
    if (!currentProject || !sourceComponent) return;
    setSaving(true);
    try {
      const assetKey = (data.asset_key as string) || node.id;
      const modelName = assetKey.split('/').pop() || assetKey;

      // Build the translation payload. Dagster's translator concept
      // treats `dagster/kind/*` tags as kinds, but our codegen writes
      // both fields separately so downstream `AssetSpec` construction
      // can attach kinds directly on the asset. Redundant is safer than
      // hoping one of the two paths works.
      const tagsDict: Record<string, string> = {};
      for (const t of draft.tags) {
        const [k, ...rest] = t.split('=');
        tagsDict[k] = rest.join('=') || '';
      }
      const translation: Record<string, any> = {
        ...(sourceComponent.translation || {}),
        group_name: draft.group_name || undefined,
        description: draft.description || undefined,
        owners: draft.owners.length ? draft.owners : undefined,
        tags: Object.keys(tagsDict).length ? tagsDict : undefined,
        kinds: draft.kinds.length ? draft.kinds : undefined,
      };
      // Drop empty keys so we don't emit `null` into the YAML.
      Object.keys(translation).forEach((k) => { if (translation[k] === undefined) delete translation[k]; });

      let updatedComponents: ComponentInstance[];

      if (isDbt) {
        // dbt customization: find-or-create a per-model component so
        // the translation only affects this one asset.
        const existing = currentProject.components.find(
          (c) => isDbtComponentType(c.component_type) && c.attributes?.select === modelName,
        );
        if (existing) {
          updatedComponents = currentProject.components.map((c) =>
            c.id === existing.id ? { ...c, translation } : c
          );
        } else {
          const custom: ComponentInstance = {
            id: `dbt-custom-${Date.now()}`,
            component_type: sourceComponent.component_type,
            label: `dbt: ${modelName} (customized)`,
            attributes: {
              project_path: sourceComponent.attributes?.project_path || sourceComponent.attributes?.project,
              select: modelName,
            },
            translation,
            is_asset_factory: true,
          };
          const originalExclude = sourceComponent.attributes?.exclude || '';
          const excludeList: string[] = originalExclude ? originalExclude.split(',').map((s: string) => s.trim()) : [];
          if (!excludeList.includes(modelName)) excludeList.push(modelName);
          updatedComponents = currentProject.components.map((c) =>
            c.id === sourceComponent.id
              ? { ...c, attributes: { ...c.attributes, exclude: excludeList.join(', ') } }
              : c
          );
          updatedComponents.push(custom);
        }
      } else {
        // Community component: patch translation via `by_key` so the
        // change only affects this specific asset key. Components that
        // don't understand by_key still see the other translation
        // fields at the top level as a fallback.
        const prevByKey = (sourceComponent.translation as any)?.by_key || {};
        const byKey = { ...prevByKey, [assetKey]: {
          group_name: draft.group_name || undefined,
          description: draft.description || undefined,
          owners: draft.owners.length ? draft.owners : undefined,
          tags: Object.keys(tagsDict).length ? tagsDict : undefined,
          kinds: draft.kinds.length ? draft.kinds : undefined,
        } };
        Object.keys(byKey[assetKey]).forEach((k) => { if (byKey[assetKey][k] === undefined) delete byKey[assetKey][k]; });
        const newTranslation = { ...(sourceComponent.translation || {}), by_key: byKey };
        updatedComponents = currentProject.components.map((c) =>
          c.id === sourceComponent.id ? { ...c, translation: newTranslation } : c
        );
      }

      await projectsApi.updateProject(currentProject.id, { components: updatedComponents } as any);
      await projectsApi.regenerateAssets(currentProject.id);
      await loadProject(currentProject.id);
      notify.success('Asset metadata saved.');
      setEditing(false);
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Failed to save metadata.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-block w-4 h-4 rounded-full bg-blue-100 border-2 border-blue-300" />
          <h3 className="text-xs font-semibold text-gray-900">Definition</h3>
        </div>
        {!editing && (
          <button
            onClick={openEdit}
            disabled={!editable}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-50 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              isCloud ? 'Not available on Dagster+ (read-only)'
                : !sourceComponent ? 'No source component -- nothing to edit here'
                : 'Edit description, group, tags, kinds, owners'
            }
          >
            <Pencil className="w-3 h-3" />
            Edit
          </button>
        )}
        {editing && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-gray-700 hover:bg-gray-100 rounded"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Save
            </button>
          </div>
        )}
      </div>
      <div className="p-3 space-y-2">
        {!editing ? (
          <>
            <DefRow label="Group" value={
              (data.group_name as string) ? <Pill tone="blue" icon={Database}>{data.group_name as string}</Pill> : '—'
            } />
            <DefRow label="Kinds" value={kinds.length ? <PillList items={kinds} tone="indigo" mono /> : '—'} />
            {isCloud && (
              <DefRow label="Deployment" value={
                <Pill tone="gray" mono>{(currentProjectHintFrom(currentProject) as string) || 'Dagster+'}</Pill>
              } />
            )}
            <DefRow label="Owners" value={owners.length ? <PillList items={owners} tone="purple" icon={UsersIcon} /> : '—'} />
            <DefRow label="Tags" value={tags.length ? <PillList items={tags} tone="gray" icon={TagIcon} mono /> : '—'} />
            <DefRow label="Type" value={
              data.is_connection ? <Pill tone="amber">connection</Pill>
                : data.is_external ? <Pill tone="gray">external</Pill>
                : data.is_observable ? <Pill tone="blue">observable</Pill>
                : data.is_materializable ? <Pill tone="emerald">materializable</Pill>
                : '—'
            } />
            {isCloud && data.connection_source && (
              <DefRow label="Source" value={<Pill tone="amber">{data.connection_source as string}</Pill>} />
            )}
            {sourceComponentId && !isCloud && (
              <DefRow label="Source code" value={
                <span className="text-[11px] font-mono text-gray-600 truncate">{sourceComponentId}</span>
              } />
            )}
          </>
        ) : (
          <>
            <EditField
              label="Description"
              hint={isDbt
                ? 'For dbt models, Dagster auto-embeds the model SQL as the description. Setting a value here overrides that.'
                : undefined}
            >
              <textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                rows={3}
                className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Describe this asset..."
              />
            </EditField>
            <EditField label="Group">
              <input
                value={draft.group_name}
                onChange={(e) => setDraft({ ...draft, group_name: e.target.value })}
                className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="e.g. analytics, marts"
              />
            </EditField>
            <EditField label="Kinds" hint="Rendered as kind badges (dbt, python, snowflake, etc.)">
              <ChipEditor
                items={draft.kinds}
                setItems={(items) => setDraft({ ...draft, kinds: items })}
                placeholder="Add a kind (e.g. dbt) and press Enter"
                tone="indigo"
                mono
              />
            </EditField>
            <EditField label="Tags" hint="Free-form tags. Use `key=value` or just `key`.">
              <ChipEditor
                items={draft.tags}
                setItems={(items) => setDraft({ ...draft, tags: items })}
                placeholder="Add a tag and press Enter"
                tone="gray"
                icon={TagIcon}
                mono
              />
            </EditField>
            <EditField label="Owners" hint="Emails or team names.">
              <ChipEditor
                items={draft.owners}
                setItems={(items) => setDraft({ ...draft, owners: items })}
                placeholder="Add an owner and press Enter"
                tone="purple"
                icon={UsersIcon}
              />
            </EditField>
            <div className="text-[10px] text-gray-500 pt-1 border-t border-gray-100">
              Saves as {isDbt ? 'a per-model dbt customization' : "a per-asset `translation.by_key` entry"} on
              <span className="font-mono ml-1">{sourceComponent?.component_type}</span>.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Automation card with attach + create controls. Users can:
 *   - Attach this asset to an existing schedule / job (via the
 *     primitives/attach-asset endpoint)
 *   - Create a new schedule / sensor / job / asset check / freshness
 *     policy targeting this asset (routes to the template builder via
 *     onNewPrimitiveForAsset)
 * All write actions hidden on Dagster+ (read-only).
 */
function AutomationSection({ node, isCloud, jobs, schedules, sensors, onNewPrimitiveForAsset }: {
  node: GraphNode;
  isCloud: boolean;
  jobs: any[];
  schedules: any[];
  sensors: any[];
  onNewPrimitiveForAsset?: (category: 'schedule' | 'job' | 'sensor' | 'asset_check' | 'freshness_policy', assetKey: string) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const data = node.data as any;
  const assetKey = (data.asset_key as string) || node.id;
  const [attaching, setAttaching] = useState<null | { category: 'schedule' | 'job'; open: boolean }>(null);
  const [available, setAvailable] = useState<{ schedules: any[]; jobs: any[]; sensors: any[] } | null>(null);

  const openAttachMenu = async (category: 'schedule' | 'job') => {
    if (!currentProject) return;
    setAttaching({ category, open: true });
    if (available) return;
    try {
      const r = await import('@/services/api').then(m => m.primitivesApi.listAll(currentProject.id));
      setAvailable({
        schedules: (r.primitives as any).schedules || [],
        jobs: (r.primitives as any).jobs || [],
        sensors: (r.primitives as any).sensors || [],
      });
    } catch (e: any) {
      notify.error(e?.message || 'Failed to load primitives.');
      setAttaching(null);
    }
  };

  const attach = async (category: 'schedule' | 'job', primitiveName: string) => {
    if (!currentProject) return;
    try {
      const res = await fetch(
        `/api/v1/primitives/attach-asset/${currentProject.id}/${category}/${encodeURIComponent(primitiveName)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ asset_key: assetKey }),
        },
      );
      const dataResp = await res.json();
      if (!res.ok) {
        notify.error(dataResp.detail || `Failed to attach to ${category}`);
        return;
      }
      if (dataResp.updated) notify.success(`Added "${assetKey}" to ${category} "${primitiveName}".`);
      else notify.info(dataResp.message || `Already in ${category}.`);
      await loadProject(currentProject.id);
      setAttaching(null);
    } catch (e: any) {
      notify.error(e?.message || 'Attach failed.');
    }
  };

  const canWrite = !isCloud && !!onNewPrimitiveForAsset;

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-gray-500" />
          <h3 className="text-xs font-semibold text-gray-900">Automation</h3>
        </div>
        {canWrite && (
          <AutomationAddMenu
            onNew={(c) => onNewPrimitiveForAsset?.(c, assetKey)}
            onAttach={openAttachMenu}
          />
        )}
      </div>
      <div className="p-3 space-y-3">
        <AutomationList
          label={`Jobs (${jobs.length})`}
          empty="Not in any job."
          onAttach={canWrite ? () => openAttachMenu('job') : undefined}
          onNew={canWrite ? () => onNewPrimitiveForAsset?.('job', assetKey) : undefined}
          items={jobs.map((j: any) => ({
            key: j.name || String(j),
            primary: typeof j === 'string' ? j : (j.name || 'unnamed'),
            meta: null,
          }))}
        />
        <AutomationList
          label={`Schedules (${schedules.length})`}
          empty="No schedules target this asset."
          onAttach={canWrite ? () => openAttachMenu('schedule') : undefined}
          onNew={canWrite ? () => onNewPrimitiveForAsset?.('schedule', assetKey) : undefined}
          items={schedules.map((s: any) => ({
            key: s.name || String(s),
            primary: s.name || 'unnamed',
            meta: s.cron ? <span className="font-mono text-[10px] text-gray-500">{s.cron}</span> : null,
          }))}
        />
        <AutomationList
          label={`Sensors (${sensors.length})`}
          empty="No sensors target this asset."
          // Sensors don't have an attach-existing endpoint (a sensor's
          // asset targeting is defined in code, not YAML). "New" only.
          onNew={canWrite ? () => onNewPrimitiveForAsset?.('sensor', assetKey) : undefined}
          items={sensors.map((s: any) => ({
            key: s.name || String(s),
            primary: s.name || 'unnamed',
            meta: s.sensor_type ? <span className="text-[10px] text-gray-500">{s.sensor_type}</span> : null,
          }))}
        />
      </div>

      {/* Attach menu -- lists existing schedules / jobs the user can
          pick to add this asset to. Rendered inside the card border
          with a bright header so it's obvious this is a picker, not a
          pre-selection. */}
      {attaching?.open && available && (() => {
        const items = attaching.category === 'schedule' ? available.schedules : available.jobs;
        const count = (items || []).length;
        return (
          <div className="border-t-2 border-blue-300 bg-blue-50/50 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-semibold text-blue-900">
                Attach to existing {attaching.category}
                <span className="ml-1.5 text-[10px] font-normal text-blue-700">
                  ({count} available)
                </span>
              </div>
              <button
                onClick={() => setAttaching(null)}
                className="text-[10px] text-blue-700 hover:text-blue-900 font-medium"
              >
                Cancel
              </button>
            </div>
            {count === 0 ? (
              <p className="text-xs text-gray-600 italic">
                No {attaching.category}s exist in this project yet. Create one via <span className="font-medium">+ New</span> on the {attaching.category === 'schedule' ? 'Schedules' : 'Jobs'} row above.
              </p>
            ) : (
              <>
                <div className="text-[10px] text-blue-800/80 mb-1.5">Pick one to add this asset to:</div>
                <div className="space-y-1 max-h-52 overflow-y-auto">
                  {items.map((p: any) => (
                    <button
                      key={p.name}
                      onClick={() => attach(attaching.category, p.name)}
                      className="w-full flex items-center justify-between gap-2 text-left px-2 py-1.5 text-xs bg-white border border-blue-200 rounded hover:bg-white hover:border-blue-500 hover:shadow-sm transition"
                    >
                      <span className="font-mono text-gray-800 truncate">{p.name}</span>
                      {p.cron && <span className="font-mono text-[10px] text-gray-500 flex-shrink-0">{p.cron}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function AutomationList({ label, empty, items, onAttach, onNew }: {
  label: string;
  empty: string;
  items: { key: string; primary: string; meta: React.ReactNode }[];
  onAttach?: () => void;
  onNew?: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{label}</div>
        {(onAttach || onNew) && (
          <div className="flex items-center gap-1">
            {onAttach && (
              <button
                onClick={onAttach}
                className="text-[10px] text-blue-700 hover:text-blue-900 font-medium"
                title="Add this asset to an existing one"
              >
                Attach
              </button>
            )}
            {onNew && (
              <button
                onClick={onNew}
                className="text-[10px] text-blue-700 hover:text-blue-900 font-medium"
                title="Create a new one targeting this asset"
              >
                + New
              </button>
            )}
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] text-gray-500 italic">{empty}</p>
      ) : (
        <div className="space-y-0.5">
          {items.map((it) => (
            <div key={it.key} className="flex items-center gap-2 text-[11px]">
              <span className="font-mono text-gray-700">{it.primary}</span>
              {it.meta}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AutomationAddMenu({ onNew, onAttach }: {
  onNew: (c: 'schedule' | 'sensor' | 'job' | 'asset_check' | 'freshness_policy') => void;
  onAttach: (c: 'schedule' | 'job') => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-50 rounded"
      >
        <span className="text-sm leading-none">+</span> Add automation
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-52 bg-white border border-gray-200 rounded shadow-lg z-20 text-xs">
            <div className="px-3 py-1.5 text-[9px] uppercase tracking-wider text-gray-500 font-medium border-b border-gray-100">Create new</div>
            {(['schedule', 'sensor', 'job', 'asset_check', 'freshness_policy'] as const).map((c) => (
              <button
                key={c}
                onClick={() => { onNew(c); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-gray-50 capitalize"
              >
                New {c.replace('_', ' ')}
              </button>
            ))}
            <div className="px-3 py-1.5 text-[9px] uppercase tracking-wider text-gray-500 font-medium border-t border-b border-gray-100">Attach existing</div>
            {(['schedule', 'job'] as const).map((c) => (
              <button
                key={c}
                onClick={() => { onAttach(c); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 hover:bg-gray-50 capitalize"
              >
                Attach to {c}...
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Auto Coverage modal -- fetches heuristic suggestions from the
 * backend, lets the user toggle which ones to apply, then batch-adds
 * them as EnhancedAssetCheck instances via /coverage-apply. High-
 * confidence suggestions (freshness, row-count anomaly, id uniqueness)
 * are pre-checked; per-column null_ratio suggestions require explicit
 * opt-in so we don't over-alert on nullable-by-design columns.
 */
export function AutoCoverageModal({ assetKey, onClose }: { assetKey: string; onClose: () => void }) {
  const { currentProject, loadProject } = useProjectStore();
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    assetsApi.coverageSuggest(currentProject.id, assetKey).then((r) => {
      if (cancelled) return;
      setSuggestions(r.suggestions || []);
      // Pre-select high-confidence suggestions.
      const hi = new Set<string>();
      for (const s of r.suggestions || []) {
        if (s.confidence === 'high') hi.add(s.name);
      }
      setSelected(hi);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(e?.response?.data?.detail || e?.message || 'Failed to load suggestions.');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [currentProject?.id, assetKey]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };
  const toggleAll = (want: boolean) => {
    setSelected(want ? new Set(suggestions.map((s: any) => s.name)) : new Set());
  };

  const apply = async () => {
    if (!currentProject || selected.size === 0) return;
    setApplying(true);
    try {
      const picked = suggestions.filter((s: any) => selected.has(s.name));
      const r = await assetsApi.coverageApply(currentProject.id, assetKey, picked);
      if (r.applied > 0) {
        notify.success(`Applied ${r.applied} check${r.applied === 1 ? '' : 's'} to ${assetKey}.`);
      }
      if (r.failed && r.failed.length > 0) {
        notify.error(`${r.failed.length} check${r.failed.length === 1 ? '' : 's'} failed to apply: ${r.failed.map((f: any) => f.name).join(', ')}`);
      }
      await loadProject(currentProject.id);
      onClose();
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Apply failed.');
    } finally {
      setApplying(false);
    }
  };

  const groups: Record<string, any[]> = {};
  for (const s of suggestions) {
    (groups[s.check_kind] ||= []).push(s);
  }
  const KIND_LABEL: Record<string, string> = {
    freshness: 'Freshness',
    row_count: 'Row-count anomaly',
    uniqueness: 'Uniqueness (id columns)',
    null_ratio: 'Null-ratio (per column)',
  };
  const KIND_ORDER = ['freshness', 'row_count', 'uniqueness', 'null_ratio'];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Zap className="w-4 h-4 text-blue-600" />
              Auto coverage
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Suggested monitoring baseline for <span className="font-mono">{assetKey}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="text-center py-8 text-gray-500">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
              <p className="text-sm">Analyzing this asset…</p>
            </div>
          )}
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">
              {error}
            </div>
          )}
          {!loading && !error && suggestions.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              <p className="text-sm">No suggestions -- this asset already looks well-covered!</p>
            </div>
          )}
          {!loading && !error && suggestions.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-3 text-xs">
                <span className="text-gray-600">
                  {selected.size} of {suggestions.length} selected
                </span>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleAll(true)} className="text-blue-700 hover:text-blue-900 font-medium">Select all</button>
                  <span className="text-gray-300">|</span>
                  <button onClick={() => toggleAll(false)} className="text-blue-700 hover:text-blue-900 font-medium">Select none</button>
                </div>
              </div>
              {KIND_ORDER.filter((k) => groups[k]?.length).map((kind) => (
                <div key={kind} className="mb-5">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-2">
                    {KIND_LABEL[kind] || kind} ({groups[kind].length})
                  </div>
                  <div className="space-y-1.5">
                    {groups[kind].map((s: any) => (
                      <label
                        key={s.name}
                        className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition ${
                          selected.has(s.name)
                            ? 'bg-blue-50/60 border-blue-300'
                            : 'bg-white border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(s.name)}
                          onChange={() => toggle(s.name)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-900">{s.description}</span>
                            {s.confidence === 'high' && (
                              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">
                                recommended
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">{s.rationale}</div>
                          <div className="text-[10px] font-mono text-gray-400 mt-1">
                            {s.name}
                            {s.target_column && ` · column: ${s.target_column}`}
                            {s.max_age_seconds && ` · max_age: ${Math.round(s.max_age_seconds / 3600)}h`}
                            {s.max_null_ratio !== null && s.max_null_ratio !== undefined && ` · max_null_ratio: ${s.max_null_ratio}`}
                            {s.row_count_z_score && ` · z_score: ${s.row_count_z_score}`}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between">
          <p className="text-[11px] text-gray-500">
            Each selected suggestion becomes an EnhancedAssetCheck under <span className="font-mono">defs/monitors/</span>.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button
              onClick={apply}
              disabled={applying || loading || selected.size === 0}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {applying ? 'Applying…' : (selected.size === 1 ? 'Apply check' : `Apply ${selected.size} checks`)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function currentProjectHintFrom(cp: any): string | null {
  if (!cp?.is_dagster_plus) return null;
  return `${cp.dagster_plus_org}${cp.dagster_plus_deployment ? '/' + cp.dagster_plus_deployment : ''}`;
}

function EditField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-[10px] uppercase tracking-wider text-gray-500 font-medium">{label}</label>
      {children}
      {hint && <div className="text-[10px] text-gray-400 italic">{hint}</div>}
    </div>
  );
}

function ChipEditor({ items, setItems, placeholder, tone, icon, mono }: {
  items: string[];
  setItems: (next: string[]) => void;
  placeholder: string;
  tone: PillTone;
  icon?: React.ComponentType<{ className?: string }>;
  mono?: boolean;
}) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (!v) return;
    if (items.includes(v)) { setInput(''); return; }
    setItems([...items, v]);
    setInput('');
  };
  const remove = (v: string) => setItems(items.filter((x) => x !== v));
  return (
    <div className="space-y-1">
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((it) => (
            <span
              key={it}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${mono ? 'font-mono' : 'font-medium'} ${PILL_TONE[tone]}`}
            >
              {icon && React.createElement(icon, { className: 'w-3 h-3 flex-shrink-0' })}
              <span>{it}</span>
              <button
                onClick={() => remove(it)}
                className="ml-0.5 opacity-60 hover:opacity-100"
                title="Remove"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={placeholder}
        className="w-full text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

// ---------- Small helper components ----------

function Section({ title, icon, headerRight, compact, children }: {
  title: string;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className={`flex items-center justify-between gap-2 border-b border-gray-100 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
        <div className="flex items-center gap-2">
          {icon}
          <h3 className={`font-semibold text-gray-900 ${compact ? 'text-xs' : 'text-sm'}`}>{title}</h3>
        </div>
        {headerRight}
      </div>
      <div className={compact ? 'p-3 space-y-2' : 'p-4'}>
        {children}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string | number; tone?: 'success' | 'error' | 'neutral' | 'warning' }) {
  const toneStyle = tone === 'success' ? 'text-emerald-700'
    : tone === 'error' ? 'text-rose-700'
    : tone === 'warning' ? 'text-amber-700'
    : 'text-gray-900';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{label}</div>
      <div className={`text-sm font-semibold mt-1 ${toneStyle}`}>{value}</div>
    </div>
  );
}

function DefRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium flex-shrink-0 pt-0.5 w-24">{label}</div>
      <div className="flex-1 min-w-0 text-right text-sm text-gray-800">{value}</div>
    </div>
  );
}

// Consistent pill styling across the definition section. Same height,
// same font size, same padding -- only the tone (background/border
// color) and optional leading icon differ. Kinds, group, tags, and
// owners now all render as Pills so they line up visually.
type PillTone = 'blue' | 'indigo' | 'purple' | 'gray' | 'amber' | 'emerald';
const PILL_TONE: Record<PillTone, string> = {
  blue:    'bg-blue-50 border-blue-200 text-blue-700',
  indigo:  'bg-indigo-50 border-indigo-200 text-indigo-700',
  purple:  'bg-purple-50 border-purple-200 text-purple-700',
  gray:    'bg-gray-100 border-gray-200 text-gray-700',
  amber:   'bg-amber-50 border-amber-200 text-amber-700',
  emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
};

function Pill({ tone, icon: Icon, mono, children }: {
  tone: PillTone;
  icon?: React.ComponentType<{ className?: string }>;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${mono ? 'font-mono' : 'font-medium'} ${PILL_TONE[tone]}`}>
      {Icon && <Icon className="w-3 h-3 flex-shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

function PillList({ items, tone, icon, mono }: {
  items: string[];
  tone: PillTone;
  icon?: React.ComponentType<{ className?: string }>;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1 justify-end">
      {items.map((it) => (
        <Pill key={it} tone={tone} icon={icon} mono={mono}>{it}</Pill>
      ))}
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (isNaN(then)) return iso;
    const diff = Date.now() - then;
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function formatFreshnessDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
}
