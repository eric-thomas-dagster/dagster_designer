import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Wand2, Maximize2, ChevronRight, Table as TableIcon, Play, Loader2, AlertCircle, BarChart3 } from 'lucide-react';
import { assetsApi, projectsApi, type AssetDataPreview } from '@/services/api';
import { notify } from './Notifications';
import { ColumnProfileStrip } from './ColumnProfileStrip';
import { ColumnProfilePanel } from './ColumnProfilePanel';

interface AssetIOPanelProps {
  projectId: string;
  selectedAssetKey: string | null;
  /** Upstream asset keys derived from the graph edges terminating at the selected node. */
  upstreamKeys: string[];
  /** Open the full-screen DataPreviewModal on a specific asset in view /
   *  transform / profile mode. */
  onOpenPreview: (assetKey: string, mode: 'view' | 'transform' | 'profile') => void;
  /** User closed / dismissed the panel. */
  onClose: () => void;
}

/**
 * Docked bottom panel that shows compact previews of the selected asset's
 * input(s) and output — inspired by Lakeflow Designer. Auto-loads via the
 * backend preview cache so clicking around is snappy. Buttons in the header
 * hand off to the full DataPreviewModal for transform-authoring or a
 * larger-row view.
 */
export function AssetIOPanel({
  projectId,
  selectedAssetKey,
  upstreamKeys,
  onOpenPreview,
  onClose,
}: AssetIOPanelProps) {
  const [activeSide, setActiveSide] = useState<'input' | 'output'>('output');
  const [activeInput, setActiveInput] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'table' | 'profile'>('table');
  const [sampleLimit, setSampleLimit] = useState<number>(100);
  const [height, setHeight] = useState<number>(280);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // When selection changes, default to Output tab and reset input focus.
  useEffect(() => {
    setActiveSide('output');
    setActiveInput(upstreamKeys[0] ?? null);
  }, [selectedAssetKey, upstreamKeys.join('|')]);

  // Vertical resize — mouse move → adjust height.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - e.clientY;
      const next = Math.max(160, Math.min(600, dragRef.current.startH + dy));
      setHeight(next);
    }
    function onUp() {
      dragRef.current = null;
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  if (!selectedAssetKey) return null;

  const currentAssetKey =
    activeSide === 'output' ? selectedAssetKey : activeInput ?? selectedAssetKey;

  return (
    <div
      className="flex-shrink-0 border-t border-gray-200 bg-white flex flex-col shadow-[0_-2px_8px_rgba(0,0,0,0.04)]"
      style={{ height }}
    >
      {/* Drag handle to resize */}
      <div
        onMouseDown={(e) => {
          dragRef.current = { startY: e.clientY, startH: height };
          document.body.style.userSelect = 'none';
        }}
        className="h-1 cursor-row-resize bg-gray-100 hover:bg-primary/40 transition-colors"
      />

      {/* Header */}
      <div className="flex-shrink-0 flex items-center border-b border-gray-200 px-3 py-1.5 gap-2">
        <div className="flex items-center gap-1">
          {upstreamKeys.length > 0 && (
            <button
              onClick={() => setActiveSide('input')}
              className={`px-2.5 py-1 text-xs rounded-md ${
                activeSide === 'input'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              Input
              {upstreamKeys.length > 0 && (
                <span className="ml-1 text-gray-400">{upstreamKeys.length}</span>
              )}
            </button>
          )}
          <button
            onClick={() => setActiveSide('output')}
            className={`px-2.5 py-1 text-xs rounded-md ${
              activeSide === 'output'
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Output
          </button>
        </div>

        <div className="text-xs text-gray-400 truncate flex-1 flex items-center gap-1 min-w-0">
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
          <span className="font-mono truncate">{currentAssetKey}</span>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Table / Profile view toggle — shares one preview fetch. */}
          <div className="flex items-center gap-0.5 bg-gray-100 rounded p-0.5 mr-1">
            <button
              onClick={() => setActiveView('table')}
              className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded ${
                activeView === 'table' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
              }`}
              title="Rows and columns"
            >
              <TableIcon className="w-3 h-3" />
              Table
            </button>
            <button
              onClick={() => setActiveView('profile')}
              className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded ${
                activeView === 'profile' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
              }`}
              title="Column-by-column distribution profile"
            >
              <BarChart3 className="w-3 h-3" />
              Profile
            </button>
          </div>

          {/* Sample-size selector — only shown in Profile view. Bigger
              samples give more accurate distributions but take longer. */}
          {activeView === 'profile' && (
            <select
              value={sampleLimit}
              onChange={(e) => setSampleLimit(parseInt(e.target.value, 10))}
              className="text-[11px] border border-gray-300 rounded px-1 py-0.5 mr-1"
              title="Sample size for the profile"
            >
              <option value={100}>100 rows</option>
              <option value={500}>500 rows</option>
              <option value={1000}>1k rows</option>
              <option value={5000}>5k rows</option>
              <option value={10000}>10k rows</option>
            </select>
          )}

          <button
            onClick={() => onOpenPreview(currentAssetKey, 'transform')}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded"
            title="Open the full preview modal in transform mode"
          >
            <Wand2 className="w-3.5 h-3.5" />
            Transform
          </button>
          <button
            onClick={() => onOpenPreview(currentAssetKey, activeView === 'profile' ? 'profile' : 'view')}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded"
            title="Open the full preview modal (more rows, full detail)"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Preview more
          </button>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
            title="Close panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Input sub-tabs — only visible on Input side with multiple upstreams */}
      {activeSide === 'input' && upstreamKeys.length > 1 && (
        <div className="flex-shrink-0 flex items-center gap-1 px-3 py-1 border-b border-gray-100 overflow-x-auto">
          {upstreamKeys.map((k) => (
            <button
              key={k}
              onClick={() => setActiveInput(k)}
              className={`px-2 py-0.5 text-[11px] font-mono rounded whitespace-nowrap ${
                activeInput === k
                  ? 'bg-gray-100 text-gray-900'
                  : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      )}

      {/* Body — preview table OR profile view for the current asset */}
      <div className="flex-1 overflow-auto min-h-0">
        <PreviewTable
          projectId={projectId}
          assetKey={currentAssetKey}
          view={activeView}
          sampleLimit={sampleLimit}
        />
      </div>
    </div>
  );
}

/**
 * Compact preview table — reuses the same /assets/{id}/{key}/preview endpoint
 * that DataPreviewModal uses, so it hits the same backend cache.
 */
function PreviewTable({
  projectId,
  assetKey,
  view,
  sampleLimit,
}: {
  projectId: string;
  assetKey: string;
  view: 'table' | 'profile';
  sampleLimit: number;
}) {
  const [running, setRunning] = useState(false);
  const [materializeError, setMaterializeError] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['asset-preview', projectId, assetKey, sampleLimit],
    queryFn: async (): Promise<AssetDataPreview> => {
      const r = await assetsApi.previewData(projectId, assetKey, { sampleLimit });
      return r;
    },
    // Backend cache already handles TTL; keep react-query in sync by not
    // caching too aggressively on the client — 30s is enough to smooth
    // rapid selection changes without going stale.
    staleTime: 30_000,
  });

  const isNotMaterialized = useMemo(() => {
    const msg = data?.error || (error instanceof Error ? error.message : '');
    if (!msg) return false;
    return (
      /run to here/i.test(msg) ||
      /not materialized/i.test(msg) ||
      /couldn.?t find materialized/i.test(msg) ||
      /does not exist/i.test(msg)
    );
  }, [data, error]);

  const handleRun = async () => {
    setRunning(true);
    setMaterializeError(null);
    try {
      const r = await projectsApi.materialize(projectId, [`+${assetKey}`]);
      if (!r.success) {
        // Pull the last meaningful lines out of stderr/stdout. dbt/dg logs
        // are noisy — anything mentioning ERROR / Error / Catalog Error is
        // the useful signal.
        const raw = (r.stderr || r.stdout || '').split('\n');
        const errorLines = raw.filter((l) =>
          /error|failed|catalog error/i.test(l)
        ).slice(-6);
        const message = errorLines.length > 0
          ? errorLines.join('\n')
          : raw.slice(-6).join('\n') || 'unknown error';
        setMaterializeError(message);
        notify.error(`Materialize failed for ${assetKey}. See panel for details.`);
        return;
      }
      notify.success(`Materialized ${assetKey}. Loading…`);
      await refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMaterializeError(msg);
      notify.error(`Materialize failed: ${msg}`);
    } finally {
      setRunning(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-500 text-xs gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading preview…
      </div>
    );
  }

  if (isNotMaterialized || (data && !data.success && data.error)) {
    if (isNotMaterialized) {
      return (
        <div className="flex flex-col items-center justify-center py-6 px-4 text-center text-xs gap-2">
          <TableIcon className="w-6 h-6 text-gray-300" />
          <div className="text-gray-600">No data yet — asset hasn't been materialized.</div>
          <button
            onClick={handleRun}
            disabled={running}
            className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-60"
          >
            {running ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                Run to here
              </>
            )}
          </button>
          {materializeError && (
            <div className="mt-3 w-full max-w-2xl text-left bg-red-50 border border-red-200 rounded p-2.5">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-red-900 mb-1">
                    Last materialize failed
                  </div>
                  <pre className="text-[10px] text-red-700 whitespace-pre-wrap font-mono overflow-x-auto">
                    {materializeError}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="flex items-start gap-2 p-4 text-xs text-red-700 bg-red-50 border border-red-200 rounded m-3">
        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>{data?.error || 'Preview failed.'}</span>
      </div>
    );
  }

  if (!data || !data.success || !data.data || !data.columns) {
    return (
      <div className="text-center py-8 text-gray-400 text-xs">
        No preview available.
      </div>
    );
  }

  if (view === 'profile') {
    return (
      <ColumnProfilePanel
        rows={data.data}
        columns={data.columns}
        dtypes={data.dtypes ?? undefined}
        totalRows={data.row_count ?? data.data.length}
      />
    );
  }

  const previewRows = data.data.slice(0, 50);

  return (
    <div className="p-2">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-gray-500">
        <span>{data.row_count?.toLocaleString() ?? '?'} rows</span>
        <span>·</span>
        <span>{data.column_count} columns</span>
        {(data as any).source && (
          <>
            <span>·</span>
            <span className="font-mono truncate">{(data as any).source}</span>
          </>
        )}
      </div>
      <table className="min-w-full text-xs border border-gray-200">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            {data.columns.map((c) => (
              <th
                key={c}
                className="px-2 py-1 text-left font-medium text-gray-700 border-b border-gray-200 whitespace-nowrap align-top"
              >
                <div className="flex flex-col">
                  <span>{c}</span>
                  {data.dtypes?.[c] && (
                    <span className="text-[9px] text-gray-400 font-normal">
                      {data.dtypes[c]}
                    </span>
                  )}
                  {data.data && (
                    <ColumnProfileStrip
                      rows={data.data}
                      column={c}
                      dtype={data.dtypes?.[c]}
                      compact
                    />
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {previewRows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
              {data.columns!.map((c) => {
                const v = row[c];
                return (
                  <td
                    key={c}
                    className="px-2 py-1 border-b border-gray-100 text-gray-800 max-w-xs truncate"
                    title={String(v ?? '')}
                  >
                    {v === null || v === undefined ? (
                      <span className="text-gray-400 italic">null</span>
                    ) : (
                      String(v)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
