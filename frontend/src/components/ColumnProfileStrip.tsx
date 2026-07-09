import { useMemo } from 'react';

interface ColumnProfileStripProps {
  rows: Array<Record<string, any>>;
  column: string;
  dtype?: string;
  /** Compact mode = smaller, one line, no histograms. Used in bottom pane. */
  compact?: boolean;
}

interface Profile {
  total: number;
  nonNull: number;
  distinct: number;
  distinctFrac: number;
  nullFrac: number;
  kind: 'numeric' | 'string' | 'boolean' | 'date' | 'null';
  // Numeric fields
  min?: number;
  max?: number;
  mean?: number;
  histogram?: number[]; // bin counts
  // Categorical fields
  topValues?: Array<{ value: string; count: number }>;
  // Boolean
  trueCount?: number;
  falseCount?: number;
}

/**
 * Compact column-profile strip — Alteryx/Trifacta style. Shows nulls, distinct
 * count, and either a mini histogram (numeric) or top values (categorical) so
 * you can glance a column and understand its shape before writing transforms.
 *
 * Everything computed client-side over the loaded preview rows. Cheap for ~100
 * rows, may want to move server-side once we support larger row limits.
 */
export function ColumnProfileStrip({ rows, column, dtype, compact = false }: ColumnProfileStripProps) {
  const profile = useMemo<Profile>(() => computeProfile(rows, column, dtype), [rows, column, dtype]);

  if (profile.total === 0) return null;

  const nullPct = Math.round(profile.nullFrac * 100);
  const distinctPct = Math.round(profile.distinctFrac * 100);

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 text-[9px] text-gray-500 mt-0.5" title={`${profile.total} rows`}>
        <span>{profile.distinct} distinct</span>
        {profile.nullFrac > 0 && (
          <>
            <span>·</span>
            <span className={profile.nullFrac > 0.5 ? 'text-amber-600' : ''}>{nullPct}% null</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-0.5">
      <div className="flex items-center gap-1.5 text-[10px] text-gray-500 flex-wrap">
        <span title={`${profile.nonNull} non-null of ${profile.total}`}>
          <span className={profile.nullFrac > 0.5 ? 'text-amber-600 font-medium' : ''}>{nullPct}%</span> null
        </span>
        <span>·</span>
        <span title={`${profile.distinct} unique values`}>
          {profile.distinct} distinct ({distinctPct}%)
        </span>
        {profile.kind === 'numeric' && profile.min !== undefined && profile.max !== undefined && (
          <>
            <span>·</span>
            <span title={`mean ${profile.mean?.toFixed(2) ?? '?'}`}>
              {formatNum(profile.min)} → {formatNum(profile.max)}
            </span>
          </>
        )}
      </div>

      {/* Distribution row */}
      {profile.kind === 'numeric' && profile.histogram && profile.histogram.length > 0 && (
        <MiniHistogram bins={profile.histogram} />
      )}

      {(profile.kind === 'string' || profile.kind === 'date') && profile.topValues && profile.topValues.length > 0 && (
        <TopValues values={profile.topValues} total={profile.total} />
      )}

      {profile.kind === 'boolean' && (
        <BooleanBars trueCount={profile.trueCount ?? 0} falseCount={profile.falseCount ?? 0} total={profile.total} />
      )}
    </div>
  );
}

function MiniHistogram({ bins }: { bins: number[] }) {
  const max = Math.max(...bins, 1);
  return (
    <div
      className="flex items-end gap-[1px] h-4 mt-0.5"
      title="Distribution — buckets of values across min→max"
    >
      {bins.map((c, i) => (
        <div
          key={i}
          className="flex-1 bg-primary/40 rounded-sm min-w-[2px]"
          style={{ height: `${Math.max(2, (c / max) * 16)}px` }}
          title={`${c}`}
        />
      ))}
    </div>
  );
}

function TopValues({ values, total }: { values: Array<{ value: string; count: number }>; total: number }) {
  const max = values[0]?.count || 1;
  return (
    <div className="space-y-[1px] mt-0.5" title="Top values by frequency">
      {values.slice(0, 3).map((v, i) => (
        <div key={i} className="flex items-center gap-1 text-[9px]">
          <div className="w-14 flex-shrink-0 truncate text-gray-600" title={v.value}>
            {v.value.length > 12 ? v.value.slice(0, 12) + '…' : v.value}
          </div>
          <div className="flex-1 bg-gray-100 rounded-sm h-2 relative overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-primary/40"
              style={{ width: `${Math.min(100, (v.count / max) * 100)}%` }}
            />
          </div>
          <div className="w-8 text-right text-gray-500 tabular-nums">
            {Math.round((v.count / total) * 100)}%
          </div>
        </div>
      ))}
    </div>
  );
}

function BooleanBars({ trueCount, falseCount, total }: { trueCount: number; falseCount: number; total: number }) {
  const tPct = total > 0 ? (trueCount / total) * 100 : 0;
  const fPct = total > 0 ? (falseCount / total) * 100 : 0;
  return (
    <div className="flex items-center gap-1 mt-0.5 text-[9px] text-gray-500">
      <span className="text-emerald-600">true {Math.round(tPct)}%</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-sm overflow-hidden flex">
        <div className="bg-emerald-400" style={{ width: `${tPct}%` }} />
        <div className="bg-rose-400" style={{ width: `${fPct}%` }} />
      </div>
      <span className="text-rose-600">false {Math.round(fPct)}%</span>
    </div>
  );
}

function formatNum(n: number): string {
  if (!isFinite(n)) return String(n);
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}

function computeProfile(rows: Array<Record<string, any>>, column: string, dtypeHint?: string): Profile {
  const total = rows.length;
  let nonNull = 0;
  const values: any[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    const v = row[column];
    if (v === null || v === undefined || v === '') {
      continue;
    }
    nonNull++;
    values.push(v);
    const key = String(v);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const distinct = seen.size;
  const nullFrac = total > 0 ? (total - nonNull) / total : 0;
  const distinctFrac = total > 0 ? distinct / total : 0;

  // Type inference — prefer the backend's dtype hint when available.
  const kind = classify(values, dtypeHint);

  const base: Profile = { total, nonNull, distinct, distinctFrac, nullFrac, kind };

  if (kind === 'numeric') {
    const nums = values.map((v) => Number(v)).filter((n) => isFinite(n));
    if (nums.length === 0) return base;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    base.min = min;
    base.max = max;
    base.mean = mean;
    // Simple 10-bin histogram
    const binCount = 10;
    const range = max - min;
    if (range === 0) {
      base.histogram = [nums.length];
    } else {
      const bins = new Array(binCount).fill(0);
      for (const n of nums) {
        const idx = Math.min(binCount - 1, Math.floor(((n - min) / range) * binCount));
        bins[idx]++;
      }
      base.histogram = bins;
    }
    return base;
  }

  if (kind === 'boolean') {
    let t = 0;
    let f = 0;
    for (const v of values) {
      if (v === true || String(v).toLowerCase() === 'true') t++;
      else if (v === false || String(v).toLowerCase() === 'false') f++;
    }
    base.trueCount = t;
    base.falseCount = f;
    return base;
  }

  // string / date — top values by frequency
  const top = Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));
  base.topValues = top;
  return base;
}

function classify(values: any[], dtypeHint?: string): Profile['kind'] {
  if (values.length === 0) return 'null';
  const hint = (dtypeHint || '').toLowerCase();
  if (/int|float|numeric|double|decimal|number/.test(hint)) return 'numeric';
  if (/bool/.test(hint)) return 'boolean';
  if (/date|time|timestamp/.test(hint)) return 'date';
  if (/varchar|string|text|object/.test(hint)) return 'string';

  // Fall back to a value-based classification for the first few samples.
  const sample = values.slice(0, 20);
  const allBool = sample.every((v) => v === true || v === false || v === 'true' || v === 'false');
  if (allBool) return 'boolean';
  const allNumeric = sample.every((v) => typeof v === 'number' || (!isNaN(Number(v)) && v !== ''));
  if (allNumeric) return 'numeric';
  const dateLike = sample.every((v) => typeof v === 'string' && !isNaN(Date.parse(v)));
  if (dateLike) return 'date';
  return 'string';
}
