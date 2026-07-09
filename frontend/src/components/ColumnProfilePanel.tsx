import { useMemo } from 'react';
import { ColumnProfileStrip } from './ColumnProfileStrip';

interface ColumnProfilePanelProps {
  rows: Array<Record<string, any>>;
  columns: string[];
  dtypes?: Record<string, string>;
  /** Total rows the asset has, from the backend. Used to show
   *  "profiled N of M rows" so users know when the sample is partial. */
  totalRows?: number;
}

/**
 * Full column-profile view — one card per column with the rich profile
 * widget from ColumnProfileStrip (histograms, top-N bars, boolean split)
 * plus percentile rows for numerics and simple health warnings.
 *
 * Computed client-side over the loaded preview rows, so bumping the sample
 * size in the modal directly translates to more accurate distributions.
 */
export function ColumnProfilePanel({ rows, columns, dtypes, totalRows }: ColumnProfilePanelProps) {
  const sampled = rows.length;
  const partial = totalRows !== undefined && totalRows > sampled;

  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Column profiles</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {sampled.toLocaleString()} rows
            {partial && (
              <> · <span className="text-amber-600">sampled from {totalRows!.toLocaleString()}</span></>
            )}
            {' · '}
            {columns.length} columns
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {columns.map((col) => (
          <ColumnCard
            key={col}
            rows={rows}
            column={col}
            dtype={dtypes?.[col]}
            totalRows={totalRows ?? sampled}
          />
        ))}
      </div>
    </div>
  );
}

function ColumnCard({
  rows,
  column,
  dtype,
  totalRows,
}: {
  rows: Array<Record<string, any>>;
  column: string;
  dtype?: string;
  totalRows: number;
}) {
  // Extra stats on top of what ColumnProfileStrip renders — percentiles for
  // numerics, warning flags for high-cardinality / mostly-null cols.
  const extras = useMemo(() => computeExtras(rows, column, dtype), [rows, column, dtype]);

  return (
    <div className="border border-gray-200 rounded-lg bg-white p-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2 min-w-0">
        <div className="font-mono text-sm text-gray-900 truncate" title={column}>{column}</div>
        {dtype && (
          <div className="text-[10px] text-gray-500 flex-shrink-0 uppercase tracking-wide">{dtype}</div>
        )}
      </div>

      <ColumnProfileStrip rows={rows} column={column} dtype={dtype} />

      {extras.percentiles && (
        <div className="mt-1 pt-2 border-t border-gray-100 grid grid-cols-5 gap-2 text-[10px]">
          {(['p25', 'p50', 'p75', 'p90', 'p99'] as const).map((key) => (
            <div key={key} className="flex flex-col">
              <span className="text-gray-400 uppercase">{key}</span>
              <span className="font-mono text-gray-700 truncate" title={String(extras.percentiles![key])}>
                {formatNum(extras.percentiles![key])}
              </span>
            </div>
          ))}
        </div>
      )}

      {extras.warnings.length > 0 && (
        <div className="mt-1 pt-2 border-t border-gray-100 space-y-0.5">
          {extras.warnings.map((w, i) => (
            <div key={i} className="text-[10px] text-amber-700 flex items-start gap-1">
              <span className="flex-shrink-0">⚠</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10px] text-gray-400 mt-auto pt-1">
        based on {rows.length.toLocaleString()} rows
        {totalRows > rows.length && ` of ${totalRows.toLocaleString()}`}
      </div>
    </div>
  );
}

interface Extras {
  percentiles?: { p25: number; p50: number; p75: number; p90: number; p99: number };
  warnings: string[];
}

function computeExtras(rows: Array<Record<string, any>>, column: string, dtypeHint?: string): Extras {
  const warnings: string[] = [];
  let nonNull = 0;
  const numeric: number[] = [];
  const hint = (dtypeHint || '').toLowerCase();
  const isNumericDtype = /int|float|numeric|double|decimal|number/.test(hint);

  for (const r of rows) {
    const v = r[column];
    if (v === null || v === undefined || v === '') continue;
    nonNull++;
    if (isNumericDtype || typeof v === 'number') {
      const n = Number(v);
      if (isFinite(n)) numeric.push(n);
    } else if (!isNumericDtype && !isNaN(Number(v))) {
      // Values are numeric-looking despite a non-numeric dtype hint — still
      // collect them so string columns of digits get percentiles too.
      const n = Number(v);
      if (isFinite(n)) numeric.push(n);
    }
  }

  const total = rows.length;
  const nullFrac = total > 0 ? (total - nonNull) / total : 0;
  if (nullFrac >= 0.5 && total > 0) {
    warnings.push(`${Math.round(nullFrac * 100)}% of values are null.`);
  }

  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[column];
    if (v !== null && v !== undefined && v !== '') seen.add(String(v));
  }
  const distinctFrac = total > 0 ? seen.size / total : 0;
  if (distinctFrac >= 0.95 && total > 20) {
    warnings.push(`Nearly unique (${seen.size} distinct in ${total} rows) — likely an ID.`);
  } else if (distinctFrac <= 0.02 && total > 20 && seen.size > 0) {
    warnings.push(`Only ${seen.size} distinct value(s) across ${total} rows.`);
  }

  let percentiles: Extras['percentiles'] | undefined;
  if (numeric.length >= 5) {
    const sorted = [...numeric].sort((a, b) => a - b);
    percentiles = {
      p25: quantile(sorted, 0.25),
      p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p90: quantile(sorted, 0.9),
      p99: quantile(sorted, 0.99),
    };
  }

  return { percentiles, warnings };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function formatNum(n: number): string {
  if (!isFinite(n)) return String(n);
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2);
}
