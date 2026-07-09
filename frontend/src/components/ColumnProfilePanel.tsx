import { useMemo, useState } from 'react';

interface ColumnProfilePanelProps {
  rows: Array<Record<string, any>>;
  columns: string[];
  dtypes?: Record<string, string>;
  /** Total rows the asset has, from the backend. Used to show
   *  "profiled N of M rows" so users know when the sample is partial. */
  totalRows?: number;
}

/**
 * Pandas-profiling / ydata-profiling style column profile panel.
 * One horizontal row per column with: type badge + flags on the left,
 * two columns of stats (distinct/missing/infinite/mean/min/max/zeros/negative),
 * a big histogram on the right, and Toggle Details for percentiles + top values.
 *
 * All stats are computed client-side over the loaded preview rows, so the
 * caller can bump sample_limit to make the distribution tighter.
 */
export function ColumnProfilePanel({ rows, columns, dtypes, totalRows }: ColumnProfilePanelProps) {
  const sampled = rows.length;
  const partial = totalRows !== undefined && totalRows > sampled;

  return (
    <div className="p-4 overflow-y-auto h-full bg-gray-50">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Column profiles</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {partial ? (
              <>
                Profiled {sampled.toLocaleString()} of{' '}
                <span className="text-amber-600">
                  {totalRows!.toLocaleString()} rows
                </span>{' '}
                <span className="text-amber-600">(sampled)</span>
              </>
            ) : totalRows !== undefined ? (
              <>Profiled {sampled.toLocaleString()} rows (full table)</>
            ) : (
              <>Profiled {sampled.toLocaleString()} rows</>
            )}
            {' · '}
            {columns.length} columns
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {columns.map((col) => (
          <ColumnRow key={col} rows={rows} column={col} dtype={dtypes?.[col]} />
        ))}
      </div>
    </div>
  );
}

interface Profile {
  total: number;
  nonNull: number;
  missing: number;
  distinct: number;
  distinctFrac: number;
  missingFrac: number;
  infinite: number;
  infiniteFrac: number;
  kind: 'numeric' | 'string' | 'boolean' | 'date' | 'null';
  unique: boolean;
  // Numeric
  min?: number;
  max?: number;
  mean?: number;
  zeros?: number;
  zerosFrac?: number;
  negative?: number;
  negativeFrac?: number;
  histogram?: number[];
  percentiles?: { p5: number; p25: number; p50: number; p75: number; p95: number };
  // Categorical
  topValues?: Array<{ value: string; count: number; frac: number }>;
  // Boolean
  trueCount?: number;
  falseCount?: number;
  // Best-effort
  memoryBytes?: number;
}

function ColumnRow({
  rows,
  column,
  dtype,
}: {
  rows: Array<Record<string, any>>;
  column: string;
  dtype?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const profile = useMemo(() => computeProfile(rows, column, dtype), [rows, column, dtype]);
  const typeLabel = describeType(profile.kind, dtype);

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden">
      <div className="grid grid-cols-12 gap-3 p-4">
        {/* Column identity + type badge + flags */}
        <div className="col-span-12 md:col-span-3 flex flex-col gap-1.5 min-w-0">
          <div className="font-mono text-base font-semibold text-gray-900 truncate" title={column}>
            {column}
          </div>
          <div className="text-xs text-gray-500">{typeLabel}</div>
          <div className="flex flex-wrap gap-1 mt-1">
            {profile.unique && (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-rose-50 text-rose-700 border border-rose-200 px-1.5 py-0.5 rounded">
                Unique
              </span>
            )}
            {profile.missingFrac >= 0.5 && (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded">
                Mostly missing
              </span>
            )}
            {profile.kind === 'numeric' && (profile.zerosFrac ?? 0) >= 0.5 && (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-gray-100 text-gray-700 border border-gray-200 px-1.5 py-0.5 rounded">
                Mostly zero
              </span>
            )}
            {profile.distinct === 1 && profile.total > 1 && (
              <span className="text-[10px] font-semibold uppercase tracking-wide bg-gray-100 text-gray-700 border border-gray-200 px-1.5 py-0.5 rounded">
                Constant
              </span>
            )}
          </div>
        </div>

        {/* Two columns of statistics — matches the pandas-profiling layout */}
        <div className="col-span-12 md:col-span-3">
          <StatsList
            rows={[
              { label: 'Distinct', value: fmtInt(profile.distinct), emphasize: true },
              { label: 'Distinct (%)', value: fmtPct(profile.distinctFrac), emphasize: true },
              { label: 'Missing', value: fmtInt(profile.missing) },
              { label: 'Missing (%)', value: fmtPct(profile.missingFrac) },
              { label: 'Infinite', value: fmtInt(profile.infinite) },
              { label: 'Infinite (%)', value: fmtPct(profile.infiniteFrac) },
              ...(profile.kind === 'numeric'
                ? [{ label: 'Mean', value: fmtNum(profile.mean) }]
                : []),
            ]}
          />
        </div>

        <div className="col-span-12 md:col-span-3">
          <StatsList
            rows={[
              ...(profile.kind === 'numeric'
                ? [
                    { label: 'Minimum', value: fmtNum(profile.min) },
                    { label: 'Maximum', value: fmtNum(profile.max) },
                    { label: 'Zeros', value: fmtInt(profile.zeros ?? 0) },
                    { label: 'Zeros (%)', value: fmtPct(profile.zerosFrac ?? 0) },
                    { label: 'Negative', value: fmtInt(profile.negative ?? 0) },
                    { label: 'Negative (%)', value: fmtPct(profile.negativeFrac ?? 0) },
                  ]
                : profile.kind === 'boolean'
                ? [
                    { label: 'True', value: fmtInt(profile.trueCount ?? 0) },
                    { label: 'True (%)', value: fmtPct((profile.trueCount ?? 0) / Math.max(1, profile.nonNull)) },
                    { label: 'False', value: fmtInt(profile.falseCount ?? 0) },
                    { label: 'False (%)', value: fmtPct((profile.falseCount ?? 0) / Math.max(1, profile.nonNull)) },
                  ]
                : [
                    { label: 'Non-null', value: fmtInt(profile.nonNull) },
                    ...(profile.topValues && profile.topValues[0]
                      ? [{ label: 'Most common', value: truncate(profile.topValues[0].value, 24) }]
                      : []),
                  ]),
              ...(profile.memoryBytes !== undefined
                ? [{ label: 'Memory size', value: fmtBytes(profile.memoryBytes) }]
                : []),
            ]}
          />
        </div>

        {/* Distribution — histogram for numeric, top-N bars for categorical,
            true/false split for boolean. Bigger than the inline strip so
            the shape reads at a glance. */}
        <div className="col-span-12 md:col-span-3 min-w-0">
          {profile.kind === 'numeric' && profile.histogram && (
            <Histogram bins={profile.histogram} min={profile.min ?? 0} max={profile.max ?? 0} />
          )}
          {(profile.kind === 'string' || profile.kind === 'date') && profile.topValues && profile.topValues.length > 0 && (
            <TopValues values={profile.topValues} />
          )}
          {profile.kind === 'boolean' && (
            <BooleanBars
              trueCount={profile.trueCount ?? 0}
              falseCount={profile.falseCount ?? 0}
              total={profile.total}
            />
          )}
        </div>
      </div>

      {/* Expandable details footer — percentiles + more top values */}
      <div className="border-t border-gray-100 bg-gray-50 px-4 py-2 flex items-center justify-between">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-gray-700 hover:text-gray-900 flex items-center gap-1"
        >
          {expanded ? '▾' : '▸'} Toggle details
        </button>
        <div className="text-[10px] text-gray-400">
          based on {profile.total.toLocaleString()} sampled rows
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 bg-white grid grid-cols-1 md:grid-cols-2 gap-4">
          {profile.percentiles && (
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-2">Percentiles</div>
              <div className="grid grid-cols-5 gap-2 text-xs">
                {(['p5', 'p25', 'p50', 'p75', 'p95'] as const).map((k) => (
                  <div key={k} className="flex flex-col">
                    <span className="text-[10px] uppercase text-gray-400">{k}</span>
                    <span className="font-mono text-gray-800">{fmtNum(profile.percentiles![k])}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {profile.topValues && profile.topValues.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-700 mb-2">Top values</div>
              <div className="space-y-1">
                {profile.topValues.slice(0, 10).map((v, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-gray-700 flex-shrink-0 truncate max-w-[180px]" title={v.value}>
                      {truncate(v.value, 32)}
                    </span>
                    <div className="flex-1 h-1.5 bg-gray-100 rounded overflow-hidden">
                      <div
                        className="h-full bg-primary/50"
                        style={{ width: `${Math.min(100, v.frac * 100)}%` }}
                      />
                    </div>
                    <span className="text-gray-500 tabular-nums w-14 text-right">
                      {v.count} ({fmtPct(v.frac)})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Sub-components ------------------------------------------------

function StatsList({ rows }: { rows: Array<{ label: string; value: string; emphasize?: boolean }> }) {
  return (
    <div className="space-y-0.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-2 gap-1 items-baseline">
          <div className={`text-[11px] ${r.emphasize ? 'font-semibold text-rose-700' : 'text-gray-600'}`}>
            {r.label}
          </div>
          <div className={`text-xs font-mono ${r.emphasize ? 'text-gray-900' : 'text-gray-800'} tabular-nums truncate`} title={r.value}>
            {r.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function Histogram({ bins, min, max }: { bins: number[]; min: number; max: number }) {
  const maxCount = Math.max(...bins, 1);
  return (
    <div className="w-full">
      <div className="flex items-end gap-[1px] h-16" title={`Distribution over ${min} → ${max}`}>
        {bins.map((c, i) => (
          <div
            key={i}
            className="flex-1 bg-primary/60 rounded-t-sm min-w-[2px]"
            style={{ height: `${Math.max(2, (c / maxCount) * 100)}%` }}
            title={`${c}`}
          />
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-gray-400 mt-1 tabular-nums">
        <span>{fmtNum(min)}</span>
        <span>{fmtNum(max)}</span>
      </div>
    </div>
  );
}

function TopValues({ values }: { values: Array<{ value: string; count: number; frac: number }> }) {
  return (
    <div className="space-y-1">
      {values.slice(0, 5).map((v, i) => (
        <div key={i} className="flex items-center gap-1 text-[10px]">
          <div className="w-20 flex-shrink-0 truncate text-gray-600 font-mono" title={v.value}>
            {truncate(v.value, 14)}
          </div>
          <div className="flex-1 h-2 bg-gray-100 rounded-sm overflow-hidden">
            <div className="h-full bg-primary/50" style={{ width: `${Math.min(100, v.frac * 100)}%` }} />
          </div>
          <div className="w-10 text-right text-gray-500 tabular-nums">{fmtPct(v.frac)}</div>
        </div>
      ))}
    </div>
  );
}

function BooleanBars({ trueCount, falseCount, total }: { trueCount: number; falseCount: number; total: number }) {
  const tPct = total > 0 ? (trueCount / total) * 100 : 0;
  const fPct = total > 0 ? (falseCount / total) * 100 : 0;
  return (
    <div className="w-full">
      <div className="flex items-center gap-1 text-[10px] mb-1">
        <span className="text-emerald-600 tabular-nums">true {Math.round(tPct)}%</span>
        <span className="ml-auto text-rose-600 tabular-nums">false {Math.round(fPct)}%</span>
      </div>
      <div className="h-3 bg-gray-100 rounded overflow-hidden flex">
        <div className="bg-emerald-400" style={{ width: `${tPct}%` }} />
        <div className="bg-rose-400" style={{ width: `${fPct}%` }} />
      </div>
    </div>
  );
}

// --- Profile computation -------------------------------------------

function computeProfile(rows: Array<Record<string, any>>, column: string, dtypeHint?: string): Profile {
  const total = rows.length;
  const values: any[] = [];
  const numericValues: number[] = [];
  const seen = new Map<string, number>();

  let nonNull = 0;
  let missing = 0;
  let infinite = 0;
  let zeros = 0;
  let negative = 0;
  let trueCount = 0;
  let falseCount = 0;
  let memoryBytes = 0;

  const hint = (dtypeHint || '').toLowerCase();
  const isNumericHint = /int|float|numeric|double|decimal|number/.test(hint);
  const isBoolHint = /bool/.test(hint);
  const isDateHint = /date|time|timestamp/.test(hint);

  for (const row of rows) {
    const v = row[column];
    if (v === null || v === undefined || v === '') {
      missing++;
      continue;
    }
    nonNull++;
    values.push(v);
    // Rough memory estimate — pandas-profiling reports 8 bytes per numeric
    // cell and len(str) per string cell. Not exact, useful as a signal.
    memoryBytes += typeof v === 'string' ? v.length : 8;
    const key = String(v);
    seen.set(key, (seen.get(key) ?? 0) + 1);

    if (isNumericHint || (!isBoolHint && !isDateHint && typeof v === 'number')) {
      const n = Number(v);
      if (!isFinite(n)) {
        infinite++;
      } else {
        numericValues.push(n);
        if (n === 0) zeros++;
        if (n < 0) negative++;
      }
    } else if (isBoolHint || typeof v === 'boolean') {
      if (v === true || String(v).toLowerCase() === 'true') trueCount++;
      else if (v === false || String(v).toLowerCase() === 'false') falseCount++;
    }
  }

  const distinct = seen.size;
  const missingFrac = total > 0 ? missing / total : 0;
  const distinctFrac = total > 0 ? distinct / total : 0;
  const infiniteFrac = total > 0 ? infinite / total : 0;

  const kind: Profile['kind'] = classify(values, dtypeHint);
  const unique = distinct === nonNull && nonNull > 1;

  const base: Profile = {
    total,
    nonNull,
    missing,
    distinct,
    distinctFrac,
    missingFrac,
    infinite,
    infiniteFrac,
    kind,
    unique,
    memoryBytes,
  };

  if (kind === 'numeric' && numericValues.length > 0) {
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
    base.min = min;
    base.max = max;
    base.mean = mean;
    base.zeros = zeros;
    base.zerosFrac = total > 0 ? zeros / total : 0;
    base.negative = negative;
    base.negativeFrac = total > 0 ? negative / total : 0;

    const binCount = 30;
    const range = max - min;
    if (range === 0) {
      base.histogram = [numericValues.length];
    } else {
      const hist = new Array(binCount).fill(0);
      for (const n of numericValues) {
        const idx = Math.min(binCount - 1, Math.floor(((n - min) / range) * binCount));
        hist[idx]++;
      }
      base.histogram = hist;
    }

    if (numericValues.length >= 5) {
      const sorted = [...numericValues].sort((a, b) => a - b);
      base.percentiles = {
        p5: quantile(sorted, 0.05),
        p25: quantile(sorted, 0.25),
        p50: quantile(sorted, 0.5),
        p75: quantile(sorted, 0.75),
        p95: quantile(sorted, 0.95),
      };
    }
  }

  if (kind === 'boolean') {
    base.trueCount = trueCount;
    base.falseCount = falseCount;
  }

  if (nonNull > 0) {
    const top = Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([value, count]) => ({ value, count, frac: count / nonNull }));
    base.topValues = top;
  }

  return base;
}

function classify(values: any[], dtypeHint?: string): Profile['kind'] {
  if (values.length === 0) return 'null';
  const hint = (dtypeHint || '').toLowerCase();
  if (/int|float|numeric|double|decimal|number/.test(hint)) return 'numeric';
  if (/bool/.test(hint)) return 'boolean';
  if (/date|time|timestamp/.test(hint)) return 'date';
  if (/varchar|string|text|object/.test(hint)) return 'string';

  const sample = values.slice(0, 20);
  const allBool = sample.every((v) => v === true || v === false || v === 'true' || v === 'false');
  if (allBool) return 'boolean';
  const allNumeric = sample.every((v) => typeof v === 'number' || (!isNaN(Number(v)) && v !== ''));
  if (allNumeric) return 'numeric';
  const dateLike = sample.every((v) => typeof v === 'string' && !isNaN(Date.parse(v)));
  if (dateLike) return 'date';
  return 'string';
}

function describeType(kind: Profile['kind'], dtype?: string): string {
  const base = dtype ? dtype.toLowerCase() : '';
  if (kind === 'numeric') {
    if (base.includes('int')) return 'Integer';
    if (base.includes('float') || base.includes('double') || base.includes('decimal')) return 'Real number';
    return 'Numeric';
  }
  if (kind === 'boolean') return 'Boolean';
  if (kind === 'date') return 'Date / Time';
  if (kind === 'string') return 'Categorical / Text';
  return 'Unknown';
}

// --- Formatting helpers --------------------------------------------

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

function fmtPct(frac: number): string {
  if (!isFinite(frac)) return '—';
  return `${(frac * 100).toFixed(1)}%`;
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(3)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  if (Number.isInteger(n)) return n.toString();
  // Show more decimal precision so subtle percentiles aren't misleading.
  return n.toFixed(Math.abs(n) < 1 ? 6 : 3);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
