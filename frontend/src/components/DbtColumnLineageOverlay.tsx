import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Sparkles, ArrowRight } from 'lucide-react';
import { projectsApi } from '@/services/api';

interface DbtColumnLineageOverlayProps {
  projectId: string;
  dbtRelativePath: string;
  modelUniqueId: string;
  modelName: string;
  onClose: () => void;
}

/**
 * Visual column-to-column lineage for a dbt model. Three-column layout:
 *
 *   [ upstream models + their columns ]  →  [ this model ]  →  [ downstream models ]
 *
 * SVG cubic-bezier connectors bridge matched columns across the split
 * (green for incoming, blue for outgoing, opacity by confidence). This
 * is what the drawer's chip-list Column Lineage section was hinting at,
 * but properly drawn so users can trace `x ← foo.x ← bar.x` visually.
 *
 * Data source: the same /dbt-column-lineage endpoint the drawer uses —
 * heuristic name-match edges plus SQL-scan fallbacks. We filter down to
 * edges touching the focal model.
 */
export function DbtColumnLineageOverlay({
  projectId,
  dbtRelativePath,
  modelUniqueId,
  modelName,
  onClose,
}: DbtColumnLineageOverlayProps) {
  const [data, setData] = useState<Awaited<ReturnType<typeof projectsApi.getDbtColumnLineage>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const colRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [connectorPaths, setConnectorPaths] = useState<Array<{ d: string; confidence: number; className: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    projectsApi.getDbtColumnLineage(projectId, dbtRelativePath)
      .then((r) => { if (!cancelled) { setData(r); setLoading(false); } })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.detail || e?.message || String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, dbtRelativePath]);

  // Group edges around the focal model.
  const { incoming, outgoing, thisColumns } = useMemo(() => {
    if (!data) return { incoming: new Map<string, Array<{ from_uid: string; from_col: string; confidence: number }>>(), outgoing: new Map<string, Array<{ to_uid: string; to_col: string; confidence: number }>>(), thisColumns: [] as string[] };
    const inc = new Map<string, Array<{ from_uid: string; from_col: string; confidence: number }>>();
    const out = new Map<string, Array<{ to_uid: string; to_col: string; confidence: number }>>();
    const cols = new Set<string>(data.columns_by_model[modelUniqueId] ?? []);
    for (const e of data.edges) {
      if (e.to_unique_id === modelUniqueId) {
        cols.add(e.to_column);
        const arr = inc.get(e.from_unique_id) ?? [];
        arr.push({ from_uid: e.from_unique_id, from_col: e.from_column, confidence: e.confidence });
        inc.set(e.from_unique_id, arr);
      }
      if (e.from_unique_id === modelUniqueId) {
        cols.add(e.from_column);
        const arr = out.get(e.to_unique_id) ?? [];
        arr.push({ to_uid: e.to_unique_id, to_col: e.to_column, confidence: e.confidence });
        out.set(e.to_unique_id, arr);
      }
    }
    return { incoming: inc, outgoing: out, thisColumns: Array.from(cols).sort() };
  }, [data, modelUniqueId]);

  // For each upstream/downstream model, which of its columns actually
  // touch the focal model? We render all columns but fade the ones
  // without an edge so users see "dropped" columns as well.
  const upstreamModels = useMemo(() => {
    if (!data) return [] as Array<{ uid: string; columns: string[]; edgesByCol: Map<string, number> }>;
    return Array.from(incoming.keys()).map((uid) => {
      const cols = data.columns_by_model[uid] ?? [];
      const edgesByCol = new Map<string, number>();
      for (const e of incoming.get(uid) ?? []) {
        edgesByCol.set(e.from_col, Math.max(edgesByCol.get(e.from_col) ?? 0, e.confidence));
        if (!cols.includes(e.from_col)) cols.push(e.from_col);
      }
      return { uid, columns: cols.slice().sort(), edgesByCol };
    });
  }, [data, incoming]);
  const downstreamModels = useMemo(() => {
    if (!data) return [] as Array<{ uid: string; columns: string[]; edgesByCol: Map<string, number> }>;
    return Array.from(outgoing.keys()).map((uid) => {
      const cols = data.columns_by_model[uid] ?? [];
      const edgesByCol = new Map<string, number>();
      for (const e of outgoing.get(uid) ?? []) {
        edgesByCol.set(e.to_col, Math.max(edgesByCol.get(e.to_col) ?? 0, e.confidence));
        if (!cols.includes(e.to_col)) cols.push(e.to_col);
      }
      return { uid, columns: cols.slice().sort(), edgesByCol };
    });
  }, [data, outgoing]);

  // Compute SVG connector paths on data change / resize / scroll.
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
    for (const [uid, edges] of incoming) {
      for (const e of edges) {
        draw(`up:${uid}:${e.from_col}`, `this:${e.from_col === e.from_col ? '' : ''}${e.from_col}`, e.confidence, 'stroke-emerald-500');
      }
    }
    // Correct: the edge target is `to_col` on the focal model, not `from_col`.
    // Redo — the loop above passed the wrong key. Clear + rebuild properly.
    paths.length = 0;
    for (const [uid, edges] of incoming) {
      for (const e of edges) {
        // Find the corresponding edge's `to_column` on the focal model.
        // We stored it in `data.edges`; look it up.
        const raw = data.edges.find(x => x.from_unique_id === uid && x.from_column === e.from_col && x.to_unique_id === modelUniqueId);
        if (!raw) continue;
        draw(`up:${uid}:${e.from_col}`, `this:${raw.to_column}`, e.confidence, 'stroke-emerald-500');
      }
    }
    for (const [uid, edges] of outgoing) {
      for (const e of edges) {
        const raw = data.edges.find(x => x.from_unique_id === modelUniqueId && x.to_unique_id === uid && x.to_column === e.to_col);
        if (!raw) continue;
        draw(`this:${raw.from_column}`, `down:${uid}:${e.to_col}`, e.confidence, 'stroke-blue-500');
      }
    }
    setConnectorPaths(paths);
  };

  useEffect(() => {
    if (!data) return;
    const id = requestAnimationFrame(recomputePaths);
    const onResize = () => recomputePaths();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, upstreamModels, downstreamModels]);

  const totalUpEdges = useMemo(() => Array.from(incoming.values()).reduce((s, arr) => s + arr.length, 0), [incoming]);
  const totalDownEdges = useMemo(() => Array.from(outgoing.values()).reduce((s, arr) => s + arr.length, 0), [outgoing]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[1200px] max-w-[98vw] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        ref={containerRef}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" />
              Column lineage · <span className="font-mono text-gray-700">{modelName}</span>
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Heuristic — solid = name match, faded = SQL-scan guess. Dropped columns render greyed with strikethrough.
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" aria-label="Close">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        <div className="relative flex-1 overflow-auto p-6">
          {loading && (
            <div className="flex items-center justify-center py-10 text-sm text-gray-500 gap-2">
              Loading column lineage…
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
                  <SectionHeader label="Upstream" count={upstreamModels.length} sub={`${totalUpEdges} edge${totalUpEdges === 1 ? '' : 's'}`} align="left" />
                  {upstreamModels.length === 0 && <EmptyHint text="No upstream column edges detected." />}
                  {upstreamModels.map((u) => (
                    <ModelBlock
                      key={u.uid}
                      title={u.uid.replace(/^(model|source|seed|snapshot)\./, '')}
                      columns={u.columns}
                      accent="border-emerald-200 bg-emerald-50/40"
                      side="right"
                      colRef={(col, el) => colRefs.current.set(`up:${u.uid}:${col}`, el)}
                      annotate={(col) => (u.edgesByCol.has(col) ? null : 'dropped')}
                    />
                  ))}
                </div>
                {/* This model */}
                <div>
                  <SectionHeader label={modelName} count={1} sub={`${thisColumns.length} col${thisColumns.length === 1 ? '' : 's'}`} align="center" />
                  {thisColumns.length === 0 && <EmptyHint text="No columns known — run dbt docs generate to populate the catalog." />}
                  <ModelBlock
                    title={modelName}
                    columns={thisColumns}
                    accent="border-primary/30 bg-primary/5"
                    side="both"
                    colRef={(col, el) => colRefs.current.set(`this:${col}`, el)}
                    annotate={(col) => {
                      // Derived: no incoming edge points at this column.
                      const hasIncoming = data.edges.some((e) => e.to_unique_id === modelUniqueId && e.to_column === col);
                      const isSource = modelUniqueId.startsWith('source.');
                      return hasIncoming || isSource ? null : 'derived';
                    }}
                  />
                </div>
                {/* Downstream */}
                <div>
                  <SectionHeader label="Downstream" count={downstreamModels.length} sub={`${totalDownEdges} edge${totalDownEdges === 1 ? '' : 's'}`} align="right" />
                  {downstreamModels.length === 0 && <EmptyHint text="No downstream column edges detected." />}
                  {downstreamModels.map((d) => (
                    <ModelBlock
                      key={d.uid}
                      title={d.uid.replace(/^(model|source|seed|snapshot)\./, '')}
                      columns={d.columns}
                      accent="border-blue-200 bg-blue-50/40"
                      side="left"
                      colRef={(col, el) => colRefs.current.set(`down:${d.uid}:${col}`, el)}
                      annotate={(col) => (d.edgesByCol.has(col) ? null : 'derived-here')}
                    />
                  ))}
                </div>

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

              <div className="mt-6 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
                <span>{totalUpEdges + totalDownEdges} column edges</span>
                <span className="ml-auto">Solid = name-match · faded = SQL-scan guess</span>
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

function ModelBlock({
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
                <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-700" title="No matching upstream column — likely derived here.">
                  <Sparkles className="w-2.5 h-2.5" /> derived
                </span>
              )}
              {isDerivedHere && (
                <span className="inline-flex items-center gap-0.5 text-[9px] text-blue-700" title="No matching source column — added downstream.">
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
