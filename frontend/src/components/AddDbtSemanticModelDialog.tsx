import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Sigma, Loader2, Plus, Trash2 } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddDbtSemanticModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  dbtRelativePath: string;
  onSaved?: () => void;
}

const ENTITY_TYPES = ['primary', 'foreign', 'unique', 'natural'] as const;
const DIMENSION_TYPES = ['categorical', 'time'] as const;
const TIME_GRANULARITIES = ['day', 'week', 'month', 'quarter', 'year'] as const;
const AGG_FUNCS = ['sum', 'count', 'count_distinct', 'average', 'min', 'max', 'sum_boolean', 'median'] as const;

type EntityRow = { name: string; type: typeof ENTITY_TYPES[number]; expr: string; description: string };
type DimensionRow = { name: string; type: typeof DIMENSION_TYPES[number]; time_granularity: string; expr: string; description: string };
type MeasureRow = { name: string; agg: typeof AGG_FUNCS[number]; expr: string; description: string; agg_time_dimension: string };

const emptyEntity = (): EntityRow => ({ name: '', type: 'foreign', expr: '', description: '' });
const emptyDimension = (): DimensionRow => ({ name: '', type: 'categorical', time_granularity: 'day', expr: '', description: '' });
const emptyMeasure = (): MeasureRow => ({ name: '', agg: 'sum', expr: '', description: '', agg_time_dimension: '' });

/**
 * Compose a dbt semantic model (MetricFlow) — entities, dimensions, and
 * measures layered on top of an existing dbt model. Three independent
 * repeating-row lists since that's the real shape (not a flat form like
 * exposures): dbt also requires exactly one entity marked `primary`,
 * checked client-side before submit so the error shows up here instead
 * of as a bare 400 from the backend.
 */
export function AddDbtSemanticModelDialog({ open, onOpenChange, projectId, dbtRelativePath, onSaved }: AddDbtSemanticModelDialogProps) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [description, setDescription] = useState('');
  const [defaultAggTimeDimension, setDefaultAggTimeDimension] = useState('');
  const [entities, setEntities] = useState<EntityRow[]>([{ ...emptyEntity(), type: 'primary' }]);
  const [dimensions, setDimensions] = useState<DimensionRow[]>([]);
  const [measures, setMeasures] = useState<MeasureRow[]>([]);
  const [availableModels, setAvailableModels] = useState<Array<{ unique_id: string; name: string; resource_type: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !dbtRelativePath) return;
    let cancelled = false;
    projectsApi.listDbtModels(projectId, dbtRelativePath).then((r) => {
      if (!cancelled) {
        setAvailableModels(r.models.filter((m) => m.resource_type === 'model').map((m) => ({ unique_id: m.unique_id, name: m.name, resource_type: m.resource_type })));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, projectId, dbtRelativePath]);

  const reset = () => {
    setName(''); setModel(''); setDescription(''); setDefaultAggTimeDimension('');
    setEntities([{ ...emptyEntity(), type: 'primary' }]); setDimensions([]); setMeasures([]);
  };

  const timeDimensionNames = dimensions.filter((d) => d.type === 'time' && d.name.trim()).map((d) => d.name.trim());

  const submit = async () => {
    if (!name.trim()) { notify.error('Semantic model name is required.'); return; }
    if (!model.trim()) { notify.error('Pick the underlying dbt model.'); return; }
    const realEntities = entities.filter((e) => e.name.trim());
    if (realEntities.length === 0) { notify.error('At least one entity is required.'); return; }
    if (!realEntities.some((e) => e.type === 'primary')) { notify.error('Exactly one entity must be type: primary.'); return; }

    setSaving(true);
    try {
      await projectsApi.addDbtSemanticModel(projectId, {
        dbt_relative_path: dbtRelativePath,
        name: name.trim(),
        model: model.trim(),
        description: description.trim() || undefined,
        default_agg_time_dimension: defaultAggTimeDimension || undefined,
        entities: realEntities.map((e) => ({
          name: e.name.trim(), type: e.type,
          expr: e.expr.trim() || undefined, description: e.description.trim() || undefined,
        })),
        dimensions: dimensions.filter((d) => d.name.trim()).map((d) => ({
          name: d.name.trim(), type: d.type,
          time_granularity: d.type === 'time' ? d.time_granularity : undefined,
          expr: d.expr.trim() || undefined, description: d.description.trim() || undefined,
        })),
        measures: measures.filter((m) => m.name.trim()).map((m) => ({
          name: m.name.trim(), agg: m.agg,
          expr: m.expr.trim() || undefined, description: m.description.trim() || undefined,
          agg_time_dimension: m.agg_time_dimension || undefined,
        })),
      });
      notify.success(`Saved semantic model "${name}" to models/semantic_models.yml`);
      onSaved?.();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 404) {
        notify.error('Endpoint not found — restart the backend so the new dbt endpoints load.');
      } else {
        notify.error(detail || e?.message || 'Failed to save semantic model.');
      }
    } finally { setSaving(false); }
  };

  const rowInputClass = 'px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl w-[760px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Sigma className="w-5 h-5 text-purple-500" />
              New semantic model
            </Dialog.Title>
            <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-5 overflow-y-auto flex-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="orders"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Underlying model</label>
                <select value={model} onChange={(e) => setModel(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded bg-white">
                  <option value="">Select a model…</option>
                  {availableModels.map((m) => <option key={m.unique_id} value={m.name}>{m.name}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                  placeholder="What this semantic model represents"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
              </div>
            </div>

            {/* Entities */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  Entities ({entities.length}) <span className="font-normal normal-case text-gray-400">— exactly one must be primary</span>
                </label>
                <button type="button" onClick={() => setEntities((r) => [...r, emptyEntity()])}
                  className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800">
                  <Plus className="w-3 h-3" /> Add entity
                </button>
              </div>
              <div className="space-y-2">
                {entities.map((row, i) => (
                  <div key={i} className="border border-gray-200 rounded p-2 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <input value={row.name} onChange={(e) => setEntities((r) => r.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        placeholder="order_id" className={`${rowInputClass} flex-1`} />
                      <select value={row.type} onChange={(e) => setEntities((r) => r.map((x, j) => j === i ? { ...x, type: e.target.value as any } : x))}
                        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                        {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button type="button" onClick={() => setEntities((r) => r.filter((_, j) => j !== i))} className="p-1 text-gray-400 hover:text-rose-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <input
                      value={row.expr}
                      onChange={(e) => setEntities((r) => r.map((x, j) => j === i ? { ...x, expr: e.target.value } : x))}
                      placeholder={`SQL expr (optional) — only if the actual column isn't named "${row.name || 'order_id'}"`}
                      title="The SQL expression/column this entity reads from. Leave blank to use the name above as-is -- only set this when the real column name differs (e.g. name: order_id, expr: id)."
                      className={`${rowInputClass} w-full`}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Dimensions */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Dimensions ({dimensions.length})</label>
                <button type="button" onClick={() => setDimensions((r) => [...r, emptyDimension()])}
                  className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800">
                  <Plus className="w-3 h-3" /> Add dimension
                </button>
              </div>
              <div className="space-y-2">
                {dimensions.map((row, i) => (
                  <div key={i} className="border border-gray-200 rounded p-2 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <input value={row.name} onChange={(e) => setDimensions((r) => r.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        placeholder="order_date" className={`${rowInputClass} flex-1`} />
                      <select value={row.type} onChange={(e) => setDimensions((r) => r.map((x, j) => j === i ? { ...x, type: e.target.value as any } : x))}
                        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                        {DIMENSION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      {row.type === 'time' && (
                        <select value={row.time_granularity} onChange={(e) => setDimensions((r) => r.map((x, j) => j === i ? { ...x, time_granularity: e.target.value } : x))}
                          className="px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                          {TIME_GRANULARITIES.map((g) => <option key={g} value={g}>{g}</option>)}
                        </select>
                      )}
                      <button type="button" onClick={() => setDimensions((r) => r.filter((_, j) => j !== i))} className="p-1 text-gray-400 hover:text-rose-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <input
                      value={row.expr}
                      onChange={(e) => setDimensions((r) => r.map((x, j) => j === i ? { ...x, expr: e.target.value } : x))}
                      placeholder={`SQL expr (optional) — only if the actual column isn't named "${row.name || 'order_date'}"`}
                      title="The SQL expression/column this dimension reads from. Leave blank to use the name above as-is -- only set this when the real column name differs, or you need a real expression (e.g. DATE_TRUNC('day', created_at))."
                      className={`${rowInputClass} w-full`}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Measures */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Measures ({measures.length})</label>
                <button type="button" onClick={() => setMeasures((r) => [...r, emptyMeasure()])}
                  className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800">
                  <Plus className="w-3 h-3" /> Add measure
                </button>
              </div>
              <div className="space-y-2">
                {measures.map((row, i) => (
                  <div key={i} className="border border-gray-200 rounded p-2 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <input value={row.name} onChange={(e) => setMeasures((r) => r.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                        placeholder="order_total" className={`${rowInputClass} flex-1`} />
                      <select value={row.agg} onChange={(e) => setMeasures((r) => r.map((x, j) => j === i ? { ...x, agg: e.target.value as any } : x))}
                        className="px-2 py-1 text-xs border border-gray-300 rounded bg-white">
                        {AGG_FUNCS.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                      {timeDimensionNames.length > 0 && (
                        <select value={row.agg_time_dimension} onChange={(e) => setMeasures((r) => r.map((x, j) => j === i ? { ...x, agg_time_dimension: e.target.value } : x))}
                          className="px-2 py-1 text-xs border border-gray-300 rounded bg-white"
                          title="Which time dimension this measure aggregates over.">
                          <option value="">agg_time_dimension…</option>
                          {timeDimensionNames.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                      <button type="button" onClick={() => setMeasures((r) => r.filter((_, j) => j !== i))} className="p-1 text-gray-400 hover:text-rose-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <input
                      value={row.expr}
                      onChange={(e) => setMeasures((r) => r.map((x, j) => j === i ? { ...x, expr: e.target.value } : x))}
                      placeholder={`SQL expr (optional) — e.g. a column or formula to ${row.agg}, if different from "${row.name || 'order_total'}"`}
                      title="The SQL expression/column this measure aggregates. Leave blank to use the name above as-is -- set this when the real column differs or you need a computed expression (e.g. amount * quantity)."
                      className={`${rowInputClass} w-full`}
                    />
                  </div>
                ))}
              </div>
            </div>

            {timeDimensionNames.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Default agg_time_dimension (optional)</label>
                <select value={defaultAggTimeDimension} onChange={(e) => setDefaultAggTimeDimension(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded bg-white">
                  <option value="">— none —</option>
                  {timeDimensionNames.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button onClick={submit} disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save semantic model'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
