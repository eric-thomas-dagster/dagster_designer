import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Editor from '@monaco-editor/react';
import { X, FileCode, Loader2 } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddDbtModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Called after a successful create so callers can regenerate assets
   *  / open the SQL file in the code editor. Passes the sql path
   *  relative to the project root. */
  onCreated?: (sqlPath: string, dbtProjectRelativePath: string) => void;
}

const MATERIALIZATIONS = [
  { value: 'view', label: 'view', hint: 'Recreated each run — cheap for lightweight transforms.' },
  { value: 'table', label: 'table', hint: 'Dropped and rebuilt each run — good for full-refresh workloads.' },
  { value: 'incremental', label: 'incremental', hint: 'Only new/changed rows are inserted — needs a unique key + is_incremental() logic.' },
  { value: 'ephemeral', label: 'ephemeral', hint: 'Compiled inline as a CTE; never materialized.' },
] as const;

const STARTER_SQL = `select
    1 as id,
    'hello' as name

-- Reference upstream models with {{ ref('other_model') }}
-- or raw sources with {{ source('source_name', 'table_name') }}.
`;

export function AddDbtModelDialog({ open, onOpenChange, projectId, onCreated }: AddDbtModelDialogProps) {
  const [dbtProjects, setDbtProjects] = useState<Array<{
    name: string; relative_path: string; model_paths: string[]; is_git_repo: boolean;
  }>>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [dbtProjectPath, setDbtProjectPath] = useState('');
  const [modelName, setModelName] = useState('');
  const [subfolder, setSubfolder] = useState('');
  const [materialization, setMaterialization] = useState<'view' | 'table' | 'incremental' | 'ephemeral'>('view');
  const [sql, setSql] = useState(STARTER_SQL);
  const [description, setDescription] = useState('');
  const [createTest, setCreateTest] = useState(true);
  const [testColumn, setTestColumn] = useState('id');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingProjects(true);
    projectsApi.listDbtProjects(projectId).then((r) => {
      if (cancelled) return;
      setDbtProjects(r.projects);
      if (r.projects.length > 0 && !dbtProjectPath) {
        setDbtProjectPath(r.projects[0].relative_path);
      }
      setLoadingProjects(false);
    }).catch((e) => {
      if (cancelled) return;
      notify.error(`Failed to list dbt projects: ${e?.message ?? e}`);
      setLoadingProjects(false);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  const nameError = useMemo(() => {
    if (!modelName) return null;
    if (modelName[0]?.match(/[0-9]/)) return 'Must start with a letter.';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(modelName)) return 'Snake_case only (letters, digits, underscore).';
    return null;
  }, [modelName]);

  const canSubmit = !!dbtProjectPath && !!modelName && !nameError && sql.trim().length > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const tests = createTest && testColumn ? [{
        [testColumn]: ['not_null', 'unique'],
      }] : undefined;
      const r = await projectsApi.addDbtModel(projectId, {
        dbt_project_relative_path: dbtProjectPath,
        model_name: modelName,
        subfolder: subfolder || null,
        materialization,
        sql,
        description: description || null,
        // dbt schema.yml tests are keyed on `name` + `tests: [<test-name>]`.
        // Send in that shape so the backend can drop it in directly.
        tests: tests
          ? [{ name: modelName, description: description || undefined, columns: [{ name: testColumn, tests: ['not_null', 'unique'] }] }]
          : undefined,
      } as any);
      notify.success(`Created ${r.sql_path}${r.schema_written ? ' + schema.yml' : ''}.`);
      onCreated?.(r.sql_path, dbtProjectPath);
      onOpenChange(false);
      // Reset for next open
      setModelName('');
      setSubfolder('');
      setSql(STARTER_SQL);
      setDescription('');
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || String(e);
      notify.error(`Create failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[860px] max-w-[95vw] h-[80vh] max-h-[760px] flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div>
              <Dialog.Title className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <FileCode className="w-5 h-5 text-orange-500" />
                New dbt model
              </Dialog.Title>
              <p className="text-sm text-gray-500 mt-0.5">
                Write a SQL file into an existing dbt project. Dagster picks it up on the next reload.
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Close">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {/* dbt project picker + name + subfolder */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">
                  dbt project {loadingProjects && <Loader2 className="w-3 h-3 inline animate-spin ml-1" />}
                </label>
                <select
                  value={dbtProjectPath}
                  onChange={(e) => setDbtProjectPath(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {dbtProjects.length === 0 && !loadingProjects && (
                    <option value="">— none found —</option>
                  )}
                  {dbtProjects.map((p) => (
                    <option key={p.relative_path} value={p.relative_path}>
                      {p.name}{p.is_git_repo ? ' · git' : ''} ({p.relative_path})
                    </option>
                  ))}
                </select>
                {dbtProjects.length === 0 && !loadingProjects && (
                  <p className="text-[11px] text-amber-700 mt-1">
                    No <code className="bg-gray-100 px-1 rounded">dbt_project.yml</code> found in this project. Clone a dbt repo first.
                  </p>
                )}
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Materialization</label>
                <select
                  value={materialization}
                  onChange={(e) => setMaterialization(e.target.value as any)}
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {MATERIALIZATIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {MATERIALIZATIONS.find((m) => m.value === materialization)?.hint}
                </p>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Model name</label>
                <input
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder="stg_orders"
                  className={`w-full px-2 py-1.5 text-sm font-mono border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    nameError ? 'border-rose-300' : 'border-gray-300'
                  }`}
                />
                {nameError && <p className="text-[11px] text-rose-700 mt-0.5">{nameError}</p>}
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Subfolder (optional)</label>
                <input
                  value={subfolder}
                  onChange={(e) => setSubfolder(e.target.value)}
                  placeholder="staging"
                  className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Writes to <code className="bg-gray-100 px-1 rounded">models/{subfolder || '…'}/{modelName || '…'}.sql</code>
                </p>
              </div>
            </div>

            {/* SQL editor */}
            <div>
              <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1 block">SQL</label>
              <div className="border border-gray-200 rounded overflow-hidden">
                <Editor
                  height="260px"
                  defaultLanguage="sql"
                  value={sql}
                  onChange={(v) => setSql(v ?? '')}
                  theme="vs-light"
                  options={{
                    minimap: { enabled: false },
                    lineNumbers: 'on',
                    fontSize: 12,
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                    padding: { top: 6, bottom: 6 },
                  }}
                />
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                Prepend a <code className="bg-gray-100 px-1 rounded">{'{{ config(...) }}'}</code> header will be added
                automatically based on the materialization above.
              </p>
            </div>

            {/* Description + optional test */}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Description (optional)</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short summary of what this model returns"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-700">
              <input
                type="checkbox"
                checked={createTest}
                onChange={(e) => setCreateTest(e.target.checked)}
                className="w-4 h-4 mt-0.5"
              />
              <div>
                <div>Add default not_null + unique tests</div>
                <div className="mt-1 flex items-center gap-1">
                  <span className="text-[11px] text-gray-500">on column</span>
                  <input
                    value={testColumn}
                    onChange={(e) => setTestColumn(e.target.value)}
                    disabled={!createTest}
                    className="px-1.5 py-0.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                  />
                </div>
              </div>
            </label>
          </div>

          <div className="border-t border-gray-200 px-6 py-3 flex items-center justify-end gap-2 flex-shrink-0">
            <button
              onClick={() => onOpenChange(false)}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || saving}
              className="px-4 py-1.5 text-sm font-medium bg-orange-500 text-white rounded hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileCode className="w-3.5 h-3.5" />}
              {saving ? 'Creating…' : 'Create model'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
