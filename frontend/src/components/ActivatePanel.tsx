import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, Plus, CheckCircle2, XCircle, Clock, AlertTriangle, Play, Loader2, TrendingUp, Activity } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { AddActivationDialog } from './AddActivationDialog';
import { extractComponentId } from '@/lib/componentId';
import { KpiCard, TrendChart, formatCompact } from './RunActivityCharts';
import type { ComponentInstance } from '@/types';

interface ActivatePanelProps {
  onAddActivationTarget: (componentType: string) => void;
  onEditComponent: (component: ComponentInstance) => void;
}

/**
 * The mirror of Ingestions: sync data OUT to a business tool instead of
 * pulling it in. Scoped to the manifest's `reverse_etl` category (added
 * once that bucket grew past a handful of `sink` + `reverse-etl`-tagged
 * components) -- membership checked via the real manifest id set, not a
 * regex heuristic, since extractComponentId() + a real category lookup
 * is available and more reliable than guessing from a name.
 *
 * Shares the same KPI band + trend chart treatment as IngestionsPanel
 * (extracted into RunActivityCharts so neither page duplicates the SVG
 * chart) -- still lighter than that page overall: no bulk actions or
 * partition backfill UI yet. Reuses the same ingestion_events.jsonl log
 * (asset-key-keyed, not ingestion-specific) for last-run status and the
 * KPIs, so this comes for free from existing infra.
 */
export function ActivatePanel({ onAddActivationTarget, onEditComponent }: ActivatePanelProps) {
  const { currentProject } = useProjectStore();
  const [addOpen, setAddOpen] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [window, setWindow] = useState<'24h' | '7d' | '30d'>('7d');

  const { data: manifest } = useQuery({
    queryKey: ['community-templates-manifest'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/templates/manifest`);
      if (!res.ok) throw new Error('Failed to load community manifest');
      return res.json() as Promise<{ components: { id: string; category: string }[] }>;
    },
    staleTime: 15 * 60 * 1000,
  });

  const reverseEtlIds = useMemo(
    () => new Set((manifest?.components ?? []).filter((c) => (c.category || '').toLowerCase() === 'reverse_etl').map((c) => c.id)),
    [manifest],
  );

  const { data: history } = useQuery({
    queryKey: ['ingestion-history-for-activate', currentProject?.id],
    queryFn: () => assetsApi.ingestionHistory(currentProject!.id, 3000),
    enabled: !!currentProject,
    staleTime: 15_000,
  });

  const activations = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.components
      .filter((c) => reverseEtlIds.has(extractComponentId(c.component_type)))
      .map((c) => {
        const assetKey = (c.attributes?.asset_name as string) || c.id;
        const events = (history?.events ?? []).filter((e) => e.asset_key === assetKey && e.type === 'materialize');
        const lastRun = events[events.length - 1];
        const configured = Object.values(c.attributes || {}).some(
          (v) => v !== null && v !== undefined && !(typeof v === 'string' && (v === '' || v.startsWith('TODO'))),
        );
        return { component: c, assetKey, lastRun, configured };
      });
  }, [currentProject, reverseEtlIds, history]);

  // KPI band + trend, mirroring IngestionsPanel's "state of your fleet"
  // treatment -- same shared event log (assetsApi.ingestionHistory is
  // keyed by asset_key, not ingestion-specific), just scoped to
  // activation targets instead of sources.
  const activationAssetKeys = useMemo(() => new Set(activations.map((a) => a.assetKey)), [activations]);
  const activationEvents = useMemo(
    () => (history?.events ?? []).filter((e) => activationAssetKeys.has(e.asset_key)),
    [history, activationAssetKeys],
  );
  const windowMs = window === '24h' ? 24 * 3600e3 : window === '7d' ? 7 * 24 * 3600e3 : 30 * 24 * 3600e3;
  const now = Date.now();
  const windowedEvents = useMemo(
    () => activationEvents.filter((e) => now - new Date(e.ts).getTime() <= windowMs),
    [activationEvents, windowMs, now],
  );
  const analytics = useMemo(() => {
    const latestPerAsset = new Map<string, (typeof activationEvents)[number]>();
    for (const e of activationEvents) {
      if (e.status !== 'success' || (e.rows ?? null) === null) continue;
      const prev = latestPerAsset.get(e.asset_key);
      if (!prev || new Date(e.ts) > new Date(prev.ts)) latestPerAsset.set(e.asset_key, e);
    }
    const totalRowsSynced = Array.from(latestPerAsset.values()).reduce((s, e) => s + (e.rows ?? 0), 0);

    const windowMats = windowedEvents.filter((e) => e.type === 'materialize');
    const successes = windowMats.filter((e) => e.status === 'success').length;
    const failures = windowMats.filter((e) => e.status === 'failure').length;
    const running = activationEvents.filter((e) => e.status === 'running').length;
    const successRate = windowMats.length > 0 ? successes / windowMats.length : null;
    return { totalRowsSynced, successes, failures, running, successRate };
  }, [activationEvents, windowedEvents]);

  const trend = useMemo(() => {
    const bucketMs = window === '24h' ? 3600e3 : 24 * 3600e3;
    const bucketCount = window === '24h' ? 24 : window === '7d' ? 7 : 30;
    const startMs = now - bucketCount * bucketMs;
    const buckets: { t: number; success: number; failure: number; rows: number }[] = [];
    for (let i = 0; i < bucketCount; i++) buckets.push({ t: startMs + i * bucketMs, success: 0, failure: 0, rows: 0 });
    for (const e of windowedEvents) {
      const dt = new Date(e.ts).getTime();
      if (dt < startMs) continue;
      const idx = Math.min(bucketCount - 1, Math.floor((dt - startMs) / bucketMs));
      if (e.type === 'materialize') {
        if (e.status === 'success') buckets[idx].success++;
        else if (e.status === 'failure') buckets[idx].failure++;
      }
      if (e.type === 'materialize' && e.status === 'success') buckets[idx].rows += e.rows ?? 0;
    }
    return { buckets, bucketMs, bucketCount };
  }, [windowedEvents, window, now]);

  const handleRun = async (assetKey: string, componentId: string) => {
    if (!currentProject) return;
    setRunningId(componentId);
    try {
      const r = await projectsApi.materialize(currentProject.id, [assetKey]);
      if (!r.success) {
        notify.error('Run failed. See console.');
        console.warn('[Activate] stderr:', r.stderr);
      } else {
        notify.success(`Synced ${assetKey}.`);
      }
    } catch (e: any) {
      notify.error(`Run failed: ${e?.message ?? e}`);
    } finally {
      setRunningId(null);
    }
  };

  if (!currentProject) {
    return <div className="p-8 text-center text-sm text-gray-500">Open a project to see its activations.</div>;
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-2">
        <div className="text-xs text-gray-400">
          Sync data out to a CRM, marketing platform, support desk, or CDP — the mirror of Ingestions.
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent"
        >
          <Plus className="w-4 h-4" /> Add activation
        </button>
      </div>

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
            label="Total rows synced"
            value={formatCompact(analytics.totalRowsSynced)}
            hint="across all activation targets"
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
            hint={analytics.successRate !== null ? `${Math.round((analytics.successRate ?? 0) * 100)}% success rate` : 'no runs yet'}
            icon={CheckCircle2}
            tone="success"
          />
          <KpiCard
            label={`Failed runs (${window})`}
            value={String(analytics.failures)}
            icon={XCircle}
            tone={analytics.failures > 0 ? 'warning' : 'neutral'}
          />
        </div>

        <TrendChart trend={trend} window={window} title="Activation activity" rowsLegendLabel="rows synced" emptyHint="Sync an activation target to start populating this chart." />

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Send className="w-4 h-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-900">Activation targets</h2>
            <span className="text-xs text-gray-400">{activations.length}</span>
          </div>

          {activations.length === 0 ? (
            <div className="p-8 text-center">
              <Send className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-600 mb-3">You don't have any activation targets in this project yet.</p>
              <button
                onClick={() => setAddOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded"
              >
                <Plus className="w-4 h-4" /> Add your first activation
              </button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Name</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Target</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Last synced</th>
                  <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activations.map(({ component, assetKey, lastRun, configured }) => (
                  <tr
                    key={component.id}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer"
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      if (target.closest('button')) return;
                      onEditComponent(component);
                    }}
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-900">{component.label || component.id}</div>
                      <div className="text-[11px] text-gray-500 font-mono truncate max-w-[240px]">{assetKey}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">{extractComponentId(component.component_type)}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-700">
                      {lastRun ? new Date(lastRun.ts).toLocaleString() : <span className="text-gray-400 italic">never run</span>}
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
                          <CheckCircle2 className="w-3 h-3" /> Synced
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                          <Clock className="w-3 h-3" /> Idle
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleRun(assetKey, component.id)}
                        disabled={!configured || runningId === component.id}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
                        title={configured ? 'Sync now' : 'Configure required fields first'}
                      >
                        <Play className="w-3 h-3" />
                        {runningId === component.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Sync'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <AddActivationDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onTargetPicked={(componentType) => onAddActivationTarget(componentType)}
      />
    </div>
  );
}
