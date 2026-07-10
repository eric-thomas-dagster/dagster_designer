import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Editor from '@monaco-editor/react';
import { X, TestTube2, Loader2, Plus } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddDbtTestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  dbtRelativePath: string;
  /** The model this test attaches to. Pre-fills the picker in the
   *  dialog so users don't have to re-select. */
  modelUniqueId: string;
  modelName: string;
  columns: string[];
  /** Optional starting column, so opening the dialog from a specific
   *  column row jumps straight to it. */
  defaultColumn?: string | null;
  onSaved?: () => void;
}

type Kind = 'not_null' | 'unique' | 'accepted_values' | 'relationships' | 'dbt_utils' | 'singular';

const KINDS: Array<{ id: Kind; label: string; hint: string; requiresColumn: boolean }> = [
  { id: 'not_null',       label: 'not_null',       hint: 'Fail if this column has any NULL values.',                             requiresColumn: true },
  { id: 'unique',         label: 'unique',         hint: 'Fail if this column has any duplicate values.',                        requiresColumn: true },
  { id: 'accepted_values',label: 'accepted_values',hint: 'Fail if this column has values outside a fixed set (e.g. statuses).', requiresColumn: true },
  { id: 'relationships',  label: 'relationships',  hint: "Fail if any value in this column can't be found in the target model.", requiresColumn: true },
  { id: 'dbt_utils',      label: 'dbt_utils',      hint: 'Package tests (e.g. dbt_utils.expression_is_true, unique_combination).', requiresColumn: false },
  { id: 'singular',       label: 'Custom SQL',     hint: 'Write a SELECT that returns rows *when the test fails*.',              requiresColumn: false },
];

const DBT_UTILS_PRESETS: Array<{ name: string; hint: string; config: Record<string, any> }> = [
  { name: 'dbt_utils.expression_is_true',            hint: 'Assert an arbitrary SQL expression is true for every row.', config: { expression: '> 0' } },
  { name: 'dbt_utils.unique_combination_of_columns', hint: 'Row-level uniqueness across multiple columns.',              config: { combination_of_columns: [] } },
  { name: 'dbt_utils.not_null_proportion',           hint: 'At least X% of rows non-null.',                              config: { at_least: 0.95 } },
  { name: 'dbt_utils.accepted_range',                hint: 'Numeric range check.',                                       config: { min_value: 0 } },
];

const STARTER_SINGULAR_SQL = `-- Returns rows *when the test should fail*.
-- Example: catch orders with negative totals.
select *
from {{ ref('<model_name>') }}
where total < 0
`;

export function AddDbtTestDialog({
  open, onOpenChange, projectId, dbtRelativePath,
  modelUniqueId, modelName, columns, defaultColumn, onSaved,
}: AddDbtTestDialogProps) {
  const [kind, setKind] = useState<Kind>('not_null');
  const [column, setColumn] = useState<string>(defaultColumn ?? columns[0] ?? '');
  // accepted_values
  const [values, setValues] = useState<string[]>([]);
  const [pendingValue, setPendingValue] = useState('');
  // relationships
  const [toModelName, setToModelName] = useState('');
  const [toField, setToField] = useState('');
  // dbt_utils
  const [packageTestName, setPackageTestName] = useState(DBT_UTILS_PRESETS[0].name);
  const [packageConfig, setPackageConfig] = useState<string>(JSON.stringify(DBT_UTILS_PRESETS[0].config, null, 2));
  // singular
  const [testName, setTestName] = useState('');
  const [sql, setSql] = useState(STARTER_SINGULAR_SQL.replace('<model_name>', modelName));
  const [description, setDescription] = useState('');
  // Available models to pick from (for relationships)
  const [availableModels, setAvailableModels] = useState<Array<{ name: string; unique_id: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Update starter SQL when modelName changes
    setSql(STARTER_SINGULAR_SQL.replace('<model_name>', modelName));
  }, [modelName]);

  useEffect(() => {
    if (!open || !dbtRelativePath) return;
    let cancelled = false;
    projectsApi.listDbtModels(projectId, dbtRelativePath).then((r) => {
      if (!cancelled) {
        setAvailableModels(r.models.map((m) => ({ name: m.name, unique_id: m.unique_id })));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, projectId, dbtRelativePath]);

  // Sync default column when opening (e.g. from a specific column row)
  useEffect(() => {
    if (open) setColumn(defaultColumn ?? columns[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultColumn]);

  const reset = () => {
    setKind('not_null');
    setColumn(defaultColumn ?? columns[0] ?? '');
    setValues([]); setPendingValue('');
    setToModelName(''); setToField('');
    setPackageTestName(DBT_UTILS_PRESETS[0].name);
    setPackageConfig(JSON.stringify(DBT_UTILS_PRESETS[0].config, null, 2));
    setTestName('');
    setSql(STARTER_SINGULAR_SQL.replace('<model_name>', modelName));
    setDescription('');
  };

  const kindDef = KINDS.find((k) => k.id === kind)!;

  const submit = async () => {
    if (kindDef.requiresColumn && !column) {
      notify.error('Pick a column for this test.');
      return;
    }
    // Basic per-kind validation
    if (kind === 'accepted_values' && values.length === 0) {
      notify.error('Add at least one accepted value.');
      return;
    }
    if (kind === 'relationships' && (!toModelName || !toField)) {
      notify.error('Pick a target model and field for the relationships test.');
      return;
    }
    if (kind === 'singular' && !testName.trim()) {
      notify.error('Give this custom test a name.');
      return;
    }
    if (kind === 'dbt_utils' && !packageTestName) {
      notify.error('Pick a package test.');
      return;
    }
    let parsedPackageConfig: Record<string, any> | null = null;
    if (kind === 'dbt_utils') {
      try {
        parsedPackageConfig = packageConfig.trim() ? JSON.parse(packageConfig) : {};
      } catch (e) {
        notify.error('Package test config must be valid JSON.');
        return;
      }
    }
    setSaving(true);
    try {
      await projectsApi.addDbtTest(projectId, {
        dbt_relative_path: dbtRelativePath,
        model_unique_id: modelUniqueId,
        kind,
        column: kindDef.requiresColumn ? column : null,
        values: kind === 'accepted_values' ? values : null,
        to_model_name: kind === 'relationships' ? toModelName : null,
        to_field: kind === 'relationships' ? toField : null,
        package_test_name: kind === 'dbt_utils' ? packageTestName : null,
        package_test_config: kind === 'dbt_utils' ? parsedPackageConfig : null,
        test_name: kind === 'singular' ? testName.trim() : null,
        sql: kind === 'singular' ? sql : null,
        description: description.trim() || null,
      });
      notify.success(kind === 'singular' ? `Wrote tests/${testName.trim()}.sql` : `Added ${kind} test to ${modelName}${column ? '.' + column : ''}`);
      onSaved?.();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 404) {
        notify.error('Endpoint not found — restart the backend so the new dbt-test endpoints load.');
      } else {
        notify.error(detail || e?.message || 'Failed to save test.');
      }
    } finally { setSaving(false); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl w-[720px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <TestTube2 className="w-5 h-5 text-emerald-600" />
                Add test · <span className="font-mono text-gray-700">{modelName}</span>
              </Dialog.Title>
              <p className="text-[11px] text-gray-500 mt-0.5">Writes to the model's schema.yml (or a new tests/*.sql for custom).</p>
            </div>
            <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto flex-1">
            {/* Kind picker */}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Test type</label>
              <div className="grid grid-cols-3 gap-2">
                {KINDS.map((k) => (
                  <button key={k.id} type="button" onClick={() => setKind(k.id)}
                    className={`text-left p-2 border rounded ${
                      kind === k.id
                        ? 'border-emerald-500 bg-emerald-50 ring-1 ring-emerald-200'
                        : 'border-gray-200 hover:border-gray-300 bg-white'
                    }`}>
                    <div className={`text-xs font-semibold font-mono ${kind === k.id ? 'text-emerald-700' : 'text-gray-900'}`}>
                      {k.label}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">{k.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Column picker (for generic tests) */}
            {kindDef.requiresColumn && (
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Column</label>
                <select value={column} onChange={(e) => setColumn(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded bg-white">
                  {columns.length === 0 && <option value="">— no columns known (run dbt docs generate) —</option>}
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}

            {kind === 'accepted_values' && (
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Accepted values</label>
                <div className="flex items-center gap-1 mb-2">
                  <input value={pendingValue} onChange={(e) => setPendingValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && pendingValue.trim()) {
                        e.preventDefault();
                        setValues([...values, pendingValue.trim()]);
                        setPendingValue('');
                      }
                    }}
                    placeholder="value (press Enter)"
                    className="flex-1 px-2 py-1 text-xs font-mono border border-gray-300 rounded" />
                  <button type="button" onClick={() => { if (pendingValue.trim()) { setValues([...values, pendingValue.trim()]); setPendingValue(''); } }}
                    className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded">Add</button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {values.map((v, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-emerald-50 border border-emerald-200 text-emerald-700 font-mono">
                      {v}
                      <button type="button" onClick={() => setValues(values.filter((_, j) => j !== i))} className="hover:text-rose-600">×</button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {kind === 'relationships' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Target model</label>
                  <select value={toModelName} onChange={(e) => setToModelName(e.target.value)}
                    className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded bg-white">
                    <option value="">— pick a model —</option>
                    {availableModels.filter((m) => m.unique_id !== modelUniqueId).map((m) => (
                      <option key={m.unique_id} value={m.name}>{m.name}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    Wraps to <code className="bg-gray-100 px-1 rounded">to: ref('{toModelName || '…'}')</code>
                  </p>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Target field</label>
                  <input value={toField} onChange={(e) => setToField(e.target.value)} placeholder="customer_id"
                    className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded" />
                </div>
              </div>
            )}

            {kind === 'dbt_utils' && (
              <>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Package test</label>
                  <select value={packageTestName} onChange={(e) => {
                      const preset = DBT_UTILS_PRESETS.find((p) => p.name === e.target.value);
                      setPackageTestName(e.target.value);
                      if (preset) setPackageConfig(JSON.stringify(preset.config, null, 2));
                    }}
                    className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded bg-white">
                    {DBT_UTILS_PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {DBT_UTILS_PRESETS.find((p) => p.name === packageTestName)?.hint}
                    · Requires <code className="bg-gray-100 px-1 rounded">dbt_utils</code> in packages.yml.
                  </p>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Config (JSON)</label>
                  <textarea value={packageConfig} onChange={(e) => setPackageConfig(e.target.value)} rows={5}
                    className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded" />
                </div>
              </>
            )}

            {kind === 'singular' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Test name</label>
                    <input value={testName} onChange={(e) => setTestName(e.target.value)} placeholder="assert_no_negative_totals"
                      className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded" />
                    <p className="text-[10px] text-gray-500 mt-0.5">Saves to <code className="bg-gray-100 px-1 rounded">tests/{testName || '…'}.sql</code></p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Description</label>
                    <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this test asserts"
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded" />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">SQL (return rows when the test fails)</label>
                  <div className="border border-gray-200 rounded overflow-hidden">
                    <Editor height="200px" defaultLanguage="sql" value={sql} onChange={(v) => setSql(v ?? '')} theme="vs-light"
                      options={{ minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: 'on' }} />
                  </div>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    dbt treats any returned rows as failures. Reference the model with <code className="bg-gray-100 px-1 rounded">{'{{ ref(\'' + modelName + '\') }}'}</code>.
                  </p>
                </div>
              </>
            )}
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button onClick={submit} disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Add test'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
