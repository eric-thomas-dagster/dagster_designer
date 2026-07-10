import { useEffect, useMemo, useState } from 'react';
import { Wand2, Plus, X, Trash2 } from 'lucide-react';
import { projectsApi } from '@/services/api';

interface DbtVisualComposerProps {
  projectId: string;
  dbtRelativePath: string;
  /** Fired whenever the composed SQL changes so the parent dialog can
   *  populate the SQL tab / submit. */
  onSqlChange: (sql: string) => void;
}

type Template = 'select' | 'join' | 'aggregate' | 'union';

const TEMPLATES: Array<{ id: Template; label: string; hint: string }> = [
  { id: 'select',    label: 'Simple select', hint: 'Project some columns from one source, optional WHERE + ORDER BY.' },
  { id: 'join',      label: 'Join',          hint: 'Combine two sources on matching keys.' },
  { id: 'aggregate', label: 'Aggregate',     hint: 'Group by columns + sum / count / avg / min / max.' },
  { id: 'union',     label: 'Union',         hint: 'Stack rows from multiple sources with matching columns.' },
];

const AGG_FNS = ['sum', 'count', 'avg', 'min', 'max', 'count_distinct'] as const;
const JOIN_TYPES = ['inner', 'left', 'right', 'full outer'] as const;
const OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'is null', 'is not null', 'in', 'like'] as const;

interface SourceRef {
  unique_id: string;
  name: string;
  resource_type: string;
  columns: string[];
}

interface FilterClause {
  column: string;
  operator: string;
  value: string;
}

interface JoinConfig {
  right: string;             // unique_id of right side (left is `source`)
  join_type: string;
  left_key: string;
  right_key: string;
}

interface Aggregation {
  column: string;
  fn: string;
  alias: string;
}

/**
 * Visual composer for new dbt models — an alternative to writing raw
 * SQL. Users pick a template + fill in a form and we compile that spec
 * to SQL live so they can see exactly what will be written. The
 * generated SQL is streamed up to the parent via `onSqlChange` so
 * users can eject to the SQL editor at any time to fine-tune.
 */
export function DbtVisualComposer({ projectId, dbtRelativePath, onSqlChange }: DbtVisualComposerProps) {
  const [template, setTemplate] = useState<Template>('select');
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [loading, setLoading] = useState(false);

  // Simple select / aggregate / join left side
  const [source, setSource] = useState<string>('');
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(true);
  const [filters, setFilters] = useState<FilterClause[]>([]);
  const [orderBy, setOrderBy] = useState<string>('');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc');
  const [limit, setLimit] = useState<string>('');

  // Join
  const [join, setJoin] = useState<JoinConfig>({
    right: '',
    join_type: 'inner',
    left_key: '',
    right_key: '',
  });
  const [rightColumns, setRightColumns] = useState<string[]>([]);

  // Aggregate
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [aggregations, setAggregations] = useState<Aggregation[]>([
    { column: '', fn: 'count', alias: '' },
  ]);

  // Union — a list of extra unique_ids to append after `source`
  const [unionSources, setUnionSources] = useState<string[]>([]);

  // Load the manifest models on mount so the ref() picker is complete.
  // We include seeds + sources too — anything usable in `ref()` /
  // `source()`.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    projectsApi.listDbtModels(projectId, dbtRelativePath).then((r) => {
      if (cancelled) return;
      const refs: SourceRef[] = r.models.map((m) => ({
        unique_id: m.unique_id,
        name: m.name,
        resource_type: m.resource_type,
        columns: Object.keys(m.columns ?? {}),
      }));
      setSources(refs);
      if (refs.length > 0) setSource(refs[0].unique_id);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, dbtRelativePath]);

  const sourceMap = useMemo(() => new Map(sources.map((s) => [s.unique_id, s])), [sources]);
  const leftSource = source ? sourceMap.get(source) : undefined;
  const rightSource = join.right ? sourceMap.get(join.right) : undefined;

  // Reset column selections when the source changes.
  useEffect(() => {
    if (!leftSource) return;
    if (template === 'aggregate') {
      setGroupBy((g) => g.filter((c) => leftSource.columns.includes(c)));
      setAggregations((aggs) => aggs.map((a) => ({
        ...a,
        column: leftSource.columns.includes(a.column) ? a.column : (leftSource.columns[0] ?? ''),
      })));
    } else {
      setSelectedColumns((cols) => cols.filter((c) => leftSource.columns.includes(c)));
    }
  }, [leftSource, template]);

  // Live-compile SQL and push it up. Runs on every keystroke — small,
  // deterministic templates so this is cheap.
  useEffect(() => {
    const sql = compileSql({
      template,
      leftSource,
      rightSource,
      selectAll,
      selectedColumns,
      filters,
      orderBy,
      orderDir,
      limit,
      join,
      rightColumns,
      groupBy,
      aggregations,
      unionSources: unionSources.map((uid) => sourceMap.get(uid)).filter((s): s is SourceRef => !!s),
    });
    onSqlChange(sql);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, source, join, rightColumns, selectedColumns, selectAll, filters, orderBy, orderDir, limit, groupBy, aggregations, unionSources]);

  if (loading) {
    return <div className="text-xs text-gray-500 p-4">Loading available refs…</div>;
  }
  if (sources.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-gray-600 bg-amber-50 border border-amber-200 rounded">
        No models found in this dbt project yet. Compose needs at least one existing model / source / seed to build off.
        Use the SQL tab to write your first one, then come back here to compose downstream models visually.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Template picker */}
      <div>
        <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Template</label>
        <div className="grid grid-cols-4 gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTemplate(t.id)}
              className={`text-left p-2 border rounded transition-colors ${
                template === t.id
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="text-xs font-semibold text-gray-900 flex items-center gap-1.5">
                <Wand2 className={`w-3.5 h-3.5 ${template === t.id ? 'text-primary' : 'text-gray-400'}`} />
                {t.label}
              </div>
              <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{t.hint}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Source picker */}
      <div>
        <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">
          {template === 'join' ? 'Left source' : template === 'union' ? 'First source' : 'Source'}
        </label>
        <RefPicker sources={sources} value={source} onChange={setSource} />
      </div>

      {/* Template-specific config */}
      {template === 'select' && leftSource && (
        <SelectConfig
          source={leftSource}
          selectAll={selectAll}
          setSelectAll={setSelectAll}
          selectedColumns={selectedColumns}
          setSelectedColumns={setSelectedColumns}
          filters={filters}
          setFilters={setFilters}
          orderBy={orderBy} setOrderBy={setOrderBy}
          orderDir={orderDir} setOrderDir={setOrderDir}
          limit={limit} setLimit={setLimit}
        />
      )}

      {template === 'join' && leftSource && (
        <JoinConfigPanel
          sources={sources}
          leftSource={leftSource}
          rightSource={rightSource}
          selectedColumns={selectedColumns} setSelectedColumns={setSelectedColumns}
          rightColumns={rightColumns} setRightColumns={setRightColumns}
          join={join} setJoin={setJoin}
        />
      )}

      {template === 'aggregate' && leftSource && (
        <AggregateConfig
          source={leftSource}
          groupBy={groupBy} setGroupBy={setGroupBy}
          aggregations={aggregations} setAggregations={setAggregations}
          filters={filters} setFilters={setFilters}
        />
      )}

      {template === 'union' && leftSource && (
        <UnionConfig
          sources={sources}
          leftSource={leftSource}
          unionSources={unionSources} setUnionSources={setUnionSources}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------
// SQL compilation. Small deterministic templates so the preview
// updates on every keystroke without needing a real parser.
// ------------------------------------------------------------

function refCall(s: SourceRef): string {
  if (s.unique_id.startsWith('source.')) {
    // source.<project>.<source_name>.<table_name> — need last two parts.
    const parts = s.unique_id.split('.');
    return `{{ source('${parts[parts.length - 2]}', '${parts[parts.length - 1]}') }}`;
  }
  return `{{ ref('${s.name}') }}`;
}

function quoteVal(v: string): string {
  const t = v.trim();
  if (t === '') return "''";
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (/^(true|false|null)$/i.test(t)) return t.toLowerCase();
  return `'${t.replace(/'/g, "''")}'`;
}

function whereClause(filters: FilterClause[]): string {
  const clauses = filters
    .filter((f) => f.column)
    .map((f) => {
      const op = f.operator.toLowerCase();
      if (op === 'is null' || op === 'is not null') return `    ${f.column} ${op}`;
      if (op === 'in') {
        const vals = f.value.split(',').map((v) => quoteVal(v.trim())).join(', ');
        return `    ${f.column} in (${vals})`;
      }
      return `    ${f.column} ${op} ${quoteVal(f.value)}`;
    });
  if (clauses.length === 0) return '';
  return '\nwhere\n' + clauses.join('\n    and\n');
}

function compileSql(cfg: {
  template: Template;
  leftSource?: SourceRef;
  rightSource?: SourceRef;
  selectAll: boolean;
  selectedColumns: string[];
  filters: FilterClause[];
  orderBy: string; orderDir: 'asc' | 'desc';
  limit: string;
  join: JoinConfig;
  rightColumns: string[];
  groupBy: string[];
  aggregations: Aggregation[];
  unionSources: SourceRef[];
}): string {
  const { template, leftSource } = cfg;
  if (!leftSource) return '-- Pick a source to get started.\n';

  if (template === 'select') {
    const cols = cfg.selectAll || cfg.selectedColumns.length === 0
      ? '*'
      : cfg.selectedColumns.map((c) => `    ${c}`).join(',\n');
    const wherePart = whereClause(cfg.filters);
    const orderPart = cfg.orderBy
      ? `\norder by ${cfg.orderBy} ${cfg.orderDir}`
      : '';
    const limitPart = cfg.limit && /^\d+$/.test(cfg.limit) ? `\nlimit ${cfg.limit}` : '';
    return `select\n${cols === '*' ? '    *' : cols}\nfrom ${refCall(leftSource)}${wherePart}${orderPart}${limitPart}\n`;
  }

  if (template === 'join') {
    const { rightSource, join, rightColumns } = cfg;
    if (!rightSource) return '-- Pick a right source to join with.\n';
    const leftCols = cfg.selectAll || cfg.selectedColumns.length === 0
      ? [`l.*`]
      : cfg.selectedColumns.map((c) => `    l.${c}`);
    const rightCols = rightColumns.length === 0
      ? []
      : rightColumns.map((c) => `    r.${c}`);
    const allCols = [...leftCols, ...rightCols].join(',\n');
    const joinLine = `${join.join_type} join ${refCall(rightSource)} r on l.${join.left_key || '<left_key>'} = r.${join.right_key || '<right_key>'}`;
    const wherePart = whereClause(cfg.filters).replace(/    /g, '    ');
    return `select\n${allCols}\nfrom ${refCall(leftSource)} l\n${joinLine}${wherePart}\n`;
  }

  if (template === 'aggregate') {
    const gb = cfg.groupBy.filter(Boolean);
    if (gb.length === 0 && cfg.aggregations.length === 0) {
      return '-- Pick at least one group-by column or aggregation.\n';
    }
    const gbCols = gb.map((c) => `    ${c}`);
    const aggCols = cfg.aggregations.filter((a) => a.column && a.fn).map((a) => {
      const alias = a.alias || `${a.fn}_${a.column}`;
      const call = a.fn === 'count_distinct'
        ? `count(distinct ${a.column})`
        : `${a.fn}(${a.column})`;
      return `    ${call} as ${alias}`;
    });
    const cols = [...gbCols, ...aggCols].join(',\n');
    const wherePart = whereClause(cfg.filters);
    const groupBy = gb.length ? `\ngroup by ${gb.map((_, i) => i + 1).join(', ')}` : '';
    return `select\n${cols}\nfrom ${refCall(leftSource)}${wherePart}${groupBy}\n`;
  }

  if (template === 'union') {
    const parts = [leftSource, ...cfg.unionSources];
    const blocks = parts.map((s) => `select * from ${refCall(s)}`);
    return blocks.join('\nunion all\n') + '\n';
  }

  return '';
}

// ------------------------------------------------------------
// Sub-components — one per template kind. Kept in the same file so
// state stays close to the composer + we can share sub-widgets.
// ------------------------------------------------------------

function RefPicker({ sources, value, onChange }: { sources: SourceRef[]; value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
    >
      {sources.map((s) => (
        <option key={s.unique_id} value={s.unique_id}>
          {s.name} · {s.resource_type}{s.columns.length > 0 ? ` (${s.columns.length} cols)` : ''}
        </option>
      ))}
    </select>
  );
}

function ColumnChecklist({ columns, selected, onChange, allowAllToggle, selectAll, setSelectAll }: {
  columns: string[]; selected: string[]; onChange: (cols: string[]) => void;
  allowAllToggle?: boolean; selectAll?: boolean; setSelectAll?: (v: boolean) => void;
}) {
  if (columns.length === 0) {
    return <div className="text-[11px] text-gray-500 italic">No columns known for this source. Run <code>dbt docs generate</code> to populate the catalog.</div>;
  }
  return (
    <div className="border border-gray-200 rounded p-2 bg-white max-h-40 overflow-y-auto">
      {allowAllToggle && setSelectAll && (
        <label className="flex items-center gap-1.5 text-xs text-gray-700 mb-1 pb-1 border-b border-gray-100 cursor-pointer">
          <input type="checkbox" checked={!!selectAll} onChange={(e) => setSelectAll(e.target.checked)} className="w-3.5 h-3.5" />
          <span className="font-medium">select *</span>
        </label>
      )}
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        {columns.map((c) => (
          <label key={c} className={`flex items-center gap-1 text-[11px] font-mono cursor-pointer ${selectAll ? 'opacity-40' : ''}`}>
            <input
              type="checkbox"
              checked={selected.includes(c)}
              disabled={selectAll}
              onChange={(e) => {
                if (e.target.checked) onChange([...selected, c]);
                else onChange(selected.filter((x) => x !== c));
              }}
              className="w-3 h-3"
            />
            <span className="truncate">{c}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FiltersEditor({ filters, setFilters, columns }: { filters: FilterClause[]; setFilters: (f: FilterClause[]) => void; columns: string[] }) {
  const add = () => setFilters([...filters, { column: columns[0] ?? '', operator: '=', value: '' }]);
  const remove = (i: number) => setFilters(filters.filter((_, j) => j !== i));
  const update = (i: number, patch: Partial<FilterClause>) => setFilters(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[10px] uppercase tracking-wider text-gray-500">Filters (WHERE)</label>
        <button type="button" onClick={add} className="text-[11px] text-blue-600 hover:text-blue-800 inline-flex items-center gap-0.5">
          <Plus className="w-3 h-3" /> add filter
        </button>
      </div>
      {filters.length === 0 ? (
        <div className="text-[11px] text-gray-500 italic">No filters — every row will be returned.</div>
      ) : (
        <div className="space-y-1">
          {filters.map((f, i) => {
            const opIsUnary = f.operator === 'is null' || f.operator === 'is not null';
            return (
              <div key={i} className="flex items-center gap-1">
                <select value={f.column} onChange={(e) => update(i, { column: e.target.value })}
                  className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded bg-white flex-1 min-w-0">
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={f.operator} onChange={(e) => update(i, { operator: e.target.value })}
                  className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded bg-white">
                  {OPERATORS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <input
                  value={f.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                  placeholder={opIsUnary ? '—' : 'value'}
                  disabled={opIsUnary}
                  className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded flex-1 min-w-0 disabled:bg-gray-100"
                />
                <button type="button" onClick={() => remove(i)} className="p-1 text-gray-400 hover:text-rose-600">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SelectConfig(props: any) {
  const { source, selectAll, setSelectAll, selectedColumns, setSelectedColumns, filters, setFilters, orderBy, setOrderBy, orderDir, setOrderDir, limit, setLimit } = props;
  return (
    <>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Columns</label>
        <ColumnChecklist
          columns={source.columns}
          selected={selectedColumns}
          onChange={setSelectedColumns}
          allowAllToggle
          selectAll={selectAll}
          setSelectAll={setSelectAll}
        />
      </div>
      <FiltersEditor filters={filters} setFilters={setFilters} columns={source.columns} />
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Order by</label>
          <select value={orderBy} onChange={(e) => setOrderBy(e.target.value)}
            className="w-full px-1.5 py-1 text-xs font-mono border border-gray-300 rounded bg-white">
            <option value="">— none —</option>
            {source.columns.map((c: string) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Direction</label>
          <select value={orderDir} onChange={(e) => setOrderDir(e.target.value)}
            className="w-full px-1.5 py-1 text-xs font-mono border border-gray-300 rounded bg-white">
            <option value="asc">asc</option>
            <option value="desc">desc</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Limit</label>
          <input value={limit} onChange={(e) => setLimit(e.target.value)}
            placeholder="e.g. 100"
            className="w-full px-1.5 py-1 text-xs font-mono border border-gray-300 rounded" />
        </div>
      </div>
    </>
  );
}

function JoinConfigPanel(props: any) {
  const { sources, leftSource, rightSource, selectedColumns, setSelectedColumns, rightColumns, setRightColumns, join, setJoin } = props;
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Right source</label>
          <RefPicker sources={sources} value={join.right} onChange={(v) => setJoin({ ...join, right: v })} />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Join type</label>
          <select value={join.join_type} onChange={(e) => setJoin({ ...join, join_type: e.target.value })}
            className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded bg-white">
            {JOIN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Left key</label>
          <select value={join.left_key} onChange={(e) => setJoin({ ...join, left_key: e.target.value })}
            className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded bg-white">
            <option value="">— pick a column —</option>
            {leftSource.columns.map((c: string) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Right key</label>
          <select value={join.right_key} onChange={(e) => setJoin({ ...join, right_key: e.target.value })}
            disabled={!rightSource}
            className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded bg-white disabled:bg-gray-100">
            <option value="">— pick a column —</option>
            {rightSource?.columns.map((c: string) => <option key={c} value={c}>{c}</option>) ?? []}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Columns from left (l.*)</label>
          <ColumnChecklist columns={leftSource.columns} selected={selectedColumns} onChange={setSelectedColumns} />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Columns from right (r.*)</label>
          {rightSource ? (
            <ColumnChecklist columns={rightSource.columns} selected={rightColumns} onChange={setRightColumns} />
          ) : (
            <div className="text-[11px] text-gray-500 italic">Pick a right source above.</div>
          )}
        </div>
      </div>
    </>
  );
}

function AggregateConfig(props: any) {
  const { source, groupBy, setGroupBy, aggregations, setAggregations, filters, setFilters } = props;
  const addAgg = () => setAggregations([...aggregations, { column: source.columns[0] ?? '', fn: 'sum', alias: '' }]);
  const removeAgg = (i: number) => setAggregations(aggregations.filter((_: any, j: number) => j !== i));
  const updateAgg = (i: number, patch: Partial<Aggregation>) =>
    setAggregations(aggregations.map((a: Aggregation, j: number) => (j === i ? { ...a, ...patch } : a)));
  return (
    <>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Group by</label>
        <ColumnChecklist columns={source.columns} selected={groupBy} onChange={setGroupBy} />
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[10px] uppercase tracking-wider text-gray-500">Aggregations</label>
          <button type="button" onClick={addAgg} className="text-[11px] text-blue-600 hover:text-blue-800 inline-flex items-center gap-0.5">
            <Plus className="w-3 h-3" /> add
          </button>
        </div>
        <div className="space-y-1">
          {aggregations.map((a: Aggregation, i: number) => (
            <div key={i} className="flex items-center gap-1">
              <select value={a.fn} onChange={(e) => updateAgg(i, { fn: e.target.value })}
                className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded bg-white">
                {AGG_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <span className="text-xs text-gray-400">(</span>
              <select value={a.column} onChange={(e) => updateAgg(i, { column: e.target.value })}
                className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded bg-white flex-1 min-w-0">
                <option value="">—</option>
                {source.columns.map((c: string) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="text-xs text-gray-400">) as</span>
              <input value={a.alias} onChange={(e) => updateAgg(i, { alias: e.target.value })}
                placeholder={a.column && a.fn ? `${a.fn}_${a.column}` : 'alias'}
                className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded flex-1 min-w-0" />
              <button type="button" onClick={() => removeAgg(i)} className="p-1 text-gray-400 hover:text-rose-600">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>
      <FiltersEditor filters={filters} setFilters={setFilters} columns={source.columns} />
    </>
  );
}

function UnionConfig(props: any) {
  const { sources, leftSource, unionSources, setUnionSources } = props;
  const add = () => {
    const remaining = sources.filter((s: SourceRef) => s.unique_id !== leftSource.unique_id && !unionSources.includes(s.unique_id));
    if (remaining.length) setUnionSources([...unionSources, remaining[0].unique_id]);
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[10px] uppercase tracking-wider text-gray-500">Additional sources</label>
        <button type="button" onClick={add} className="text-[11px] text-blue-600 hover:text-blue-800 inline-flex items-center gap-0.5">
          <Plus className="w-3 h-3" /> add source
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mb-2 italic">
        Union all — every source must have the same column set. We emit <code className="bg-gray-100 px-1 rounded">select *</code> from each.
      </p>
      {unionSources.length === 0 && (
        <div className="text-[11px] text-gray-500 italic">Click "add source" to append rows from another model.</div>
      )}
      <div className="space-y-1">
        {unionSources.map((uid: string, i: number) => (
          <div key={i} className="flex items-center gap-1">
            <RefPicker sources={sources} value={uid} onChange={(v) => {
              const next = [...unionSources]; next[i] = v; setUnionSources(next);
            }} />
            <button type="button" onClick={() => setUnionSources(unionSources.filter((_: string, j: number) => j !== i))} className="p-1 text-gray-400 hover:text-rose-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
