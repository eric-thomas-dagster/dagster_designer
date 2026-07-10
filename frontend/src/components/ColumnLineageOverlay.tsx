import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Sparkles, ArrowRight, Loader2 } from 'lucide-react';
import { assetsApi } from '@/services/api';

interface ColumnLineageOverlayProps {
  projectId: string;
  assetKey: string;
  onClose: () => void;
}

/**
 * Floating overlay showing heuristic column-level lineage for one
 * asset. Three vertical columns:
 *   [ upstream assets ]  →  [ this asset ]  →  [ downstream assets ]
 * SVG paths connect each matched column across the split. Derived
 * columns (present only in this asset, no upstream match) render
 * with a small ✨ badge instead of an incoming line.
 *
 * Data comes from GET /assets/{id}/column-lineage — a name-match
 * heuristic over the preview schema cache. Works for every component
 * without any per-component instrumentation.
 */
export function ColumnLineageOverlay({ projectId, assetKey, onClose }: ColumnLineageOverlayProps) {
  const [data, setData] = useState<Awaited<ReturnType<typeof assetsApi.columnLineage>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const colRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [connectorPaths, setConnectorPaths] = useState<Array<{ d: string; confidence: number; className: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    assetsApi.columnLineage(projectId, assetKey)
      .then((r) => { if (!cancelled) { setData(r); setLoading(false); } })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.detail || e?.message || String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, assetKey]);

  // Compute SVG connector paths whenever the data or panel geometry
  // changes. We look up the rendered DOM position of each column
  // <div> by ref, translate to container-local coordinates, and emit
  // a cubic bezier between them. Recomputes on window resize so the
  // paths stay glued to the columns when the overlay repositions.
  const recomputePaths = () => {
    if (!containerRef.current || !data) return;
    const cbox = containerRef.current.getBoundingClientRect();
    const paths: Array<{ d: string; confidence: number; className: string }> = [];
    const draw = (fromKey: string, toKey: string, confidence: number, cls: string) => {
      const a = colRefs.current.get(fromKey);
      const b = colRefs.current.get(toKey);
      if (!a || !b) return;
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const x1 = ar.right - cbox.left;
      const y1 = ar.top + ar.height / 2 - cbox.top;
      const x2 = br.left - cbox.left;
      const y2 = br.top + br.height / 2 - cbox.top;
      const dx = Math.max(30, (x2 - x1) / 2);
      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      paths.push({ d, confidence, className: cls });
    };
    for (const e of data.upstream_edges) {
      draw(
        `up:${e.from_asset}:${e.from_column}`,
        `this:${e.to_column}`,
        e.confidence,
        'stroke-emerald-500',
      );
    }
    for (const e of data.downstream_edges) {
      draw(
        `this:${e.from_column}`,
        `down:${e.to_asset}:${e.to_column}`,
        e.confidence,
        'stroke-blue-500',
      );
    }
    setConnectorPaths(paths);
  };

  useEffect(() => {
    // Recompute after render + when window resizes / user scrolls.
    if (!data) return;
    const id = requestAnimationFrame(recomputePaths);
    const onResize = () => recomputePaths();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const totalUpCols = useMemo(() => data?.upstream.reduce((s, u) => s + u.columns.length, 0) ?? 0, [data]);
  const totalDownCols = useMemo(() => data?.downstream.reduce((s, u) => s + u.columns.length, 0) ?? 0, [data]);

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-[1100px] max-w-[98vw] max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        ref={containerRef}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" />
              Column lineage · <span className="font-mono text-gray-700">{assetKey}</span>
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Heuristic — name-match passthrough, derived columns marked with ✨. Preview upstream + downstream to fill this in.
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" aria-label="Close">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="relative flex-1 overflow-auto p-6">
          {loading && (
            <div className="flex items-center justify-center py-10 text-sm text-gray-500 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading column lineage…
            </div>
          )}
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error}</div>
          )}
          {data && !loading && !error && (
            <>
              <div className="grid grid-cols-3 gap-6 relative" style={{ minHeight: 240 }}>
                {/* Upstream */}
                <div>
                  <SectionHeader label="Upstream" count={data.upstream.length} sub={`${totalUpCols} col${totalUpCols === 1 ? '' : 's'}`} align="left" />
                  {data.upstream.length === 0 && <EmptyHint text="No upstream assets in the graph." />}
                  {data.upstream.map((u) => (
                    <AssetBlock
                      key={u.asset_key}
                      title={u.asset_key}
                      columns={u.columns}
                      accent="border-emerald-200 bg-emerald-50/40"
                      side="right"
                      colRef={(col, el) => colRefs.current.set(`up:${u.asset_key}:${col}`, el)}
                      annotate={(col) => {
                        // Faded when this column has no downstream edge to
                        // "this asset" — makes dropped cols visible.
                        const hasEdge = data.upstream_edges.some((e) => e.from_asset === u.asset_key && e.from_column === col);
                        return hasEdge ? null : 'dropped';
                      }}
                    />
                  ))}
                </div>
                {/* This asset */}
                <div>
                  <SectionHeader label={assetKey} count={1} sub={`${data.columns.length} col${data.columns.length === 1 ? '' : 's'}`} align="center" />
                  {data.columns.length === 0 && <EmptyHint text="No columns cached yet — preview this asset to populate lineage." />}
                  <AssetBlock
                    title={assetKey}
                    columns={data.columns}
                    accent="border-primary/30 bg-primary/5"
                    side="both"
                    colRef={(col, el) => colRefs.current.set(`this:${col}`, el)}
                    annotate={(col) => (data.derived_columns.includes(col) ? 'derived' : null)}
                  />
                </div>
                {/* Downstream */}
                <div>
                  <SectionHeader label="Downstream" count={data.downstream.length} sub={`${totalDownCols} col${totalDownCols === 1 ? '' : 's'}`} align="right" />
                  {data.downstream.length === 0 && <EmptyHint text="No downstream assets in the graph." />}
                  {data.downstream.map((d) => (
                    <AssetBlock
                      key={d.asset_key}
                      title={d.asset_key}
                      columns={d.columns}
                      accent="border-blue-200 bg-blue-50/40"
                      side="left"
                      colRef={(col, el) => colRefs.current.set(`down:${d.asset_key}:${col}`, el)}
                      annotate={(col) => {
                        const hasEdge = data.downstream_edges.some((e) => e.to_asset === d.asset_key && e.to_column === col);
                        return hasEdge ? null : 'derived-here';
                      }}
                    />
                  ))}
                </div>

                {/* SVG connectors — overlaid on the whole grid so they
                    can cross columns freely. Pointer-events disabled so
                    hover on chips still works. */}
                <svg
                  className="absolute inset-0 pointer-events-none"
                  width="100%"
                  height="100%"
                  style={{ overflow: 'visible' }}
                >
                  {connectorPaths.map((p, i) => (
                    <path
                      key={i}
                      d={p.d}
                      fill="none"
                      strokeWidth={1.5}
                      className={p.className}
                      style={{ opacity: 0.35 + p.confidence * 0.5 }}
                    />
                  ))}
                </svg>
              </div>

              {/* Footer stats */}
              <div className="mt-6 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
                <span>{data.upstream_edges.length + data.downstream_edges.length} edges</span>
                {data.derived_columns.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-amber-500" />
                    {data.derived_columns.length} derived
                  </span>
                )}
                {data.dropped_from_upstream.length > 0 && (
                  <span>{data.dropped_from_upstream.length} upstream cols dropped</span>
                )}
                <span className="ml-auto">Confidence: solid = name match · faded = heuristic guess</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ label, count, sub, align }: { label: string; count: number; sub: string; align: 'left' | 'center' | 'right' }) {
  return (
    <div className={`mb-2 text-xs font-semibold text-gray-700 uppercase tracking-wider flex items-baseline gap-2 ${
      align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''
    }`}>
      <span className="truncate">{label}</span>
      <span className="text-[10px] font-normal text-gray-400">{sub}</span>
      <span className="text-[10px] font-normal text-gray-400">({count})</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="p-3 border border-dashed border-gray-200 rounded text-[11px] text-gray-500 text-center">{text}</div>;
}

function AssetBlock({
  title,
  columns,
  accent,
  side,
  colRef,
  annotate,
}: {
  title: string;
  columns: string[];
  accent: string;
  side: 'left' | 'right' | 'both';
  colRef: (col: string, el: HTMLDivElement | null) => void;
  annotate?: (col: string) => 'dropped' | 'derived' | 'derived-here' | null;
}) {
  return (
    <div className={`rounded border ${accent} p-2 mb-2`}>
      <div className="text-[11px] font-mono text-gray-700 truncate mb-1.5" title={title}>{title}</div>
      <div className="space-y-1">
        {columns.map((col) => {
          const note = annotate?.(col) ?? null;
          const isDropped = note === 'dropped';
          const isDerived = note === 'derived';
          const isDerivedHere = note === 'derived-here';
          return (
            <div
              key={col}
              ref={(el) => colRef(col, el)}
              className={`flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] rounded ${
                isDropped ? 'bg-gray-100 text-gray-400 line-through' : 'bg-white text-gray-800'
              } ${side === 'left' ? 'justify-start' : side === 'right' ? 'justify-end' : 'justify-center'}`}
            >
              {(side === 'left' || side === 'both') && (
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" />
              )}
              <span className="font-mono truncate" title={col}>{col}</span>
              {isDerived && (
                <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-700" title="No matching column on any upstream — likely a derived / calc / renamed column.">
                  <Sparkles className="w-2.5 h-2.5" /> derived
                </span>
              )}
              {isDerivedHere && (
                <span className="inline-flex items-center gap-0.5 text-[9px] text-blue-700" title="No matching column on this asset — added downstream.">
                  <ArrowRight className="w-2.5 h-2.5" /> new
                </span>
              )}
              {(side === 'right' || side === 'both') && (
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
