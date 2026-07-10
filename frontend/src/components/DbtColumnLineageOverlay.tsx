import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Sparkles, ArrowRight } from 'lucide-react';
import { projectsApi } from '@/services/api';

interface DbtColumnLineageOverlayProps {
  projectId: string;
  dbtRelativePath: string;
  modelUniqueId: string;
  modelName: string;
  onClose: () => void;
  /** Called when the user clicks a neighboring model card — re-scope
   *  the overlay to that model as the new focal. */
  onFocalChange?: (uniqueId: string) => void;
  /** Called when the user clicks "Open in drawer" on a model — jumps
   *  to that model in the underlying Models view. */
  onOpenModel?: (uniqueId: string) => void;
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
  onFocalChange,
  onOpenModel,
}: DbtColumnLineageOverlayProps) {
  // Highlighted column — when non-null we fade every connector that
  // doesn't touch it. Clicking a column row toggles this.
  const [hlColumn, setHlColumn] = useState<{ uid: string; col: string } | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof projectsApi.getDbtColumnLineage>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const colRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [connectorPaths, setConnectorPaths] = useState<Array<{ d: string; confidence: number; className: string; touchesHl: boolean }>>([]);

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

  // Group edges around the focal model. Guard against empty column
  // names — the backend can emit `""` when it knows there's a
  // structural dep but couldn't identify a specific column (e.g. no
  // catalog data yet). Empty names would render as blank rows and
  // collapse every unrelated edge onto the same point, so we drop
  // them cleanly here.
  const isRealCol = (s: string | null | undefined): s is string => {
    if (!s) return false;
    const t = s.trim();
    // Backend emits '?' when it knows an edge exists but can't
    // resolve a specific column (e.g. `select *` upstream). We treat
    // those as non-columns so they don't pollute the render + collapse
    // unrelated edges onto the same anchor point.
    return t.length > 0 && t !== '?';
  };

  const { incoming, outgoing, thisColumns } = useMemo(() => {
    if (!data) return { incoming: new Map<string, Array<{ from_uid: string; from_col: string; confidence: number }>>(), outgoing: new Map<string, Array<{ to_uid: string; to_col: string; confidence: number }>>(), thisColumns: [] as string[] };
    const inc = new Map<string, Array<{ from_uid: string; from_col: string; confidence: number }>>();
    const out = new Map<string, Array<{ to_uid: string; to_col: string; confidence: number }>>();
    const cols = new Set<string>((data.columns_by_model[modelUniqueId] ?? []).filter(isRealCol));
    for (const e of data.edges) {
      if (!isRealCol(e.from_column) || !isRealCol(e.to_column)) continue;
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
  // touch the focal model? We render all real columns but fade the
  // ones without an edge so users see "dropped" columns as well.
  const upstreamModels = useMemo(() => {
    if (!data) return [] as Array<{ uid: string; columns: string[]; edgesByCol: Map<string, number> }>;
    return Array.from(incoming.keys()).map((uid) => {
      const cols = (data.columns_by_model[uid] ?? []).filter(isRealCol);
      const edgesByCol = new Map<string, number>();
      for (const e of incoming.get(uid) ?? []) {
        if (!isRealCol(e.from_col)) continue;
        edgesByCol.set(e.from_col, Math.max(edgesByCol.get(e.from_col) ?? 0, e.confidence));
        if (!cols.includes(e.from_col)) cols.push(e.from_col);
      }
      return { uid, columns: cols.slice().sort(), edgesByCol };
    });
  }, [data, incoming]);
  const downstreamModels = useMemo(() => {
    if (!data) return [] as Array<{ uid: string; columns: string[]; edgesByCol: Map<string, number> }>;
    return Array.from(outgoing.keys()).map((uid) => {
      const cols = (data.columns_by_model[uid] ?? []).filter(isRealCol);
      const edgesByCol = new Map<string, number>();
      for (const e of outgoing.get(uid) ?? []) {
        if (!isRealCol(e.to_col)) continue;
        edgesByCol.set(e.to_col, Math.max(edgesByCol.get(e.to_col) ?? 0, e.confidence));
        if (!cols.includes(e.to_col)) cols.push(e.to_col);
      }
      return { uid, columns: cols.slice().sort(), edgesByCol };
    });
  }, [data, outgoing]);

  // Compute SVG connector paths on data change / resize / scroll.
  // We iterate the raw edge list once and only draw edges where both
  // endpoints are real column refs (no '?' / '' pollution).
  const recomputePaths = () => {
    if (!containerRef.current || !data) return;
    const cbox = containerRef.current.getBoundingClientRect();
    const paths: Array<{ d: string; confidence: number; className: string; touchesHl: boolean }> = [];
    const draw = (fromKey: string, toKey: string, confidence: number, cls: string, touchesHl: boolean) => {
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
      paths.push({ d, confidence, className: cls, touchesHl });
    };
    // Highlight semantics: an edge touches the highlight when either
    // endpoint matches. When no highlight is set, everything is
    // considered "touched" so nothing fades.
    const edgeTouches = (uid1: string, col1: string, uid2: string, col2: string) => {
      if (!hlColumn) return true;
      return (hlColumn.uid === uid1 && hlColumn.col === col1)
        || (hlColumn.uid === uid2 && hlColumn.col === col2);
    };
    for (const e of data.edges) {
      if (!isRealCol(e.from_column) || !isRealCol(e.to_column)) continue;
      if (e.to_unique_id === modelUniqueId) {
        const t = edgeTouches(e.from_unique_id, e.from_column, modelUniqueId, e.to_column);
        draw(`up:${e.from_unique_id}:${e.from_column}`, `this:${e.to_column}`, e.confidence, 'stroke-emerald-500', t);
      } else if (e.from_unique_id === modelUniqueId) {
        const t = edgeTouches(modelUniqueId, e.from_column, e.to_unique_id, e.to_column);
        draw(`this:${e.from_column}`, `down:${e.to_unique_id}:${e.to_column}`, e.confidence, 'stroke-blue-500', t);
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
  }, [data, upstreamModels, downstreamModels, hlColumn]);

  const totalUpEdges = useMemo(() => Array.from(incoming.values()).reduce((s, arr) => s + arr.length, 0), [incoming]);
  const totalDownEdges = useMemo(() => Array.from(outgoing.values()).reduce((s, arr) => s + arr.length, 0), [outgoing]);

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/60 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-[1280px] max-w-[98vw] max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        ref={containerRef}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gradient-to-b from-white to-gray-50/50">
          <div>
            <div className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-indigo-600" />
              </div>
              <span>Column lineage</span>
              <span className="text-gray-300">·</span>
              <span className="font-mono text-gray-700 text-sm">{modelName}</span>
            </div>
            <div className="text-xs text-gray-500 mt-1 ml-10">
              Trace where each column comes from and where it flows. Bezier lines show heuristic name matches.
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-400 hover:text-gray-700" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="relative flex-1 overflow-auto bg-gray-50/40">
          {loading && (
            <div className="flex items-center justify-center py-16 text-sm text-gray-500 gap-2">
              Loading column lineage…
            </div>
          )}
          {error && (
            <div className="m-6 p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-800">{error}</div>
          )}
          {data && !loading && !error && (
            <>
              <div className="grid grid-cols-3 gap-10 relative p-8" style={{ minHeight: 320 }}>
                {/* Upstream */}
                <div>
                  <SectionHeader label="Upstream" count={upstreamModels.length} sub={`${totalUpEdges} edge${totalUpEdges === 1 ? '' : 's'}`} align="left" tone="upstream" />
                  {upstreamModels.length === 0 && <EmptyHint text="No upstream column edges detected." />}
                  {upstreamModels.map((u) => (
                    <ModelBlock
                      key={u.uid}
                      uid={u.uid}
                      title={u.uid.replace(/^(model|source|seed|snapshot)\./, '')}
                      subtitle={u.uid.startsWith('source.') ? 'source' : u.uid.startsWith('seed.') ? 'seed' : 'model'}
                      columns={u.columns}
                      tone="upstream"
                      side="right"
                      colRef={(col, el) => colRefs.current.set(`up:${u.uid}:${col}`, el)}
                      annotate={(col) => (u.edgesByCol.has(col) ? null : 'dropped')}
                      onModelClick={u.uid.startsWith('model.') ? () => onFocalChange?.(u.uid) : undefined}
                      onColumnClick={(col) => setHlColumn(hlColumn?.uid === u.uid && hlColumn?.col === col ? null : { uid: u.uid, col })}
                      hlColumn={hlColumn}
                    />
                  ))}
                </div>
                {/* This model */}
                <div>
                  <SectionHeader label={modelName} count={1} sub={`${thisColumns.length} col${thisColumns.length === 1 ? '' : 's'}`} align="center" tone="focal" />
                  {thisColumns.length === 0 && <EmptyHint text="No columns known — run dbt docs generate to populate the catalog." />}
                  <ModelBlock
                    uid={modelUniqueId}
                    title={modelName}
                    subtitle="this model"
                    columns={thisColumns}
                    tone="focal"
                    side="both"
                    colRef={(col, el) => colRefs.current.set(`this:${col}`, el)}
                    annotate={(col) => {
                      const hasIncoming = data.edges.some((e) => e.to_unique_id === modelUniqueId && e.to_column === col);
                      const isSource = modelUniqueId.startsWith('source.');
                      return hasIncoming || isSource ? null : 'derived';
                    }}
                    onOpenClick={onOpenModel ? () => onOpenModel(modelUniqueId) : undefined}
                    onColumnClick={(col) => setHlColumn(hlColumn?.uid === modelUniqueId && hlColumn?.col === col ? null : { uid: modelUniqueId, col })}
                    hlColumn={hlColumn}
                  />
                </div>
                {/* Downstream */}
                <div>
                  <SectionHeader label="Downstream" count={downstreamModels.length} sub={`${totalDownEdges} edge${totalDownEdges === 1 ? '' : 's'}`} align="right" tone="downstream" />
                  {downstreamModels.length === 0 && <EmptyHint text="No downstream column edges detected." />}
                  {downstreamModels.map((d) => (
                    <ModelBlock
                      key={d.uid}
                      uid={d.uid}
                      title={d.uid.replace(/^(model|source|seed|snapshot)\./, '')}
                      subtitle={d.uid.startsWith('source.') ? 'source' : d.uid.startsWith('seed.') ? 'seed' : 'model'}
                      columns={d.columns}
                      tone="downstream"
                      side="left"
                      colRef={(col, el) => colRefs.current.set(`down:${d.uid}:${col}`, el)}
                      annotate={(col) => (d.edgesByCol.has(col) ? null : 'derived-here')}
                      onModelClick={d.uid.startsWith('model.') ? () => onFocalChange?.(d.uid) : undefined}
                      onColumnClick={(col) => setHlColumn(hlColumn?.uid === d.uid && hlColumn?.col === col ? null : { uid: d.uid, col })}
                      hlColumn={hlColumn}
                    />
                  ))}
                </div>

                {/* SVG connectors — overlaid across the whole grid so
                    they cross columns freely. Larger stroke + soft
                    shadow makes them read as lines, not scratches. */}
                <svg
                  className="absolute inset-0 pointer-events-none"
                  width="100%"
                  height="100%"
                  style={{ overflow: 'visible' }}
                >
                  <defs>
                    <filter id="line-shadow" x="-10%" y="-10%" width="120%" height="120%">
                      <feDropShadow dx="0" dy="1" stdDeviation="0.5" floodColor="#94a3b8" floodOpacity="0.25" />
                    </filter>
                  </defs>
                  {connectorPaths.map((p, i) => (
                    <path
                      key={i}
                      d={p.d}
                      fill="none"
                      strokeWidth={p.touchesHl ? 2 : 1.75}
                      strokeLinecap="round"
                      className={p.className}
                      filter="url(#line-shadow)"
                      style={{ opacity: p.touchesHl ? 0.45 + p.confidence * 0.5 : 0.08 }}
                    />
                  ))}
                </svg>
              </div>

              {/* Footer legend + click hints */}
              <div className="px-8 py-3 border-t border-gray-100 bg-white flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-emerald-500 rounded" /> upstream edge
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-0.5 bg-blue-500 rounded" /> downstream edge
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-amber-500" /> derived here
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-gray-400 line-through font-mono">dropped</span> not carried through
                </span>
                {hlColumn && (
                  <button
                    onClick={() => setHlColumn(null)}
                    className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium"
                  >
                    Clear highlight
                  </button>
                )}
                <span className="ml-auto">
                  Tip: click a model card to refocus · click a column to highlight edges
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type Tone = 'upstream' | 'downstream' | 'focal';

const TONE_STYLES: Record<Tone, { headerText: string; headerBar: string; card: string; dot: string; subtitle: string }> = {
  upstream: {
    headerText: 'text-emerald-700',
    headerBar: 'bg-emerald-500',
    card: 'border-gray-200 bg-white',
    dot: 'bg-emerald-500',
    subtitle: 'text-emerald-600',
  },
  downstream: {
    headerText: 'text-blue-700',
    headerBar: 'bg-blue-500',
    card: 'border-gray-200 bg-white',
    dot: 'bg-blue-500',
    subtitle: 'text-blue-600',
  },
  focal: {
    headerText: 'text-indigo-700',
    headerBar: 'bg-indigo-500',
    card: 'border-indigo-200 bg-indigo-50/30 ring-1 ring-indigo-100',
    dot: 'bg-indigo-500',
    subtitle: 'text-indigo-600',
  },
};

function SectionHeader({ label, count, sub, align, tone }: { label: string; count: number; sub: string; align: 'left' | 'center' | 'right'; tone: Tone }) {
  const styles = TONE_STYLES[tone];
  return (
    <div className={`mb-3 flex items-center gap-2 ${
      align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : ''
    }`}>
      <div className={`w-1 h-4 rounded-full ${styles.headerBar}`} />
      <div className="min-w-0">
        <div className={`text-xs font-bold uppercase tracking-wider ${styles.headerText} truncate`}>{label}</div>
        <div className="text-[10px] text-gray-400">{sub} · {count} model{count === 1 ? '' : 's'}</div>
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="p-4 border border-dashed border-gray-200 rounded-lg text-[11px] text-gray-500 text-center bg-white">{text}</div>;
}

function ModelBlock({
  uid,
  title,
  subtitle,
  columns,
  tone,
  side,
  colRef,
  annotate,
  onModelClick,
  onOpenClick,
  onColumnClick,
  hlColumn,
}: {
  uid: string;
  title: string;
  subtitle: string;
  columns: string[];
  tone: Tone;
  side: 'left' | 'right' | 'both';
  colRef: (col: string, el: HTMLDivElement | null) => void;
  annotate?: (col: string) => 'dropped' | 'derived' | 'derived-here' | null;
  /** Click the header → refocus the overlay on this model. */
  onModelClick?: () => void;
  /** Click the "Open" button → open this model in the underlying drawer. */
  onOpenClick?: () => void;
  /** Click a column row → toggle highlight of edges touching it. */
  onColumnClick?: (col: string) => void;
  /** Currently highlighted column (across the whole overlay) so this
   *  block can style its own rows accordingly. */
  hlColumn?: { uid: string; col: string } | null;
}) {
  const styles = TONE_STYLES[tone];
  const headerClickable = !!onModelClick;
  return (
    <div className={`rounded-lg border ${styles.card} shadow-sm mb-3 overflow-hidden transition-shadow ${headerClickable ? 'hover:shadow-md' : ''}`}>
      {/* Card header — clickable to refocus the overlay onto this model
          when it's a real model (not a source/seed). */}
      <div
        className={`px-3 py-2 border-b border-gray-100 flex items-baseline justify-between gap-2 bg-gradient-to-b from-white to-gray-50/40 ${headerClickable ? 'cursor-pointer' : ''}`}
        onClick={headerClickable ? onModelClick : undefined}
        title={headerClickable ? 'Click to refocus column lineage on this model' : undefined}
      >
        <div className="min-w-0">
          <div className="text-xs font-mono font-semibold text-gray-900 truncate flex items-center gap-1" title={title}>
            {title}
            {headerClickable && <ArrowRight className="w-3 h-3 text-gray-400" />}
          </div>
          <div className={`text-[9px] uppercase tracking-wider ${styles.subtitle} font-medium`}>{subtitle}</div>
        </div>
        {onOpenClick ? (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenClick(); }}
            className="text-[10px] text-gray-500 hover:text-gray-900 font-medium underline decoration-dotted"
            title="Open in Models drawer"
          >
            open →
          </button>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full ${styles.dot} flex-shrink-0`} />
        )}
      </div>
      {/* Columns */}
      <div className="py-1">
        {columns.length === 0 && (
          <div className="px-3 py-2 text-[10px] text-gray-400 italic">no columns known</div>
        )}
        {columns.map((col) => {
          const note = annotate?.(col) ?? null;
          const isDropped = note === 'dropped';
          const isDerived = note === 'derived';
          const isDerivedHere = note === 'derived-here';
          const isHl = !!(hlColumn && hlColumn.uid === uid && hlColumn.col === col);
          const isFaded = !!(hlColumn && !isHl);
          return (
            <div
              key={col}
              ref={(el) => colRef(col, el)}
              onClick={onColumnClick ? () => onColumnClick(col) : undefined}
              className={`group flex items-center gap-1.5 px-3 py-1 text-[11px] transition-opacity ${
                isDropped ? 'text-gray-400' : 'text-gray-800'
              } ${isHl ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-gray-50'} ${
                isFaded ? 'opacity-40' : ''
              } ${onColumnClick ? 'cursor-pointer' : ''}`}
              title={onColumnClick ? 'Click to highlight edges touching this column' : undefined}
            >
              {side === 'left' && <span className={`w-1.5 h-1.5 rounded-full ${isDropped ? 'bg-gray-300' : styles.dot} flex-shrink-0`} />}
              {side === 'both' && <span className={`w-1.5 h-1.5 rounded-full ${styles.dot} flex-shrink-0`} />}
              <span className={`font-mono truncate flex-1 ${isDropped ? 'line-through' : ''}`} title={col}>{col}</span>
              {isDerived && (
                <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-600 font-medium flex-shrink-0" title="No matching upstream column — likely derived here.">
                  <Sparkles className="w-2.5 h-2.5" /> derived
                </span>
              )}
              {isDerivedHere && (
                <span className="inline-flex items-center gap-0.5 text-[9px] text-blue-600 font-medium flex-shrink-0" title="No matching source column — added downstream.">
                  <ArrowRight className="w-2.5 h-2.5" /> new
                </span>
              )}
              {(side === 'right' || side === 'both') && <span className={`w-1.5 h-1.5 rounded-full ${isDropped ? 'bg-gray-300' : styles.dot} flex-shrink-0`} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
