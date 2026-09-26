/**
 * KPI cards + a per-bucket activity trend chart -- extracted out of
 * IngestionsPanel so ActivatePanel (and any future fleet-status page)
 * can show the same "state of your X" band instead of a bare status
 * table. Pure SVG trend chart, no charting lib.
 */
export function KpiCard({
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
// failures, with a rows-ingested (or synced) area behind.
export function TrendChart({
  trend,
  window,
  title = 'Ingestion activity',
  rowsLegendLabel = 'rows',
  emptyHint = 'Materialize or preview a source to start populating this chart.',
}: {
  trend: { buckets: Array<{ t: number; success: number; failure: number; rows: number }>; bucketMs: number; bucketCount: number };
  window: '24h' | '7d' | '30d';
  title?: string;
  rowsLegendLabel?: string;
  emptyHint?: string;
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
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {window === '24h' ? 'Hourly' : 'Daily'} runs + {rowsLegendLabel} across all sources
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-gray-500">
          <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-emerald-400 rounded-sm" /> success</div>
          <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-rose-400 rounded-sm" /> failure</div>
          <div className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-blue-400/60 rounded-sm" /> {rowsLegendLabel}</div>
        </div>
      </div>
      {!anyActivity ? (
        <div className="py-8 text-center text-xs text-gray-400">
          No activity yet in the last {window}. {emptyHint}
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-40">
            {/* rows line */}
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
                    {new Date(b.t).toLocaleString()} · {b.success} success · {b.failure} failure · {b.rows.toLocaleString()} {rowsLegendLabel}
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

export function formatCompact(n: number): string {
  if (!isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
