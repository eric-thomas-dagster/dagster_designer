import { useEffect, useState } from 'react';
import { Plus, X, Sigma } from 'lucide-react';
import { assetsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

interface AggregateSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
}

const AGG_FUNCS = [
  'sum', 'count', 'mean', 'median', 'min', 'max',
  'first', 'last', 'nunique', 'std', 'var',
] as const;

/**
 * Specialized sidebar for the summarize / warehouse_summarize
 * components. Aggregate = "group_by columns + list of aggregations".
 * Both surfaces users think in — reuses the shape we already built
 * inside DataPreviewModal's Group & Aggregate section.
 *
 * aggregations schema accepts two forms:
 *   simple: `{revenue: 'sum'}` — output col has same name as source
 *   named:  `{avg_rating: {col: 'rating', agg: 'mean'}}` — output col
 *           name distinct from source; needed to run two aggs on the
 *           same source column.
 * We always write the named form since it's a superset (output_name
 * = source_col when they match visually) and it's less ambiguous when
 * users add multi-agg-per-column later.
 */
interface AggRow {
  outputName: string;
  col: string;
  agg: string;
}

function normalizeAggs(v: any): AggRow[] {
  if (!v || typeof v !== 'object') return [];
  const out: AggRow[] = [];
  for (const [outputName, value] of Object.entries(v as Record<string, any>)) {
    if (typeof value === 'string') {
      out.push({ outputName, col: outputName, agg: value });
    } else if (value && typeof value === 'object') {
      out.push({
        outputName,
        col: (value.col as string) || outputName,
        agg: (value.agg as string) || 'sum',
      });
    }
  }
  return out;
}

function toAggObject(rows: AggRow[]): Record<string, any> {
  const obj: Record<string, any> = {};
  for (const r of rows) {
    if (!r.outputName || !r.agg) continue;
    obj[r.outputName] = {
      col: r.col || r.outputName,
      agg: r.agg,
    };
  }
  return obj;
}

export function AggregateSidebar({ attributes, onChange, onOpenAdvanced }: AggregateSidebarProps) {
  const { currentProject } = useProjectStore();
  const [schemas, setSchemas] = useState<Record<string, { columns: string[]; dtypes: Record<string, string> }>>({});
  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    assetsApi.knownSchemas(currentProject.id).then((s) => {
      if (!cancelled) setSchemas(s || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  const upstreamKey = (attributes.upstream_asset_key as string)
    || (attributes.upstream_asset_keys as string)?.split(',')[0]?.trim()
    || (attributes.upstream_table as string)
    || '';
  const upstreamCols = schemas[upstreamKey]?.columns ?? [];

  const groupBy: string[] = Array.isArray(attributes.group_by)
    ? attributes.group_by
    : typeof attributes.group_by === 'string'
      ? attributes.group_by.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

  const aggs = normalizeAggs(attributes.aggregations);

  const setGroupBy = (next: string[]) => onChange('group_by', next);
  const writeAggs = (rows: AggRow[]) => onChange('aggregations', toAggObject(rows));

  const toggleGroupBy = (col: string) => {
    setGroupBy(groupBy.includes(col) ? groupBy.filter((c) => c !== col) : [...groupBy, col]);
  };
  const updateAgg = (i: number, patch: Partial<AggRow>) => {
    const next = aggs.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    writeAggs(next);
  };
  const addAgg = () => writeAggs([...aggs, { outputName: '', col: '', agg: 'sum' }]);
  const removeAgg = (i: number) => writeAggs(aggs.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Sigma className="w-4 h-4 text-primary" /> Group & Aggregate
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Group rows by one or more columns, then compute aggregations.
        </p>
      </div>

      {/* Group by — chip picker of upstream columns. */}
      <section>
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Group by</h4>
        {upstreamCols.length === 0 ? (
          <input
            value={groupBy.join(', ')}
            onChange={(e) => setGroupBy(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
            placeholder="Comma-separated column names (preview upstream to unlock chip picker)"
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {groupBy.map((c) => (
                <span key={c} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] bg-blue-50 border border-blue-200 rounded text-blue-700">
                  {c}
                  <button type="button" onClick={() => toggleGroupBy(c)} className="hover:text-blue-900">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <select
              value=""
              onChange={(e) => {
                const c = e.target.value;
                if (c && !groupBy.includes(c)) toggleGroupBy(c);
              }}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">+ add a column to group by…</option>
              {upstreamCols.filter((c) => !groupBy.includes(c)).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </>
        )}
      </section>

      {/* Aggregations — rows of output_name + source col + agg fn. */}
      <section>
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Aggregations</h4>
        {aggs.length === 0 && (
          <p className="text-[11px] text-gray-500 italic mb-1.5">
            No aggregations yet. Add one to compute values per group.
          </p>
        )}
        <div className="space-y-1.5">
          {aggs.map((r, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                value={r.outputName}
                onChange={(e) => updateAgg(i, { outputName: e.target.value })}
                placeholder="output name (e.g. total_revenue)"
                className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-[10px] text-gray-400">=</span>
              <select
                value={r.agg}
                onChange={(e) => updateAgg(i, { agg: e.target.value })}
                className="w-24 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                {AGG_FUNCS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <span className="text-[10px] text-gray-400">of</span>
              {upstreamCols.length > 0 ? (
                <select
                  value={r.col}
                  onChange={(e) => updateAgg(i, { col: e.target.value })}
                  className="w-32 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">source col</option>
                  {upstreamCols.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  value={r.col}
                  onChange={(e) => updateAgg(i, { col: e.target.value })}
                  placeholder="source col"
                  className="w-32 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
              <button
                type="button"
                onClick={() => removeAgg(i)}
                className="p-1 text-gray-400 hover:text-gray-700"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addAgg}
          className="inline-flex items-center gap-1 mt-2 px-2 py-1 text-xs text-primary hover:bg-primary/5 rounded"
        >
          <Plus className="w-3 h-3" /> Add aggregation
        </button>
      </section>

      {/* Compiled output preview so users see the yaml shape. */}
      {(groupBy.length > 0 || aggs.length > 0) && (
        <section className="p-2 rounded bg-gray-50 border border-gray-100 text-[11px] font-mono text-gray-700 space-y-0.5">
          <div>group_by: [{groupBy.map((g) => `"${g}"`).join(', ')}]</div>
          <div>aggregations:</div>
          {aggs.filter((r) => r.outputName && r.agg).map((r, i) => (
            <div key={i} className="pl-3">{r.outputName}: {`{col: "${r.col || r.outputName}", agg: "${r.agg}"}`}</div>
          ))}
        </section>
      )}

      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (partition, freshness, tags, retry policy, …)
        </button>
      )}
    </div>
  );
}
