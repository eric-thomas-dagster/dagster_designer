import { useMemo } from 'react';
import { ArrowLeft, ChevronRight, Play, Layers, Settings, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import type { IngestionEvent } from '@/services/api';
import { KIND_META, Fact, formatRelative, type SourceKind } from './ingestionShared';
import { BigTimeSeriesChart, BigPassFailStrip, type NumericPoint } from './MonitorDetailPage';
import { PartitionsTab, AutomationSection } from './AssetDetailPage';

/** Full-page ingestion detail view -- replaces the old slide-in
 *  RowDetailDrawer. Matches MonitorDetailPage's layout (breadcrumb ribbon,
 *  full-width two-tier header, card-styled sections) instead of its own
 *  earlier centered/narrow column -- confirmed live as a jarring
 *  inconsistency between the app's two "detail page" surfaces for
 *  conceptually similar data.
 */
export function IngestionDetailPage({
  target,
  projectId,
  isCloud,
  currentProject,
  onBack,
  onEdit,
  onRun,
  onBackfill,
  running,
  onOpenRun,
  onNewPrimitiveForAsset,
  onEditComponent,
}: {
  target: any;
  projectId: string;
  isCloud: boolean;
  currentProject: any;
  onBack: () => void;
  onEdit?: () => void;
  onRun: () => void;
  onBackfill?: () => void;
  running: boolean;
  onOpenRun?: (runId: string) => void;
  onNewPrimitiveForAsset?: (category: 'schedule' | 'job' | 'sensor' | 'asset_check' | 'freshness_policy', assetKey: string) => void;
  /** Opens a listed schedule/job's OWN component editor from the
   *  Automation card -- distinct from `onEdit` above, which always edits
   *  THIS ingestion's own component. */
  onEditComponent?: (component: any) => void;
}) {
  const events = (target.materializes as IngestionEvent[]) || [];
  const runs = useMemo(() => events.slice(-50).reverse(), [events]);
  const kindMeta = KIND_META[target.kind as SourceKind];
  const KindIcon = kindMeta.icon;

  // "Rows ingested over time" -- row counts can come from either a
  // materialize (when the component attaches its own `dagster/row_count`
  // metadata -- confirmed live, several real components here do) or a
  // preview (a direct COUNT(*)/len(df) read). The top-level "Total rows
  // ingested" KPI already pulls from this same unfiltered history for
  // that reason -- scoping this chart to materializes-only (as it
  // originally was, before the backend also started extracting
  // dagster/row_count out of materialize metadata) meant it could never
  // show anything even when that KPI had real data, which is confusing on
  // its own page. `target.history` is the SAME per-asset event list
  // before the materialize-only filter that produces target.materializes.
  const rowPoints: NumericPoint[] = useMemo(
    () => (target.history as IngestionEvent[])
      .filter((e) => e.rows != null)
      .map((e) => ({ ts: e.ts, value: e.rows as number })),
    [target.history]
  );
  const statusPoints = useMemo(() => events.map((e) => ({ status: e.status, ts: e.ts })), [events]);

  // PartitionsTab only ever reads node.data.asset_key and node.id -- this
  // minimal synthetic node gives it exactly what it needs without this
  // page depending on a real asset-graph node existing for the ingestion.
  const syntheticNode = useMemo(
    () => ({
      id: target.assetKey,
      type: 'asset',
      position: { x: 0, y: 0 },
      data: { label: target.assetKey, asset_key: target.assetKey },
    }),
    [target.assetKey]
  );

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      {/* Breadcrumb ribbon */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2">
        <button onClick={onBack} className="p-1 hover:bg-gray-100 rounded text-gray-500 hover:text-gray-900" title="Back to ingestions">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-900">Ingestions</button>
        <ChevronRight className="w-3 h-3 text-gray-300" />
        <span className="text-xs text-gray-900 font-mono truncate max-w-[440px]" title={target.assetKey}>{target.assetKey}</span>
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-lg ${kindMeta.color} bg-opacity-10 flex items-center justify-center flex-shrink-0`}>
            <KindIcon className="w-6 h-6 text-gray-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              {kindMeta.label}
            </div>
            <div className="text-2xl font-semibold text-gray-900 mt-0.5 truncate" title={target.component.label || target.component.id}>
              {target.component.label || target.component.id}
            </div>
            <p className="text-xs text-gray-500 font-mono truncate mt-1" title={target.component.component_type}>
              {target.component.component_type.split('.').pop()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={onRun}
              disabled={!target.configured || target.readOnly || running}
              title={target.readOnly ? 'Read-only -- no local component to run' : undefined}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-40"
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {running ? 'Running…' : 'Run now'}
            </button>
            {onBackfill && (
              <button
                onClick={onBackfill}
                disabled={!target.configured}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-indigo-700 border border-indigo-200 bg-indigo-50 rounded hover:bg-indigo-100 disabled:opacity-40"
                title="Re-run specific partitions (e.g. 2026-07-04) or the whole history after a schema change"
              >
                <Layers className="w-3.5 h-3.5" />
                Backfill…
              </button>
            )}
            {onEdit && (
              <button
                onClick={onEdit}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-100 rounded border border-gray-200"
              >
                <Settings className="w-3.5 h-3.5" />
                Configure
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="px-8 py-6 space-y-4">
        {/* Facts */}
        <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-4 text-xs">
            <Fact label="Destination asset" value={target.assetKey} mono />
            <Fact label="Kind" value={kindMeta.label} />
            <Fact
              label="Cadence"
              value={
                target.schedules.length > 0
                  ? target.schedules.map((s: any) => s.cron || 'scheduled').join(', ')
                  : (target.sensors as any[]).length > 0
                    ? (target.sensors as any[]).map((s) => s.name).join(', ') + ' (sensor)'
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
            <Fact label="Last run" value={target.lastRun ? formatRelative(target.lastRun.ts) : 'never'} />
          </div>
        </div>

        {/* Automation -- add/edit a cadence for this ingestion: attach it
            to an existing job/schedule, or create a new one targeting just
            this asset. Reused verbatim from AssetDetailPage's own
            Automation card via the same synthetic-node pattern PartitionsTab
            already uses above -- gives ingestions the exact same cadence
            management UX assets already have, instead of a second,
            divergent implementation. */}
        <AutomationSection
          node={syntheticNode as any}
          isCloud={isCloud}
          jobs={target.jobs ?? []}
          schedules={target.schedules ?? []}
          sensors={target.sensors ?? []}
          onNewPrimitiveForAsset={onNewPrimitiveForAsset}
          onEditItem={onEditComponent}
        />

        {/* Partition status grid -- partitioned ingestions only */}
        {target.partition && (
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Partitions</h3>
            </div>
            <div className="p-4">
              <PartitionsTab
                node={syntheticNode as any}
                isCloud={isCloud}
                projectId={projectId}
                currentProject={currentProject}
                onOpenRun={onOpenRun}
              />
            </div>
          </div>
        )}

        {/* Rows ingested over time */}
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Rows ingested over time</h3>
          </div>
          <div className="p-4">
            {rowPoints.length === 0 ? (
              <div className="text-xs text-gray-400 italic py-8 text-center">
                No row counts recorded yet -- either this component doesn't attach row-count metadata to its materializations, or it hasn't materialized (or been previewed) since this was added.
              </div>
            ) : (
              <BigTimeSeriesChart points={rowPoints} />
            )}
          </div>
        </div>

        {/* Status over time */}
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Status over time</h3>
          </div>
          <div className="p-4">
            <BigPassFailStrip events={statusPoints} />
          </div>
        </div>

        {/* Recent runs */}
        <div className="bg-white border border-gray-200 rounded-lg">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Recent runs</h3>
          </div>
          {runs.length === 0 ? (
            <div className="p-8 text-center text-xs text-gray-400">
              No runs recorded yet. Materialize this ingestion to see history here.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {runs.map((e, i) => {
                const openable = !!(e.run_id && onOpenRun);
                return (
                  <li
                    key={i}
                    onClick={openable ? () => onOpenRun!(e.run_id!) : undefined}
                    className={`px-4 py-2 flex items-center gap-2 text-xs ${openable ? 'cursor-pointer hover:bg-gray-50' : ''}`}
                    title={openable ? 'Open this run' : e.run_id ? undefined : 'No run recorded for this event'}
                  >
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
                    {openable && <ChevronRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
