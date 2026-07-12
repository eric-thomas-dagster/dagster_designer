import React, { useState, useMemo } from 'react';
import {
  Play, ChevronRight, Layers as LayersIcon, Database, CheckCircle2, AlertTriangle,
  Book, Filter as FilterIcon, Clock, Zap, Timer, Users as UsersIcon,
  ExternalLink, Copy, GitBranch, Tag as TagIcon, Pencil, X, Check, Loader2,
} from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, assetsApi } from '@/services/api';
import { notify } from './Notifications';
import type { GraphNode, ComponentInstance } from '@/types';

const isDbtComponentType = (t: string | undefined | null): boolean => !!t && /\bdbt[_.]|^dbt/i.test(t);

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
}

type Tab = 'overview' | 'partitions' | 'events' | 'checks' | 'lineage' | 'insights' | 'change_history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',       label: 'Overview' },
  { id: 'partitions',     label: 'Partitions' },
  { id: 'events',         label: 'Events' },
  { id: 'checks',         label: 'Checks' },
  { id: 'lineage',        label: 'Lineage' },
  { id: 'insights',       label: 'Insights' },
  { id: 'change_history', label: 'Change history' },
];

export function AssetDetailPage({ nodeId, onClose, onNewPrimitiveForAsset }: AssetDetailPageProps) {
  const { currentProject } = useProjectStore();
  const [activeTab, setActiveTab] = useState<Tab>('overview');

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
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            disabled={isCloud || !data.is_materializable}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            title={isCloud ? 'Not available on Dagster+ (read-only)' : !data.is_materializable ? 'Asset is not materializable' : 'Materialize this asset'}
          >
            <Play className="w-4 h-4" />
            Materialize
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
            title="Return to the asset graph / catalog"
          >
            <ChevronRight className="w-3.5 h-3.5 rotate-180" />
            <span>Back</span>
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
        {activeTab === 'overview' && <OverviewTab node={node} isCloud={isCloud} onNewPrimitiveForAsset={onNewPrimitiveForAsset} />}
        {activeTab !== 'overview' && (
          <div className="p-12 text-center text-gray-500">
            <div className="inline-flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4" />
              <span>The <span className="font-medium">{TABS.find((t) => t.id === activeTab)?.label}</span> tab isn't wired up yet.</span>
            </div>
            <p className="text-xs mt-2 text-gray-400">Coming soon.</p>
          </div>
        )}
      </div>
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

function OverviewTab({ node, isCloud, onNewPrimitiveForAsset }: {
  node: GraphNode;
  isCloud: boolean;
  onNewPrimitiveForAsset?: (category: 'schedule' | 'job' | 'sensor' | 'asset_check' | 'freshness_policy', assetKey: string) => void;
}) {
  const { currentProject } = useProjectStore();
  const data = node.data as any;
  const checks: any[] = Array.isArray(data.checks) ? data.checks : [];
  const columns: Record<string, any> = (data.columns as any) || {};
  const columnNames = Object.keys(columns);
  const schedules: any[] = Array.isArray(data.schedules) ? data.schedules : [];
  const sensors: any[] = Array.isArray(data.sensors) ? data.sensors : [];
  const jobs: any[] = Array.isArray(data.jobs) ? data.jobs : [];
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
  const filteredColumnNames = columnNames.filter((name) =>
    name.toLowerCase().includes(columnSearch.trim().toLowerCase())
  );

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
                      {deps.map((d) => (
                        <div key={d} className="text-[11px] font-mono text-gray-700 truncate px-2 py-1 bg-white border border-gray-200 rounded" title={d}>
                          {d}
                        </div>
                      ))}
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
                      {consumers.map((c) => (
                        <div key={c.id} className="text-[11px] font-mono text-gray-700 truncate px-2 py-1 bg-white border border-gray-200 rounded" title={(c.data.asset_key as string) || c.id}>
                          {(c.data.asset_key as string) || c.id}
                        </div>
                      ))}
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

        {/* Freshness (placeholder for now — we don't fetch this yet) */}
        <Section title="Freshness policy" icon={<Timer className="w-4 h-4 text-gray-500" />} compact>
          <p className="text-xs text-gray-500 italic">
            Freshness policy details aren't fetched yet in this pass.
          </p>
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
    const cp = currentProject as any;
    const org = (cp?.dagster_plus_org || '').replace(/^https?:\/\//, '').replace(/\.dagster\.(cloud|plus).*$/, '').split('/')[0];
    const dep = cp?.dagster_plus_deployment || '';
    const encoded = encodeURIComponent(assetKey.replace(/\//g, '/'));
    return dep
      ? `https://${org}.dagster.cloud/${dep}/assets/${encoded}`
      : `https://${org}.dagster.cloud/assets/${encoded}`;
  }
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
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {applying ? 'Applying…' : `Apply ${selected.size} check${selected.size === 1 ? '' : 's'}`}
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
