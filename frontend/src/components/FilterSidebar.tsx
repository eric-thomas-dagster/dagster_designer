import { useEffect, useMemo, useState } from 'react';
import { Plus, X, Filter as FilterIcon } from 'lucide-react';
import { assetsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

interface FilterSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
}

/**
 * Specialized sidebar for the filter / warehouse_filter components.
 * Users think in terms of "row-level conditions" (column op value), not
 * pandas query syntax. We give them a structured builder with column
 * pickers and an operator dropdown, then compile into pandas query
 * syntax (filter) or SQL WHERE (warehouse_filter — same pandas-y ops
 * usually work as SQL too). Users can drop into "raw" mode for
 * conditions the structured builder can't express.
 */
type Op = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'not_contains' | 'in' | 'is_null' | 'is_not_null';

const OPS: { value: Op; label: string; needsValue: boolean }[] = [
  { value: '==', label: 'equals', needsValue: true },
  { value: '!=', label: 'not equals', needsValue: true },
  { value: '>', label: '>', needsValue: true },
  { value: '>=', label: '≥', needsValue: true },
  { value: '<', label: '<', needsValue: true },
  { value: '<=', label: '≤', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: "doesn't contain", needsValue: true },
  { value: 'in', label: 'in (comma list)', needsValue: true },
  { value: 'is_null', label: 'is null', needsValue: false },
  { value: 'is_not_null', label: 'is not null', needsValue: false },
];

interface Row {
  column: string;
  op: Op;
  value: string;
}

// Compile the structured rows into a single expression string. Uses
// pandas query syntax by default — same operators the DataPreviewModal
// visual filter uses so users see one grammar across the app.
function compileCondition(rows: Row[], joiner: 'and' | 'or'): string {
  const parts: string[] = [];
  for (const r of rows) {
    if (!r.column) continue;
    const col = r.column;
    const v = r.value ?? '';
    const q = /^[\d.-]+$/.test(v) || v === 'true' || v === 'false' ? v : `'${v.replace(/'/g, "\\'")}'`;
    switch (r.op) {
      case '==': parts.push(`${col} == ${q}`); break;
      case '!=': parts.push(`${col} != ${q}`); break;
      case '>':  parts.push(`${col} > ${v}`); break;
      case '>=': parts.push(`${col} >= ${v}`); break;
      case '<':  parts.push(`${col} < ${v}`); break;
      case '<=': parts.push(`${col} <= ${v}`); break;
      case 'contains': parts.push(`${col}.str.contains(${q})`); break;
      case 'not_contains': parts.push(`~${col}.str.contains(${q})`); break;
      case 'in': {
        const list = v.split(',').map((s) => s.trim()).filter(Boolean).map((s) =>
          /^[\d.-]+$/.test(s) ? s : `'${s.replace(/'/g, "\\'")}'`
        ).join(', ');
        parts.push(`${col} in [${list}]`);
        break;
      }
      case 'is_null':      parts.push(`${col}.isna()`); break;
      case 'is_not_null':  parts.push(`${col}.notna()`); break;
    }
  }
  return parts.join(` ${joiner} `);
}

// Best-effort attempt to parse an existing condition string back into
// rows. If we can't, we fall through to "raw mode" so the user isn't
// stuck editing something we don't understand.
function parseCondition(str: string): { rows: Row[]; joiner: 'and' | 'or' } | null {
  if (!str) return { rows: [], joiner: 'and' };
  const joiner: 'and' | 'or' = /\bor\b/i.test(str) && !/\band\b/i.test(str) ? 'or' : 'and';
  const chunks = str.split(new RegExp(`\\s+${joiner}\\s+`, 'i'));
  const rows: Row[] = [];
  for (const raw of chunks) {
    const s = raw.trim();
    // is_null / is_not_null via isna / notna
    let m = s.match(/^([\w.]+)\.isna\(\)$/);
    if (m) { rows.push({ column: m[1], op: 'is_null', value: '' }); continue; }
    m = s.match(/^([\w.]+)\.notna\(\)$/);
    if (m) { rows.push({ column: m[1], op: 'is_not_null', value: '' }); continue; }
    // contains
    m = s.match(/^([\w.]+)\.str\.contains\((['"])(.*?)\2\)$/);
    if (m) { rows.push({ column: m[1], op: 'contains', value: m[3] }); continue; }
    m = s.match(/^~([\w.]+)\.str\.contains\((['"])(.*?)\2\)$/);
    if (m) { rows.push({ column: m[1], op: 'not_contains', value: m[3] }); continue; }
    // in [ ... ]
    m = s.match(/^([\w.]+)\s+in\s+\[(.*)\]$/);
    if (m) { rows.push({ column: m[1], op: 'in', value: m[2].replace(/['"]/g, '') }); continue; }
    // comparisons
    m = s.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (m) {
      const val = m[3].trim();
      const stripped = val.replace(/^['"]|['"]$/g, '');
      rows.push({ column: m[1], op: m[2] as Op, value: stripped });
      continue;
    }
    return null; // unparseable → raw mode
  }
  return { rows, joiner };
}

export function FilterSidebar({ attributes, onChange, onOpenAdvanced }: FilterSidebarProps) {
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

  // filter vs warehouse_filter use different field names for the expression
  // — pandas query vs SQL predicate — but the row builder covers both.
  const rawFieldName = attributes.condition !== undefined ? 'condition'
    : attributes.predicate !== undefined ? 'predicate'
    : 'condition';
  const rawValue = (attributes[rawFieldName] as string) || '';

  const parsed = useMemo(() => parseCondition(rawValue), [rawValue]);
  const [rawMode, setRawMode] = useState(parsed === null);
  const [rows, setRows] = useState<Row[]>(parsed?.rows ?? [{ column: '', op: '==', value: '' }]);
  const [joiner, setJoiner] = useState<'and' | 'or'>(parsed?.joiner ?? 'and');

  // Keep raw string in sync with structured rows when in builder mode.
  useEffect(() => {
    if (rawMode) return;
    onChange(rawFieldName, compileCondition(rows, joiner));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, joiner, rawMode]);

  const updateRow = (i: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const addRow = () => setRows((prev) => [...prev, { column: '', op: '==', value: '' }]);
  const removeRow = (i: number) => setRows((prev) => prev.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <FilterIcon className="w-4 h-4 text-primary" /> Filter
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Keep only the rows that match the conditions below.
        </p>
      </div>

      {/* Structured row builder — compiles down to the condition/predicate string. */}
      {!rawMode ? (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Conditions</h4>
            <button
              type="button"
              onClick={() => setRawMode(true)}
              className="text-[10px] text-gray-500 hover:text-gray-700"
            >
              Switch to raw expression →
            </button>
          </div>
          <div className="space-y-1.5">
            {rows.map((r, i) => {
              const opDef = OPS.find((o) => o.value === r.op) ?? OPS[0];
              return (
                <div key={i} className="flex items-center gap-1">
                  {upstreamCols.length > 0 ? (
                    <select
                      value={r.column}
                      onChange={(e) => updateRow(i, { column: e.target.value })}
                      className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                    >
                      <option value="">column</option>
                      {upstreamCols.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  ) : (
                    <input
                      value={r.column}
                      onChange={(e) => updateRow(i, { column: e.target.value })}
                      placeholder="column"
                      className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}
                  <select
                    value={r.op}
                    onChange={(e) => updateRow(i, { op: e.target.value as Op })}
                    className="w-32 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {opDef.needsValue && (
                    <input
                      value={r.value}
                      onChange={(e) => updateRow(i, { value: e.target.value })}
                      placeholder={r.op === 'in' ? 'a, b, c' : 'value'}
                      className="w-28 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="p-1 text-gray-400 hover:text-gray-700"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
            <div className="flex items-center gap-2 mt-1">
              <button
                type="button"
                onClick={addRow}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/5 rounded"
              >
                <Plus className="w-3 h-3" /> Add condition
              </button>
              {rows.length > 1 && (
                <div className="flex items-center gap-1 text-[11px] ml-auto">
                  <span className="text-gray-500">Combine with</span>
                  {(['and', 'or'] as const).map((j) => (
                    <button
                      key={j}
                      type="button"
                      onClick={() => setJoiner(j)}
                      className={`px-1.5 py-0.5 rounded ${joiner === j ? 'bg-primary/10 text-primary font-medium' : 'text-gray-600 hover:bg-gray-100'}`}
                    >
                      {j.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Compiled expression preview so users see what actually goes into the yaml. */}
          <div className="mt-2 p-2 rounded bg-gray-50 border border-gray-100 text-[11px] font-mono text-gray-700 break-all">
            {rawValue || <span className="text-gray-400 italic">— condition will appear here —</span>}
          </div>
        </section>
      ) : (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Raw expression</h4>
            <button
              type="button"
              onClick={() => {
                const p = parseCondition(rawValue);
                if (p) {
                  setRows(p.rows.length > 0 ? p.rows : [{ column: '', op: '==', value: '' }]);
                  setJoiner(p.joiner);
                  setRawMode(false);
                }
              }}
              className="text-[10px] text-gray-500 hover:text-gray-700"
            >
              ← Back to builder
            </button>
          </div>
          <textarea
            value={rawValue}
            onChange={(e) => onChange(rawFieldName, e.target.value)}
            placeholder="age > 18 and status == 'active'"
            rows={4}
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[11px] text-gray-500 mt-1">
            {rawFieldName === 'predicate' ? 'SQL WHERE clause' : 'Pandas query syntax'} — expressions the builder can't express (nested parens, method chains) live here.
          </p>
        </section>
      )}

      {/* Negate toggle */}
      <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-700">
        <input
          type="checkbox"
          checked={!!attributes.negate}
          onChange={(e) => onChange('negate', e.target.checked)}
          className="w-3.5 h-3.5"
        />
        <span>Invert — keep rows that DON'T match</span>
      </label>

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
