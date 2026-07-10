import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Clock, Loader2, Plus, Trash2 } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddDbtSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  dbtRelativePath: string;
  onSaved?: () => void;
}

const PERIODS = ['minute', 'hour', 'day'] as const;

interface ColumnEntry {
  name: string;
  description: string;
  not_null: boolean;
  unique: boolean;
}

/**
 * Compose a dbt source table entry — where a source lives in the
 * warehouse, its freshness thresholds, and its column contracts.
 * Writes to `models/sources.yml`, upserting the table into the source
 * block (creates the source if it doesn't exist yet).
 */
export function AddDbtSourceDialog({ open, onOpenChange, projectId, dbtRelativePath, onSaved }: AddDbtSourceDialogProps) {
  const [sourceName, setSourceName] = useState('');
  const [schema, setSchema] = useState('');
  const [database, setDatabase] = useState('');
  const [tableName, setTableName] = useState('');
  const [description, setDescription] = useState('');
  const [loadedAtField, setLoadedAtField] = useState('');
  const [warnCount, setWarnCount] = useState('12');
  const [warnPeriod, setWarnPeriod] = useState<typeof PERIODS[number]>('hour');
  const [errorCount, setErrorCount] = useState('24');
  const [errorPeriod, setErrorPeriod] = useState<typeof PERIODS[number]>('hour');
  const [useWarn, setUseWarn] = useState(true);
  const [useError, setUseError] = useState(true);
  const [columns, setColumns] = useState<ColumnEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setSourceName(''); setSchema(''); setDatabase(''); setTableName('');
    setDescription(''); setLoadedAtField('');
    setWarnCount('12'); setWarnPeriod('hour'); setErrorCount('24'); setErrorPeriod('hour');
    setUseWarn(true); setUseError(true);
    setColumns([]);
  };

  const addCol = () => setColumns([...columns, { name: '', description: '', not_null: false, unique: false }]);
  const updateCol = (i: number, patch: Partial<ColumnEntry>) => setColumns(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeCol = (i: number) => setColumns(columns.filter((_, j) => j !== i));

  const submit = async () => {
    if (!sourceName.trim()) { notify.error('Source name is required.'); return; }
    if (!tableName.trim()) { notify.error('Table name is required.'); return; }
    setSaving(true);
    try {
      await projectsApi.addDbtSource(projectId, {
        dbt_relative_path: dbtRelativePath,
        source_name: sourceName.trim(),
        schema: schema.trim() || undefined,
        database: database.trim() || undefined,
        table_name: tableName.trim(),
        description: description.trim() || undefined,
        loaded_at_field: loadedAtField.trim() || undefined,
        warn_after: useWarn && loadedAtField.trim() && /^\d+$/.test(warnCount) ? { count: Number(warnCount), period: warnPeriod } : null,
        error_after: useError && loadedAtField.trim() && /^\d+$/.test(errorCount) ? { count: Number(errorCount), period: errorPeriod } : null,
        columns: columns
          .filter((c) => c.name.trim())
          .map((c) => ({
            name: c.name.trim(),
            description: c.description.trim() || undefined,
            tests: [c.not_null && 'not_null', c.unique && 'unique'].filter(Boolean) as string[],
          })),
      });
      notify.success(`Saved ${sourceName}.${tableName} to models/sources.yml`);
      onSaved?.();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 404) {
        notify.error('Endpoint not found — restart the backend so the new dbt endpoints load.');
      } else {
        notify.error(detail || e?.message || 'Failed to save source.');
      }
    } finally { setSaving(false); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl w-[720px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Clock className="w-5 h-5 text-orange-500" />
              New source
            </Dialog.Title>
            <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto flex-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Source name</label>
                <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="stripe"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                <p className="text-[10px] text-gray-500 mt-0.5">Referenced as <code className="bg-gray-100 px-1 rounded">source('stripe', 'orders')</code>.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Table name</label>
                <input value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="orders"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Warehouse schema (optional)</label>
                <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="raw_stripe"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Warehouse database (optional)</label>
                <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="analytics"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Description (optional)</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Raw stripe orders, snapshotted every 15 min"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
              </div>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <label className="block text-xs font-semibold text-gray-700 mb-2">Freshness (optional)</label>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[11px] text-gray-600 mb-1">loaded_at column</label>
                  <input value={loadedAtField} onChange={(e) => setLoadedAtField(e.target.value)} placeholder="updated_at"
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded" />
                  <p className="text-[10px] text-gray-500 mt-0.5">Column with the row's ingestion timestamp — required for freshness checks.</p>
                </div>
                <div>
                  <label className="flex items-center gap-1.5 text-[11px] text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={useWarn} onChange={(e) => setUseWarn(e.target.checked)} className="w-3.5 h-3.5" />
                    <span>Warn after</span>
                  </label>
                  <div className="flex items-center gap-1 mt-1">
                    <input value={warnCount} onChange={(e) => setWarnCount(e.target.value)} disabled={!useWarn}
                      className="w-16 px-2 py-1 text-sm font-mono border border-gray-300 rounded disabled:bg-gray-100" />
                    <select value={warnPeriod} onChange={(e) => setWarnPeriod(e.target.value as any)} disabled={!useWarn}
                      className="px-2 py-1 text-sm border border-gray-300 rounded bg-white disabled:bg-gray-100">
                      {PERIODS.map((p) => <option key={p} value={p}>{p}{'s'}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="flex items-center gap-1.5 text-[11px] text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={useError} onChange={(e) => setUseError(e.target.checked)} className="w-3.5 h-3.5" />
                    <span>Error after</span>
                  </label>
                  <div className="flex items-center gap-1 mt-1">
                    <input value={errorCount} onChange={(e) => setErrorCount(e.target.value)} disabled={!useError}
                      className="w-16 px-2 py-1 text-sm font-mono border border-gray-300 rounded disabled:bg-gray-100" />
                    <select value={errorPeriod} onChange={(e) => setErrorPeriod(e.target.value as any)} disabled={!useError}
                      className="px-2 py-1 text-sm border border-gray-300 rounded bg-white disabled:bg-gray-100">
                      {PERIODS.map((p) => <option key={p} value={p}>{p}{'s'}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-100 pt-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-gray-700">Columns (optional)</label>
                <button type="button" onClick={addCol} className="text-[11px] text-blue-600 hover:text-blue-800 inline-flex items-center gap-0.5">
                  <Plus className="w-3 h-3" /> add column
                </button>
              </div>
              {columns.length === 0 && (
                <p className="text-[11px] text-gray-500 italic">
                  Add column definitions so dbt / the docs viewer knows this source's schema. Optional.
                </p>
              )}
              <div className="space-y-1">
                {columns.map((c, i) => (
                  <div key={i} className="p-2 border border-gray-200 rounded bg-gray-50/40">
                    <div className="flex items-center gap-1">
                      <input value={c.name} onChange={(e) => updateCol(i, { name: e.target.value })} placeholder="column_name"
                        className="px-2 py-1 text-xs font-mono border border-gray-300 rounded flex-1 min-w-0" />
                      <input value={c.description} onChange={(e) => updateCol(i, { description: e.target.value })} placeholder="description"
                        className="px-2 py-1 text-xs border border-gray-300 rounded flex-[2] min-w-0" />
                      <button type="button" onClick={() => removeCol(i)} className="p-1 text-gray-400 hover:text-rose-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="mt-1 pl-1 flex items-center gap-3 text-[11px] text-gray-600">
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" checked={c.not_null} onChange={(e) => updateCol(i, { not_null: e.target.checked })} className="w-3 h-3" />
                        not_null
                      </label>
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" checked={c.unique} onChange={(e) => updateCol(i, { unique: e.target.checked })} className="w-3 h-3" />
                        unique
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button onClick={submit} disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save source'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
