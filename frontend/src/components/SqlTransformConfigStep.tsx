import { useEffect, useState } from 'react';
import { X, Loader2, Plus, Sparkles, Wand2 } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';

/**
 * Start a SQL transform straight from a resource or a bare connection
 * string -- no existing Dagster asset needed. The full visual builder
 * (DataPreviewModal, ~4k lines, 30+ ops) is deliberately NOT retrofitted to
 * support a "no asset yet" source: it's built entirely around an already-
 * materialized asset's live preview rows, and threading that through safely
 * is a much bigger, riskier change than this screen needs. This covers the
 * essentials -- keep/filter/group-by+aggregate/drop-na/string-ops/sort/limit
 * -- everything verified working server-side this session (sql_transformer.py).
 * Once saved, the resulting table IS a real asset -- open ITS Transform
 * button from the graph for the full visual builder on top of this.
 */

const AGG_FUNCTIONS = ['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'std'];
const STRING_OPS = ['upper', 'lower', 'title', 'trim'];
const FILTER_OPERATORS = ['equals', 'not_equals', 'greater_than', 'less_than', 'contains', 'not_contains'];

export function SqlTransformConfigStep({
  onDone,
  onClose,
}: {
  onDone: () => void;
  onClose: () => void;
}) {
  const { currentProject } = useProjectStore();

  const [resources, setResources] = useState<{ name: string }[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'resource' | 'connection_string'>('resource');
  const [resourceKey, setResourceKey] = useState('');
  const [connectionUrlEnvVar, setConnectionUrlEnvVar] = useState('');
  const [sourceSql, setSourceSql] = useState('');
  const [assetName, setAssetName] = useState('');

  useEffect(() => {
    if (!currentProject || resources.length > 0 || resourcesLoading) return;
    setResourcesLoading(true);
    fetch(`${API_BASE}/templates/resources/${currentProject.id}`)
      .then((r) => r.json())
      .then((body) => setResources(body.resources || []))
      .catch(() => notify.error('Failed to load registered resources.'))
      .finally(() => setResourcesLoading(false));
  }, [currentProject]);

  const [columnsToKeep, setColumnsToKeep] = useState('');
  const [filters, setFilters] = useState<{ column: string; operator: string; value: string }[]>([]);
  const [groupBy, setGroupBy] = useState('');
  const [aggregations, setAggregations] = useState<{ column: string; function: string }[]>([]);
  const [dropNA, setDropNA] = useState(false);
  const [stringOps, setStringOps] = useState<{ column: string; operation: string }[]>([]);
  const [sortBy, setSortBy] = useState('');
  const [sortAscending, setSortAscending] = useState(true);
  const [limitRows, setLimitRows] = useState('');

  const [saving, setSaving] = useState(false);

  const canSave = sourceSql.trim().length > 0 && assetName.trim().length > 0
    && (authMode === 'resource' ? !!resourceKey : connectionUrlEnvVar.trim().length > 0);

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const transformConfig: Record<string, any> = {};
      const keepCols = columnsToKeep.split(',').map((s) => s.trim()).filter(Boolean);
      if (keepCols.length > 0) transformConfig.columnsToKeep = keepCols;
      if (filters.length > 0) transformConfig.filters = filters.filter((f) => f.column && f.value);
      const groupByCols = groupBy.split(',').map((s) => s.trim()).filter(Boolean);
      if (groupByCols.length > 0) transformConfig.groupBy = groupByCols;
      if (aggregations.length > 0) {
        const aggDict: Record<string, string> = {};
        for (const a of aggregations) if (a.column && a.function) aggDict[a.column] = a.function;
        if (Object.keys(aggDict).length > 0) transformConfig.aggregations = aggDict;
      }
      if (dropNA) transformConfig.dropNA = true;
      if (stringOps.length > 0) transformConfig.stringOperations = stringOps.filter((s) => s.column);
      const sortCols = sortBy.split(',').map((s) => s.trim()).filter(Boolean);
      if (sortCols.length > 0) {
        transformConfig.sortBy = sortCols;
        transformConfig.sortAscending = sortAscending;
      }
      if (limitRows.trim() && Number(limitRows) > 0) transformConfig.limitRows = Number(limitRows);

      await assetsApi.createSqlSourceTransformer(currentProject.id, {
        sourceSql: sourceSql.trim(),
        ...(authMode === 'resource' ? { resourceKey } : { connectionUrlEnvVar: connectionUrlEnvVar.trim() }),
        newAssetName: assetName.trim(),
        transformConfig,
      });
      notify.success(`Added "${assetName.trim()}" — running in the warehouse.`);
      onDone();
    } catch (e: any) {
      notify.error(`Failed to save: ${e?.response?.data?.detail ?? e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Wand2 className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Transform from a resource or connection</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          <div className="bg-blue-50 border border-blue-100 rounded-md p-3 text-xs text-blue-900 space-y-1">
            <p className="font-medium">How this works</p>
            <p>Runs your query and these ops as one SQL statement in the warehouse — no data movement. This covers the essentials; once saved, open the new table's own Transform button from the graph for the full visual builder (30+ ops) on top of it.</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Connect via</label>
            <div className="flex gap-2 mb-1.5">
              <button
                onClick={() => setAuthMode('resource')}
                className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${authMode === 'resource' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
              >
                A registered resource
              </button>
              <button
                onClick={() => setAuthMode('connection_string')}
                className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border ${authMode === 'connection_string' ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
              >
                A connection string
              </button>
            </div>
            {authMode === 'resource' ? (
              resourcesLoading ? (
                <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading registered resources…</div>
              ) : resources.length === 0 ? (
                <p className="text-xs text-amber-600">No resources registered in this project yet — add one, or use a connection string instead.</p>
              ) : (
                <select
                  value={resourceKey}
                  onChange={(e) => setResourceKey(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                >
                  <option value="" disabled>pick a resource</option>
                  {resources.map((r) => (<option key={r.name} value={r.name}>{r.name}</option>))}
                </select>
              )
            ) : (
              <div>
                <input
                  type="text"
                  value={connectionUrlEnvVar}
                  onChange={(e) => setConnectionUrlEnvVar(e.target.value)}
                  placeholder="DATABASE_URL"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Env var holding a bare SQLAlchemy URL — read at runtime, never stored here.</p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Source SQL</label>
            <textarea
              value={sourceSql}
              onChange={(e) => setSourceSql(e.target.value)}
              rows={4}
              placeholder={`SELECT * FROM raw_orders WHERE region = 'US'`}
              className="w-full px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">New table name</label>
            <input
              type="text"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
              placeholder="cleaned_orders"
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            />
          </div>

          <div className="border-t border-gray-100 pt-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Columns to keep <span className="text-gray-400 font-normal">(optional — leave empty for all)</span></label>
              <input
                type="text"
                value={columnsToKeep}
                onChange={(e) => setColumnsToKeep(e.target.value)}
                placeholder="id, customer_id, amount"
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Filters</label>
              <div className="space-y-1.5">
                {filters.map((f, i) => (
                  <div key={i} className="flex gap-1.5">
                    <input
                      type="text"
                      value={f.column}
                      onChange={(e) => setFilters((prev) => prev.map((x, xi) => (xi === i ? { ...x, column: e.target.value } : x)))}
                      placeholder="column"
                      className="w-1/3 px-2 py-1 text-xs border border-gray-300 rounded-md font-mono"
                    />
                    <select
                      value={f.operator}
                      onChange={(e) => setFilters((prev) => prev.map((x, xi) => (xi === i ? { ...x, operator: e.target.value } : x)))}
                      className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white"
                    >
                      {FILTER_OPERATORS.map((op) => (<option key={op} value={op}>{op}</option>))}
                    </select>
                    <input
                      type="text"
                      value={f.value}
                      onChange={(e) => setFilters((prev) => prev.map((x, xi) => (xi === i ? { ...x, value: e.target.value } : x)))}
                      placeholder="value"
                      className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-md font-mono"
                    />
                    <button onClick={() => setFilters((prev) => prev.filter((_, xi) => xi !== i))} className="text-gray-400 hover:text-red-600">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setFilters((prev) => [...prev, { column: '', operator: 'equals', value: '' }])}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Add filter
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Group by</label>
                <input
                  type="text"
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value)}
                  placeholder="customer_id, status"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-700 mt-6">
                <input type="checkbox" checked={dropNA} onChange={(e) => setDropNA(e.target.checked)} />
                Drop rows with nulls
              </label>
            </div>

            {groupBy.trim() && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Aggregations</label>
                <div className="space-y-1.5">
                  {aggregations.map((a, i) => (
                    <div key={i} className="flex gap-1.5">
                      <input
                        type="text"
                        value={a.column}
                        onChange={(e) => setAggregations((prev) => prev.map((x, xi) => (xi === i ? { ...x, column: e.target.value } : x)))}
                        placeholder="column"
                        className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-md font-mono"
                      />
                      <select
                        value={a.function}
                        onChange={(e) => setAggregations((prev) => prev.map((x, xi) => (xi === i ? { ...x, function: e.target.value } : x)))}
                        className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white"
                      >
                        {AGG_FUNCTIONS.map((fn) => (<option key={fn} value={fn}>{fn}</option>))}
                      </select>
                      <button onClick={() => setAggregations((prev) => prev.filter((_, xi) => xi !== i))} className="text-gray-400 hover:text-red-600">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => setAggregations((prev) => [...prev, { column: '', function: 'sum' }])}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add aggregation
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-1">Output columns are named "&lt;function&gt;_&lt;column&gt;", e.g. sum_amount.</p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">String cleanup</label>
              <div className="space-y-1.5">
                {stringOps.map((s, i) => (
                  <div key={i} className="flex gap-1.5">
                    <input
                      type="text"
                      value={s.column}
                      onChange={(e) => setStringOps((prev) => prev.map((x, xi) => (xi === i ? { ...x, column: e.target.value } : x)))}
                      placeholder="column"
                      className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded-md font-mono"
                    />
                    <select
                      value={s.operation}
                      onChange={(e) => setStringOps((prev) => prev.map((x, xi) => (xi === i ? { ...x, operation: e.target.value } : x)))}
                      className="px-2 py-1 text-xs border border-gray-300 rounded-md bg-white"
                    >
                      {STRING_OPS.map((op) => (<option key={op} value={op}>{op}</option>))}
                    </select>
                    <button onClick={() => setStringOps((prev) => prev.filter((_, xi) => xi !== i))} className="text-gray-400 hover:text-red-600">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setStringOps((prev) => [...prev, { column: '', operation: 'trim' }])}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Add string op
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Sort by</label>
                <input
                  type="text"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  placeholder="created_at"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Direction</label>
                <select
                  value={sortAscending ? 'asc' : 'desc'}
                  onChange={(e) => setSortAscending(e.target.value === 'asc')}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Limit rows <span className="text-gray-400 font-normal">(optional)</span></label>
              <input
                type="number"
                min={1}
                value={limitRows}
                onChange={(e) => setLimitRows(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {saving ? 'Saving…' : 'Run transform'}
          </button>
        </div>
      </div>
    </div>
  );
}
