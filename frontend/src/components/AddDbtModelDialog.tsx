import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Editor from '@monaco-editor/react';
import { X, FileCode, Loader2, Wand2, Code2, Sparkles } from 'lucide-react';
import { projectsApi, aiApi, type AiProvidersStatus } from '@/services/api';
import { notify } from './Notifications';
import { DbtVisualComposer } from './DbtVisualComposer';
import { useIsDarkMode } from '@/hooks/useIsDarkMode';
import { onAiProvidersChanged } from './SettingsDialog';

// Same ordering/rationale as DagsterAIBar's copy of this list: first
// available-per-provider entry becomes the default.
const AI_MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (recommended)' },
  { value: 'gpt-4o', label: 'GPT-4o (recommended)' },
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5 (highest quality)' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini (fast, cheap)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast)' },
];

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
  const isDark = useIsDarkMode();
  const [dbtProjects, setDbtProjects] = useState<Array<{
    name: string; relative_path: string; model_paths: string[]; is_git_repo: boolean;
    is_remote_git: boolean; remote_git_url: string | null; remote_git_relative_path: string;
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
  // Compose mode — visual composer generates SQL live and streams it
  // into the same `sql` state, so switching to the SQL tab shows the
  // compiled result ready to fine-tune. AI works the same way: one
  // generate call writes into `sql`, then flips to the SQL tab so the
  // draft always gets a review pass before saving, never saved directly.
  const [composeMode, setComposeMode] = useState<'visual' | 'sql' | 'ai'>('sql');
  const [aiTask, setAiTask] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiProviders, setAiProviders] = useState<AiProvidersStatus | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => aiApi.providers().then((d) => { if (!cancelled) setAiProviders(d); }).catch(() => {});
    load();
    const unsubscribe = onAiProvidersChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, [open]);
  const availableAiModels = useMemo(() => {
    if (!aiProviders) return AI_MODEL_OPTIONS;
    return AI_MODEL_OPTIONS.filter((m) => {
      const isClaude = m.value.startsWith('claude');
      return isClaude ? aiProviders.anthropic_available : aiProviders.openai_available;
    });
  }, [aiProviders]);
  const [aiModel, setAiModel] = useState(AI_MODEL_OPTIONS[0].value);
  useEffect(() => {
    if (!aiProviders || availableAiModels.length === 0) return;
    if (!availableAiModels.find((m) => m.value === aiModel)) {
      setAiModel(availableAiModels[0].value);
    }
  }, [aiProviders, availableAiModels, aiModel]);

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

  const selectedProject = useMemo(
    () => dbtProjects.find((p) => p.relative_path === dbtProjectPath),
    [dbtProjects, dbtProjectPath],
  );
  const isRemote = !!selectedProject?.is_remote_git;

  useEffect(() => {
    if (isRemote) setComposeMode('sql');
  }, [isRemote]);

  const canSubmit = !!dbtProjectPath && !!modelName && !nameError && sql.trim().length > 0;

  const handleGenerateSql = async () => {
    if (!aiTask.trim() || !dbtProjectPath) return;
    setAiGenerating(true);
    try {
      const r = await projectsApi.generateDbtModelSql(projectId, {
        dbt_relative_path: dbtProjectPath,
        model_name: modelName || 'new_model',
        materialization,
        task: aiTask.trim(),
        ai_model: aiModel,
      });
      setSql(r.sql);
      // Draft lands in the SQL tab for review -- never saved directly
      // from here, same as the Visual composer's own generated SQL.
      setComposeMode('sql');
      notify.success('Draft generated — review it in the SQL tab before saving.');
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      notify.error(detail || e?.message || 'Failed to generate SQL.');
    } finally {
      setAiGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      if (isRemote && selectedProject?.remote_git_url) {
        const r = await projectsApi.addDbtModelRemote(projectId, {
          git_url: selectedProject.remote_git_url,
          repo_relative_path: selectedProject.remote_git_relative_path,
          model_name: modelName,
          subfolder: subfolder || null,
          materialization,
          sql,
        });
        notify.success(`Opened PR for ${r.file} on ${r.branch}: ${r.pr_url}`);
        onOpenChange(false);
        setModelName('');
        setSubfolder('');
        setSql(STARTER_SQL);
        setDescription('');
        return;
      }

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

      // Bad SQL (a ref() typo, an invalid Jinja config) or a malformed
      // schema.yml test entry can break the whole project's load just
      // like any other component write -- confirmed a real historical
      // incident for the "tests" shape specifically (see add_dbt_model's
      // own comment). Validate and undo via the existing model-delete
      // endpoint if so. dbt's unique_id convention is always
      // `model.<dbt_project_name>.<model_name>`, independent of subfolder.
      if (selectedProject) {
        const modelUniqueId = `model.${selectedProject.name}.${modelName}`;
        const { validateProjectOrRollback } = await import('@/lib/validateProjectOrRollback');
        const result = await validateProjectOrRollback(projectId, async () => {
          await projectsApi.deleteDbtModel(projectId, {
            dbt_relative_path: dbtProjectPath,
            model_unique_id: modelUniqueId,
            delete_schema_entry: true,
          });
        });
        if (!result.ok) {
          notify.error(`This model would have broken the project, so it was undone:\n${result.error}`);
          return;
        }
      }

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
                      {p.name}{p.is_remote_git ? ' · remote git (opens a PR)' : p.is_git_repo ? ' · git' : ''} ({p.relative_path})
                    </option>
                  ))}
                </select>
                {dbtProjects.length === 0 && !loadingProjects && (
                  <p className="text-[11px] text-amber-700 mt-1">
                    No dbt project found — neither a local <code className="bg-gray-100 px-1 rounded">dbt_project.yml</code> nor a
                    <code className="bg-gray-100 px-1 rounded ml-1">DbtProjectComponent</code> pointed at a remote git repo.
                  </p>
                )}
                {isRemote && (
                  <p className="text-[11px] text-amber-700 mt-1">
                    This dbt project lives in <code className="bg-gray-100 px-1 rounded">{selectedProject?.remote_git_url}</code>, not
                    here — creating this model will open a pull request against that repo instead of writing a local file.
                    Description + tests aren't supported for remote models yet; add those directly in the PR.
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

            {/* Compose mode tab bar — Visual, SQL, or AI. Visual composer
                and AI both write into the same `sql` state, so users can
                flip to SQL and fine-tune the generated result -- AI's
                draft is never saved directly, same review-before-save
                path the visual composer already uses. Not available for
                a remote-git dbt project — there's no local project to
                introspect for sources/columns (or existing model names,
                for AI's context) to compose against. */}
            {!isRemote && (
              <div className="border-b border-gray-200 flex items-center gap-1">
                {([
                  { v: 'visual', label: 'Visual composer', icon: Wand2,     hint: 'Form-driven — pick a source, columns, filters, joins.' },
                  { v: 'sql',    label: 'SQL editor',      icon: Code2,     hint: 'Write raw SQL directly with dbt jinja.' },
                  { v: 'ai',     label: 'AI',              icon: Sparkles,  hint: 'Describe the model in plain language — generates SQL you review before saving.' },
                ] as const).map(({ v, label, icon: Icon, hint }) => (
                  <button
                    key={v}
                    onClick={() => setComposeMode(v)}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                      composeMode === v
                        ? 'text-blue-600 border-blue-600'
                        : 'text-gray-600 border-transparent hover:text-gray-900'
                    }`}
                    title={hint}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                ))}
              </div>
            )}

            {composeMode === 'visual' && !isRemote && dbtProjectPath && (
              <DbtVisualComposer
                projectId={projectId}
                dbtRelativePath={dbtProjectPath}
                onSqlChange={setSql}
              />
            )}

            {composeMode === 'ai' && !isRemote && (
              <div className="space-y-2">
                {availableAiModels.length === 0 ? (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                    No AI provider configured — add an Anthropic or OpenAI key in Settings → AI Providers to use this.
                  </p>
                ) : (
                  <div className="flex items-center justify-end">
                    <select
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      className="px-2 py-1 text-xs border border-gray-300 rounded bg-white"
                    >
                      {availableAiModels.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </div>
                )}
                <textarea
                  value={aiTask}
                  onChange={(e) => setAiTask(e.target.value)}
                  rows={5}
                  placeholder={`Describe what this model should do, e.g. "Join orders to customers and compute total spend per customer, filtered to the last 90 days."`}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-gray-500">
                    Generates a draft into the SQL tab — nothing is saved until you click Create model there.
                  </p>
                  <button
                    onClick={handleGenerateSql}
                    disabled={aiGenerating || !aiTask.trim() || availableAiModels.length === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                  >
                    {aiGenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    {aiGenerating ? 'Generating…' : 'Generate SQL'}
                  </button>
                </div>
              </div>
            )}

            {composeMode === 'sql' && (
              <div>
                <div className="border border-gray-200 rounded overflow-hidden">
                  <Editor
                    height="260px"
                    defaultLanguage="sql"
                    value={sql}
                    onChange={(v) => setSql(v ?? '')}
                    theme={isDark ? 'vs-dark' : 'vs-light'}
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
                  A <code className="bg-gray-100 px-1 rounded">{'{{ config(...) }}'}</code> header will be added
                  automatically based on the materialization above.
                </p>
              </div>
            )}

            {/* Description + optional test — not supported by the
                remote-PR endpoint yet, so hide them for a remote project
                rather than silently dropping what the user typed. */}
            {!isRemote && (
              <>
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
              </>
            )}
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
              {saving ? (isRemote ? 'Opening PR…' : 'Creating…') : (isRemote ? 'Open PR' : 'Create model')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
