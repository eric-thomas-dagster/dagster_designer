import { useEffect, useMemo, useState } from 'react';
import { FileCode, Play, Loader2, CheckCircle2, XCircle, AlertTriangle, TestTube2, Book, FileText, Search, Layers, GitCommit, GitCompare, Clock } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';
import { AddDbtModelDialog } from './AddDbtModelDialog';
import { GitCommitDialog } from './GitCommitDialog';
import { SqlDiffDialog } from './SqlDiffDialog';

interface DbtPanelProps {
  onOpenFile?: (path: string) => void;
}

type Model = Awaited<ReturnType<typeof projectsApi.listDbtModels>>['models'][number];

/**
 * Top-level "dbt Models" tab — everything a modeler needs about the
 * dbt projects living inside this Dagster project, in one cohesive
 * view. Mirrors the shape of the Ingestions tab so users learn one
 * pattern for "list of things + KPIs + drawer for details".
 *
 * Data source: /projects/{id}/dbt-models parses dbt's own
 * manifest.json + catalog.json + run_results.json — no separate DB.
 * That means fresh projects (never ran dbt) show up with schema/docs
 * pulled from manifest and empty run/catalog metrics, degrading
 * gracefully.
 */
export function DbtPanel({ onOpenFile }: DbtPanelProps) {
  const { currentProject } = useProjectStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof projectsApi.listDbtModels>> | null>(null);

  const [search, setSearch] = useState('');
  const [selectedUniqueId, setSelectedUniqueId] = useState<string | null>(null);
  const [runningModel, setRunningModel] = useState<string | null>(null);
  const [runOutput, setRunOutput] = useState<{ uid: string; stdout: string; stderr: string; success: boolean } | null>(null);
  const [showAddModel, setShowAddModel] = useState(false);
  const [showGitCommit, setShowGitCommit] = useState(false);
  const [lineage, setLineage] = useState<Awaited<ReturnType<typeof projectsApi.getDbtColumnLineage>> | null>(null);
  const [diffFor, setDiffFor] = useState<{ path: string; name: string } | null>(null);
  const [view, setView] = useState<'models' | 'freshness'>('models');
  const [freshness, setFreshness] = useState<Awaited<ReturnType<typeof projectsApi.getDbtSourceFreshness>> | null>(null);
  const [runningModified, setRunningModified] = useState(false);
  // A Dagster project can orchestrate multiple dbt projects (e.g. a
  // shared warehouse repo + a domain-specific one). We fetch them all
  // up front so the header can offer a picker.
  const [dbtProjects, setDbtProjects] = useState<Awaited<ReturnType<typeof projectsApi.listDbtProjects>>['projects']>([]);
  const [selectedDbtPath, setSelectedDbtPath] = useState<string>('');

  const refresh = async (path?: string) => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    try {
      const r = await projectsApi.listDbtModels(currentProject.id, (path ?? selectedDbtPath) || undefined);
      setData(r);
      if (r.dbt_project_relative_path && !selectedDbtPath) {
        setSelectedDbtPath(r.dbt_project_relative_path);
      }
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Enumerate dbt projects up-front so the header picker knows all
  // options (even if only one, we still show it as a chip so users
  // understand the surface handles multiple).
  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    projectsApi.listDbtProjects(currentProject.id).then((r) => {
      if (cancelled) return;
      setDbtProjects(r.projects);
      if (r.projects.length > 0 && !selectedDbtPath) {
        setSelectedDbtPath(r.projects[0].relative_path);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  // Refresh the model list whenever the selected dbt project changes.
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [currentProject?.id, selectedDbtPath]);

  // Fetch column-level lineage lazily — it's only needed when the
  // drawer is open. Reuses one fetch across every model the user
  // clicks so switching between models is instant.
  useEffect(() => {
    if (!currentProject || !data?.dbt_project_relative_path) return;
    let cancelled = false;
    projectsApi.getDbtColumnLineage(currentProject.id, data.dbt_project_relative_path).then((r) => {
      if (!cancelled) setLineage(r);
    }).catch(() => {});
    projectsApi.getDbtSourceFreshness(currentProject.id, data.dbt_project_relative_path).then((r) => {
      if (!cancelled) setFreshness(r);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id, data?.dbt_project_relative_path]);

  // "Run modified" — CI-mode-lite. Instead of relying on dbt --state,
  // read git status for the dbt project, extract .sql files changed
  // under models/, derive the model names, and dbt-build them.
  const runModified = async () => {
    if (!currentProject || !data?.dbt_project_relative_path) return;
    setRunningModified(true);
    try {
      const st = await projectsApi.projectGitStatus(currentProject.id, data.dbt_project_relative_path);
      if (!st.is_git_repo) {
        notify.warning('This dbt project isn\'t a git repo — no modified state to detect.');
        return;
      }
      const changed = [...st.modified, ...st.untracked, ...st.staged];
      const modelNames = new Set<string>();
      for (const f of changed) {
        // Only .sql under any models/ path counts. Extract the file
        // stem — dbt --select accepts bare model names.
        const m = f.match(/(?:^|\/)models\/(?:.*\/)?([^\/]+)\.sql$/i);
        if (m) modelNames.add(m[1]);
      }
      if (modelNames.size === 0) {
        notify.info('No modified dbt models — commit some changes to trigger a modified run.');
        return;
      }
      const select = Array.from(modelNames).join(' ');
      notify.info(`Building ${modelNames.size} modified model${modelNames.size === 1 ? '' : 's'}: ${select}`);
      const r = await projectsApi.runDbtModel(currentProject.id, {
        dbt_relative_path: data.dbt_project_relative_path,
        select,
      });
      if (r.success) notify.success(`Modified models built in ${(r.duration_ms / 1000).toFixed(1)}s`);
      else notify.error('Modified-model build failed. See dbt output in the model drawer.');
      refresh();
    } catch (e: any) {
      notify.error(`Modified run failed: ${e?.message ?? e}`);
    } finally {
      setRunningModified(false);
    }
  };

  const filtered = useMemo(() => {
    if (!data) return [] as Model[];
    const q = search.trim().toLowerCase();
    if (!q) return data.models;
    return data.models.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      m.unique_id.toLowerCase().includes(q) ||
      (m.description || '').toLowerCase().includes(q) ||
      (m.materialization || '').toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [data, search]);

  const selected = useMemo(() => data?.models.find((m) => m.unique_id === selectedUniqueId) || null, [data, selectedUniqueId]);

  const runOne = async (model: Model) => {
    if (!currentProject || !data) return;
    setRunningModel(model.unique_id);
    setRunOutput(null);
    try {
      const r = await projectsApi.runDbtModel(currentProject.id, {
        dbt_relative_path: data.dbt_project_relative_path,
        select: model.name,
      });
      setRunOutput({ uid: model.unique_id, stdout: r.stdout, stderr: r.stderr, success: r.success });
      if (r.success) notify.success(`Ran ${model.name} in ${(r.duration_ms / 1000).toFixed(1)}s`);
      else notify.error(`dbt run failed for ${model.name}`);
      // Refresh so run_results.json is re-read
      refresh();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || String(e);
      notify.error(`Run failed: ${msg}`);
    } finally {
      setRunningModel(null);
    }
  };

  if (!currentProject) {
    return <div className="p-8 text-center text-sm text-gray-500">Open a project first.</div>;
  }

  const stats = data?.stats ?? {};

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-6 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2 flex-wrap">
            <FileCode className="w-6 h-6 text-orange-500" />
            dbt
            {/* Picker — only when the Dagster project orchestrates
                more than one dbt project. Single-project stays as a
                simple label. */}
            {dbtProjects.length > 1 ? (
              <select
                value={selectedDbtPath}
                onChange={(e) => setSelectedDbtPath(e.target.value)}
                className="text-base font-mono border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                title="Multiple dbt projects orchestrated by this Dagster project — pick one to view"
              >
                {dbtProjects.map((p) => (
                  <option key={p.relative_path} value={p.relative_path}>
                    {p.name}{p.is_git_repo ? ' · git' : ''}
                  </option>
                ))}
              </select>
            ) : (
              data?.project_name && (
                <span className="text-lg font-mono text-gray-600">· {data.project_name}</span>
              )
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {dbtProjects.length > 1
              ? `${dbtProjects.length} dbt projects orchestrated by this Dagster project`
              : 'Every model in this dbt project, with docs, tests, and one-click runs.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* view toggle — models vs source freshness */}
          <div className="flex items-center gap-0.5 bg-gray-100 rounded p-0.5 mr-2">
            {(['models', 'freshness'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded ${
                  view === v ? 'bg-white text-gray-900 shadow-sm font-medium' : 'text-gray-600'
                }`}
              >
                {v === 'models' ? <Layers className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                {v === 'models' ? 'Models' : 'Freshness'}
              </button>
            ))}
          </div>
          <button
            onClick={runModified}
            disabled={runningModified}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            title="Detects changed .sql files vs the git working tree and dbt-builds only those"
          >
            {runningModified ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run modified
          </button>
          <button
            onClick={() => setShowGitCommit(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            <GitCommit className="w-4 h-4" /> Commit
          </button>
          <button
            onClick={() => setShowAddModel(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-md hover:bg-orange-600"
          >
            <FileCode className="w-4 h-4" /> New model
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="p-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Parsing dbt manifest…
        </div>
      )}
      {error && (
        <div className="mx-8 mt-4 p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">
          {error}
        </div>
      )}
      {/* No dbt projects at all — friendlier than an empty table. */}
      {data && !data.dbt_project_relative_path && (
        <div className="mx-8 mt-6 p-8 bg-white border border-dashed border-gray-300 rounded-lg text-center">
          <FileCode className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-700 font-medium">No dbt project yet</p>
          <p className="text-xs text-gray-500 mt-1 mb-4">
            Import a dbt repo at project creation, or scaffold a new model right here to bootstrap one.
          </p>
          <button
            onClick={() => setShowAddModel(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-orange-500 text-white rounded"
          >
            <FileCode className="w-4 h-4" /> Scaffold a model
          </button>
        </div>
      )}
      {data && view === 'models' && (
        <>
          {/* KPI cards */}
          <div className="px-8 py-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            <Kpi label="Models" value={stats.total ?? 0} icon={Layers} tone="neutral" />
            <Kpi
              label="Documented"
              value={stats.with_docs ?? 0}
              hint={stats.total ? `${Math.round(((stats.with_docs ?? 0) / stats.total) * 100)}%` : undefined}
              icon={Book}
              tone={(stats.with_docs ?? 0) === (stats.total ?? 0) ? 'success' : 'warning'}
            />
            <Kpi label="With tests" value={stats.with_tests ?? 0} icon={TestTube2} tone="neutral" />
            <Kpi
              label="Last-run success"
              value={stats.run_success ?? 0}
              hint={
                (stats.run_success ?? 0) + (stats.run_failure ?? 0) > 0
                  ? `${stats.run_failure ?? 0} failed`
                  : 'never run'
              }
              icon={CheckCircle2}
              tone={(stats.run_failure ?? 0) > 0 ? 'warning' : 'success'}
            />
          </div>

          {/* Search + table + drawer split */}
          <div className="px-8 pb-8 flex gap-4">
            <div className="flex-1 min-w-0 bg-white border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search models…"
                    className="w-full pl-7 pr-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <span className="text-xs text-gray-500">{filtered.length} / {data.models.length}</span>
              </div>
              {filtered.length === 0 ? (
                <div className="p-8 text-center">
                  <FileCode className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                  <p className="text-sm text-gray-600 mb-3">
                    {data.models.length === 0
                      ? "This dbt project has no models yet."
                      : 'No models match the current search.'}
                  </p>
                  {data.models.length === 0 && (
                    <button
                      onClick={() => setShowAddModel(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-orange-500 text-white rounded"
                    >
                      <FileCode className="w-4 h-4" /> Create your first model
                    </button>
                  )}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Model</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Materialization</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Tests</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Last run</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((m) => (
                      <tr
                        key={m.unique_id}
                        className={`border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer ${
                          selectedUniqueId === m.unique_id ? 'bg-blue-50/40' : ''
                        }`}
                        onClick={(e) => {
                          const t = e.target as HTMLElement;
                          if (t.closest('button')) return;
                          setSelectedUniqueId(m.unique_id);
                        }}
                      >
                        <td className="px-4 py-2.5">
                          <div className="font-mono text-gray-900">{m.name}</div>
                          <div className="text-[11px] text-gray-500 truncate max-w-[280px]" title={m.description ?? ''}>
                            {m.description || <span className="italic text-gray-400">no docs</span>}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {m.materialization ? (
                            <span className="px-1.5 py-0.5 text-[11px] rounded bg-gray-100 text-gray-700 font-mono">
                              {m.materialization}
                            </span>
                          ) : (
                            <span className="text-gray-400 italic">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {m.tests.length > 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <TestTube2 className="w-3 h-3" /> {m.tests.length}
                            </span>
                          ) : (
                            <span className="text-gray-400 italic">none</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <LastRunPill status={m.last_run_status} durationMs={m.last_run_duration_ms} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() => runOne(m)}
                              disabled={runningModel === m.unique_id}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-40"
                              title="dbt build --select this model"
                            >
                              {runningModel === m.unique_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              {runningModel === m.unique_id ? 'Running…' : 'Run'}
                            </button>
                            {m.relative_sql_path && (
                              <button
                                onClick={() => onOpenFile?.(m.relative_sql_path!)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded"
                                title="Open SQL in code editor"
                              >
                                <FileText className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Detail drawer — docs, columns, tests, dependencies, last run output. */}
            {selected && (
              <ModelDetail
                model={selected}
                dbtRelativePath={data.dbt_project_relative_path}
                runOutput={runOutput?.uid === selected.unique_id ? runOutput : null}
                lineage={lineage}
                onOpenFile={onOpenFile}
                onClose={() => setSelectedUniqueId(null)}
                onRun={() => runOne(selected)}
                onDiff={
                  selected.relative_sql_path
                    ? () => setDiffFor({ path: selected.relative_sql_path!, name: selected.name })
                    : undefined
                }
                running={runningModel === selected.unique_id}
              />
            )}
          </div>
        </>
      )}

      {/* Freshness view — flat table of every source with declared
          freshness config + last-run status. Empty when the user
          hasn't run `dbt source freshness` yet. */}
      {data && view === 'freshness' && (
        <div className="px-8 py-6">
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900">Source freshness</h2>
              <span className="text-xs text-gray-500">{freshness?.sources.length ?? 0} sources</span>
            </div>
            {!freshness || freshness.sources.length === 0 ? (
              <div className="p-8 text-center">
                <Clock className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-600 mb-2">No sources declared in this dbt project.</p>
                <p className="text-xs text-gray-500">
                  Add <code className="bg-gray-100 px-1 rounded">sources:</code> blocks to your <code>schema.yml</code> and run{' '}
                  <code className="bg-gray-100 px-1 rounded">dbt source freshness</code> to populate this view.
                </p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Source</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Schema</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Timestamp column</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Warn / Error after</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Last loaded</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {freshness.sources.map((s) => (
                    <tr key={s.unique_id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 font-mono text-gray-900">{s.source_name}.{s.table_name}</td>
                      <td className="px-4 py-2.5 text-xs font-mono text-gray-700">{s.schema ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs font-mono text-gray-700">{s.loaded_at_field ?? <span className="italic text-gray-400">not declared</span>}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {s.max_loaded_at_field_pass ? (
                          <div className="text-amber-700">warn: {s.max_loaded_at_field_pass.count} {s.max_loaded_at_field_pass.period}</div>
                        ) : null}
                        {s.max_loaded_at_field_error ? (
                          <div className="text-rose-700">err: {s.max_loaded_at_field_error.count} {s.max_loaded_at_field_error.period}</div>
                        ) : null}
                        {!s.max_loaded_at_field_pass && !s.max_loaded_at_field_error && (
                          <span className="italic text-gray-400">no thresholds</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-700">
                        {s.last_loaded_at ? (
                          <>
                            <div>{new Date(s.last_loaded_at).toLocaleString()}</div>
                            {s.max_age_seconds != null && (
                              <div className="text-[10px] text-gray-500">{formatDuration(s.max_age_seconds)} ago</div>
                            )}
                          </>
                        ) : (
                          <span className="italic text-gray-400">never</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <FreshnessPill status={s.last_run_status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      <AddDbtModelDialog
        open={showAddModel}
        onOpenChange={setShowAddModel}
        projectId={currentProject.id}
        onCreated={async (sqlPath) => {
          if (onOpenFile) onOpenFile(sqlPath);
          await refresh();
        }}
      />
      {diffFor && data?.dbt_project_relative_path && (
        <SqlDiffDialog
          open={!!diffFor}
          onOpenChange={(o) => !o && setDiffFor(null)}
          projectId={currentProject.id}
          dbtRelativePath={data.dbt_project_relative_path}
          relativeSqlPath={diffFor.path}
          title={diffFor.name}
        />
      )}
      <GitCommitDialog
        open={showGitCommit}
        onOpenChange={setShowGitCommit}
        projectId={currentProject.id}
        subpath={data?.dbt_project_relative_path}
        defaultMessage="Update dbt models"
      />
    </div>
  );
}

function LastRunPill({ status, durationMs }: { status: string | null; durationMs: number | null }) {
  if (!status) {
    return <span className="text-[11px] text-gray-400 italic">never run</span>;
  }
  const norm = status.toLowerCase();
  const ok = norm === 'success' || norm === 'pass';
  const fail = norm === 'error' || norm === 'fail' || norm === 'runtime error';
  const skip = norm === 'skipped';
  const Icon = ok ? CheckCircle2 : fail ? XCircle : AlertTriangle;
  const tone = ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : fail ? 'bg-rose-50 text-rose-700 border-rose-200'
    : skip ? 'bg-gray-100 text-gray-700 border-gray-200'
    : 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${tone}`}>
      <Icon className="w-3 h-3" />
      {status}
      {durationMs != null && <span className="text-[10px] opacity-70">· {(durationMs / 1000).toFixed(1)}s</span>}
    </span>
  );
}

function ModelDetail({
  model,
  dbtRelativePath,
  runOutput,
  lineage,
  onOpenFile,
  onClose,
  onRun,
  onDiff,
  running,
}: {
  model: Model;
  dbtRelativePath: string;
  runOutput: { stdout: string; stderr: string; success: boolean } | null;
  lineage: Awaited<ReturnType<typeof projectsApi.getDbtColumnLineage>> | null;
  onOpenFile?: (path: string) => void;
  onClose: () => void;
  onRun: () => void;
  onDiff?: () => void;
  running: boolean;
}) {
  const cols = Object.entries(model.columns);
  // Column-level edges scoped to this model — group by which output
  // column they feed so users see "col X ← foo.col_a, bar.col_b".
  const incomingByCol = useMemo(() => {
    const map = new Map<string, Array<{ from_unique_id: string; from_column: string; confidence: number }>>();
    for (const e of lineage?.edges ?? []) {
      if (e.to_unique_id !== model.unique_id) continue;
      if (!map.has(e.to_column)) map.set(e.to_column, []);
      map.get(e.to_column)!.push({ from_unique_id: e.from_unique_id, from_column: e.from_column, confidence: e.confidence });
    }
    return map;
  }, [lineage, model.unique_id]);
  const outgoingByCol = useMemo(() => {
    const map = new Map<string, Array<{ to_unique_id: string; to_column: string; confidence: number }>>();
    for (const e of lineage?.edges ?? []) {
      if (e.from_unique_id !== model.unique_id) continue;
      if (!map.has(e.from_column)) map.set(e.from_column, []);
      map.get(e.from_column)!.push({ to_unique_id: e.to_unique_id, to_column: e.to_column, confidence: e.confidence });
    }
    return map;
  }, [lineage, model.unique_id]);
  return (
    <div className="w-[420px] flex-shrink-0 bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col self-start max-h-[calc(100vh-260px)]">
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm font-semibold text-gray-900 truncate" title={model.name}>
            {model.name}
          </div>
          <div className="text-[11px] text-gray-500 font-mono truncate" title={model.unique_id}>
            {model.unique_id}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-700 rounded"
        >
          ✕
        </button>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto flex-1">
        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onRun}
            disabled={running}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-40"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            {running ? 'Running…' : 'Run'}
          </button>
          {model.relative_sql_path && (
            <button
              onClick={() => onOpenFile?.(`${dbtRelativePath}/${model.relative_sql_path!}`)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
            >
              <FileText className="w-3 h-3" /> Open SQL
            </button>
          )}
          {onDiff && (
            <button
              onClick={onDiff}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
              title="Diff working copy vs HEAD"
            >
              <GitCompare className="w-3 h-3" /> Diff
            </button>
          )}
        </div>

        {/* Facts */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Fact label="Materialization" value={model.materialization ?? '—'} mono />
          <Fact label="Schema" value={model.schema ?? '—'} mono />
          <Fact label="Package" value={model.package_name ?? '—'} mono />
          <Fact label="Row count" value={model.row_count != null ? model.row_count.toLocaleString() : '—'} />
          <Fact label="Bytes" value={model.bytes_bytes != null ? formatBytes(model.bytes_bytes) : '—'} />
          <Fact label="Tests" value={String(model.tests.length)} />
        </div>

        {/* Description */}
        <section>
          <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Description</h4>
          {model.description ? (
            <p className="text-xs text-gray-700 whitespace-pre-wrap">{model.description}</p>
          ) : (
            <p className="text-xs text-gray-400 italic">
              Not documented yet — add a <code className="bg-gray-100 px-1 rounded">description</code> field in the model's schema.yml.
            </p>
          )}
        </section>

        {/* Columns */}
        <section>
          <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Columns ({cols.length})</h4>
          {cols.length === 0 ? (
            <p className="text-xs text-gray-400 italic">
              No column-level docs found. Run <code className="bg-gray-100 px-1 rounded">dbt docs generate</code> to populate the catalog.
            </p>
          ) : (
            <div className="space-y-1.5">
              {cols.slice(0, 20).map(([name, col]) => (
                <div key={name} className="rounded border border-gray-100 bg-gray-50 p-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-xs text-gray-900">{name}</span>
                    {col.data_type && (
                      <span className="text-[10px] uppercase text-gray-500">{col.data_type}</span>
                    )}
                    {col.tests?.length > 0 && (
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-700">
                        <TestTube2 className="w-3 h-3" /> {col.tests.length}
                      </span>
                    )}
                  </div>
                  {col.description && (
                    <p className="text-[11px] text-gray-600 mt-1">{col.description}</p>
                  )}
                </div>
              ))}
              {cols.length > 20 && (
                <p className="text-[11px] text-gray-500 italic">
                  +{cols.length - 20} more columns
                </p>
              )}
            </div>
          )}
        </section>

        {/* Dependencies */}
        {model.depends_on_nodes.length > 0 && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Depends on</h4>
            <div className="flex flex-wrap gap-1">
              {model.depends_on_nodes.map((d) => (
                <span key={d} className="px-1.5 py-0.5 text-[10px] rounded bg-blue-50 border border-blue-200 text-blue-700 font-mono">
                  {d.replace(/^(model|source|seed)\./, '')}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Column-level lineage — heuristic edges parsed from manifest.
            Incoming shows "what feeds each output col"; outgoing shows
            "who reads each of my cols". Confidence is dimmed for
            uncertain edges (0.5 = SQL-text match, 1.0 = name match). */}
        {(incomingByCol.size > 0 || outgoingByCol.size > 0) && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Column lineage</h4>
            <div className="space-y-2">
              {incomingByCol.size > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 mb-1">Incoming — reads from</div>
                  <div className="space-y-1">
                    {Array.from(incomingByCol.entries()).slice(0, 12).map(([col, srcs]) => (
                      <div key={col} className="text-[11px] flex items-start gap-1.5">
                        <span className="font-mono text-gray-900 flex-shrink-0">{col}</span>
                        <span className="text-gray-400 flex-shrink-0">←</span>
                        <div className="flex flex-wrap gap-1 min-w-0">
                          {srcs.slice(0, 4).map((s, i) => (
                            <span
                              key={i}
                              className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-50 border border-emerald-200 text-emerald-700 font-mono"
                              style={{ opacity: 0.5 + s.confidence * 0.5 }}
                              title={`Confidence ${Math.round(s.confidence * 100)}%`}
                            >
                              {s.from_unique_id.replace(/^(model|source|seed)\./, '')}.
                              <span className="text-emerald-900">{s.from_column}</span>
                            </span>
                          ))}
                          {srcs.length > 4 && (
                            <span className="text-[10px] text-gray-400 self-center">+{srcs.length - 4}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {outgoingByCol.size > 0 && (
                <div>
                  <div className="text-[10px] text-gray-500 mb-1">Outgoing — read by</div>
                  <div className="space-y-1">
                    {Array.from(outgoingByCol.entries()).slice(0, 12).map(([col, targets]) => (
                      <div key={col} className="text-[11px] flex items-start gap-1.5">
                        <span className="font-mono text-gray-900 flex-shrink-0">{col}</span>
                        <span className="text-gray-400 flex-shrink-0">→</span>
                        <div className="flex flex-wrap gap-1 min-w-0">
                          {targets.slice(0, 4).map((t, i) => (
                            <span
                              key={i}
                              className="px-1.5 py-0.5 text-[10px] rounded bg-blue-50 border border-blue-200 text-blue-700 font-mono"
                              style={{ opacity: 0.5 + t.confidence * 0.5 }}
                              title={`Confidence ${Math.round(t.confidence * 100)}%`}
                            >
                              {t.to_unique_id.replace(/^(model|source|seed)\./, '')}.
                              <span className="text-blue-900">{t.to_column}</span>
                            </span>
                          ))}
                          {targets.length > 4 && (
                            <span className="text-[10px] text-gray-400 self-center">+{targets.length - 4}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-[10px] text-gray-400 italic">
                Heuristic lineage — pale chips are lower confidence. Add column docs to schema.yml for tighter matching.
              </p>
            </div>
          </section>
        )}

        {/* Run output */}
        {runOutput && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
              Last run output {runOutput.success ? '✓' : '✗'}
            </h4>
            <pre className={`text-[11px] font-mono p-2 rounded max-h-64 overflow-auto whitespace-pre-wrap ${
              runOutput.success ? 'bg-emerald-50 border border-emerald-200 text-emerald-900' : 'bg-rose-50 border border-rose-200 text-rose-900'
            }`}>
              {(runOutput.stdout || runOutput.stderr || '(no output)').slice(-4000)}
            </pre>
          </section>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  icon: any;
  tone: 'neutral' | 'success' | 'warning';
}) {
  const toneClasses = {
    neutral: 'text-gray-500 bg-gray-100',
    success: 'text-emerald-600 bg-emerald-50',
    warning: 'text-amber-600 bg-amber-50',
  }[tone];
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${toneClasses}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs text-gray-500 uppercase tracking-wider font-medium">{label}</div>
        <div className="flex items-baseline gap-1.5 mt-0.5">
          <div className="text-2xl font-semibold text-gray-900 tabular-nums">{value.toLocaleString()}</div>
          {hint && <div className="text-xs text-gray-500">{hint}</div>}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`text-gray-800 ${mono ? 'font-mono' : ''} break-all`}>{value}</span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function FreshnessPill({ status }: { status: string | null }) {
  if (!status) {
    return <span className="text-[11px] text-gray-400 italic">not checked</span>;
  }
  const n = status.toLowerCase();
  const ok = n === 'pass';
  const warn = n === 'warn';
  const err = n === 'error' || n === 'fail' || n === 'runtime error';
  const Icon = ok ? CheckCircle2 : err ? XCircle : AlertTriangle;
  const tone = ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : warn ? 'bg-amber-50 text-amber-700 border-amber-200'
    : err ? 'bg-rose-50 text-rose-700 border-rose-200'
    : 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${tone}`}>
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}
