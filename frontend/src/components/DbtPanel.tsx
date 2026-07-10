import { useEffect, useMemo, useState } from 'react';
import { FileCode, Play, Loader2, CheckCircle2, XCircle, AlertTriangle, TestTube2, Book, FileText, Search, Layers, GitCommit, GitCompare, Clock, Eye, DollarSign, X, Network, Filter, Share2, ExternalLink, Sparkles } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';
import { AddDbtModelDialog } from './AddDbtModelDialog';
import { GitCommitDialog } from './GitCommitDialog';
import { SqlDiffDialog } from './SqlDiffDialog';
import { DbtLineageView } from './DbtLineageView';
import { DbtColumnLineageOverlay } from './DbtColumnLineageOverlay';

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
  const [view, setView] = useState<'models' | 'lineage' | 'docs' | 'selectors' | 'exposures' | 'freshness'>('models');
  // Docs / selectors / exposures — fetched lazily when the user visits
  // the tab. Small responses so we can also grab them proactively if
  // ever needed.
  const [docs, setDocs] = useState<Awaited<ReturnType<typeof projectsApi.getDbtDocs>> | null>(null);
  const [selectors, setSelectors] = useState<Awaited<ReturnType<typeof projectsApi.getDbtSelectors>> | null>(null);
  const [exposures, setExposures] = useState<Awaited<ReturnType<typeof projectsApi.getDbtExposures>> | null>(null);
  const [runningSelector, setRunningSelector] = useState<string | null>(null);
  const [scaffoldingDocs, setScaffoldingDocs] = useState(false);
  const [generatingDocs, setGeneratingDocs] = useState(false);
  // Column-lineage modal — opened from the drawer's action row. Holds
  // the focal model so the modal is standalone and can outlive the
  // drawer (users often want to keep the modal open while switching
  // models in the drawer isn't a supported flow yet).
  const [columnLineageFor, setColumnLineageFor] = useState<Model | null>(null);
  const [freshness, setFreshness] = useState<Awaited<ReturnType<typeof projectsApi.getDbtSourceFreshness>> | null>(null);
  const [runningModified, setRunningModified] = useState(false);
  // A Dagster project can orchestrate multiple dbt projects (e.g. a
  // shared warehouse repo + a domain-specific one). We fetch them all
  // up front so the header can offer a picker.
  const [dbtProjects, setDbtProjects] = useState<Awaited<ReturnType<typeof projectsApi.listDbtProjects>>['projects']>([]);
  const [selectedDbtPath, setSelectedDbtPath] = useState<string>('');
  // Query preview modal state — populated by clicking "Preview data"
  // in the drawer. Runs `dbt show --select <name> --limit N`.
  const [previewOf, setPreviewOf] = useState<Model | null>(null);
  const [previewData, setPreviewData] = useState<Awaited<ReturnType<typeof projectsApi.previewDbtModel>> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Cost data — parsed from run_results.json's adapter_response.
  const [cost, setCost] = useState<Awaited<ReturnType<typeof projectsApi.getDbtCost>> | null>(null);

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
    const dbtPath = data.dbt_project_relative_path;
    projectsApi.getDbtColumnLineage(currentProject.id, dbtPath).then((r) => {
      if (!cancelled) setLineage(r);
    }).catch(() => {});
    projectsApi.getDbtSourceFreshness(currentProject.id, dbtPath).then((r) => {
      if (!cancelled) setFreshness(r);
    }).catch(() => {});
    projectsApi.getDbtCost(currentProject.id, dbtPath).then((r) => {
      if (!cancelled) setCost(r);
    }).catch(() => {});
    projectsApi.getDbtDocs(currentProject.id, dbtPath).then((r) => {
      if (!cancelled) setDocs(r);
    }).catch(() => {});
    projectsApi.getDbtSelectors(currentProject.id, dbtPath).then((r) => {
      if (!cancelled) setSelectors(r);
    }).catch(() => {});
    projectsApi.getDbtExposures(currentProject.id, dbtPath).then((r) => {
      if (!cancelled) setExposures(r);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id, data?.dbt_project_relative_path]);

  // "Scaffold docs" — bootstraps models/overview.md from the manifest
  // when the user lands on an empty Docs tab. Safe to click even when
  // an overview already exists (backend leaves it alone).
  const scaffoldDocs = async () => {
    if (!currentProject || !data?.dbt_project_relative_path) return;
    setScaffoldingDocs(true);
    try {
      const r = await projectsApi.scaffoldDbtDocs(currentProject.id, {
        dbt_relative_path: data.dbt_project_relative_path,
        generate_blocks: true,
      });
      if (r.overview_written) notify.success(`Wrote ${r.overview_written}`);
      else if (r.already_existed) notify.info('overview.md already exists — left it alone');
      if (r.blocks_written) notify.success(`Wrote ${r.blocks_written} with per-model doc blocks`);
      // Refresh the docs view so the new content shows immediately.
      const dbtPath = data.dbt_project_relative_path;
      const d = await projectsApi.getDbtDocs(currentProject.id, dbtPath);
      setDocs(d);
    } catch (e: any) {
      notify.error(`Scaffold failed: ${e?.response?.data?.detail || e?.message || e}`);
    } finally {
      setScaffoldingDocs(false);
    }
  };

  // "Run dbt docs generate" — populates target/catalog.json from the
  // warehouse, which enriches Column types / row counts / byte sizes.
  const generateDocsFromDbt = async () => {
    if (!currentProject || !data?.dbt_project_relative_path) return;
    setGeneratingDocs(true);
    try {
      const r = await projectsApi.generateDbtDocs(currentProject.id, {
        dbt_relative_path: data.dbt_project_relative_path,
      });
      if (r.success) notify.success(`dbt docs generate finished in ${(r.duration_ms / 1000).toFixed(1)}s`);
      else notify.error('dbt docs generate failed — check the terminal or run it locally to diagnose.');
      // Refresh models so the new catalog data lights up column types etc.
      refresh();
    } catch (e: any) {
      notify.error(`Docs generate failed: ${e?.response?.data?.detail || e?.message || e}`);
    } finally {
      setGeneratingDocs(false);
    }
  };

  // "Run selector" — dbt build --selector <name>. Uses the same runner
  // endpoint as the model actions; the CLI is happy with `--selector`
  // in place of `--select`.
  const runSelector = async (name: string) => {
    if (!currentProject || !data?.dbt_project_relative_path) return;
    setRunningSelector(name);
    try {
      // dbt CLI takes `--selector <name>` for saved selectors. Our
      // /dbt/run endpoint accepts a `select` string — pass the flag
      // form so the CLI resolves the saved selector.
      const r = await projectsApi.runDbtModel(currentProject.id, {
        dbt_relative_path: data.dbt_project_relative_path,
        select: `selector:${name}`,
      });
      if (r.success) notify.success(`Selector "${name}" built in ${(r.duration_ms / 1000).toFixed(1)}s`);
      else notify.error(`Selector "${name}" failed. Check the run output for details.`);
    } catch (e: any) {
      notify.error(`Selector run failed: ${e?.message ?? e}`);
    } finally {
      setRunningSelector(null);
    }
  };

  const runPreview = async (model: Model) => {
    if (!currentProject || !data?.dbt_project_relative_path) return;
    setPreviewOf(model);
    setPreviewData(null);
    setPreviewLoading(true);
    try {
      const r = await projectsApi.previewDbtModel(currentProject.id, {
        dbt_relative_path: data.dbt_project_relative_path,
        model_name: model.name,
        limit: 100,
      });
      setPreviewData(r);
    } catch (e: any) {
      setPreviewData({
        success: false,
        columns: [], dtypes: {}, data: [], row_count: 0, compiled_sql: null,
        error: e?.response?.data?.detail || e?.message || String(e),
        duration_ms: 0,
      });
    } finally {
      setPreviewLoading(false);
    }
  };
  // Look up per-model cost data by unique_id — used in the drawer.
  const costByUid = useMemo(() => {
    const m = new Map<string, Awaited<ReturnType<typeof projectsApi.getDbtCost>>['per_model'][number]>();
    for (const c of cost?.per_model ?? []) m.set(c.unique_id, c);
    return m;
  }, [cost]);

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

      {/* Full-tab bar — sits on its own row under the header, styled like
          the Automation panel's tabs (blue underline for active). Gives
          each dbt sub-surface real presence instead of a tiny pill. */}
      <div className="bg-white border-b border-gray-200 px-8">
        <div className="flex items-center gap-1">
          {([
            { v: 'models',    label: 'Models',    icon: Layers },
            { v: 'lineage',   label: 'Lineage',   icon: Network },
            { v: 'docs',      label: 'Docs',      icon: Book },
            { v: 'selectors', label: 'Selectors', icon: Filter },
            { v: 'exposures', label: 'Exposures', icon: Share2 },
            { v: 'freshness', label: 'Freshness', icon: Clock },
          ] as const).map(({ v, label, icon: Icon }) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`inline-flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                view === v
                  ? 'text-blue-600 border-blue-600'
                  : 'text-gray-600 border-transparent hover:text-gray-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
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
          <p className="text-sm text-gray-700 font-medium">No dbt project detected in this Dagster project</p>
          <p className="text-xs text-gray-500 mt-1 mb-3">
            Import a dbt repo at project creation, or scaffold a new model right here to bootstrap one.
          </p>
          <p className="text-[11px] text-amber-700 mb-4">
            If you know you have a dbt project here, <strong>restart the backend</strong> so the new dbt endpoints load — this tab needs them.
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

          {/* Cost summary — shown when at least one run has surfaced
              adapter_response numbers. Empty projects skip the strip. */}
          {cost && (cost.total_bytes > 0 || cost.total_usd > 0) && (
            <div className="px-8 pb-3">
              <div className="p-3 bg-white border border-gray-200 rounded-lg flex items-center gap-4 text-xs">
                <DollarSign className="w-4 h-4 text-emerald-600" />
                <div>
                  <div className="text-gray-900 font-medium">
                    ~${cost.total_usd.toFixed(4)} across {cost.per_model.length} model{cost.per_model.length === 1 ? '' : 's'}
                    <span className="text-gray-500 font-normal ml-2">
                      · {formatBytes(cost.total_bytes)} scanned · {cost.total_rows.toLocaleString()} rows processed
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">{cost.pricing_note}</div>
                </div>
              </div>
            </div>
          )}

          {/* Search + table. Drawer is now a fixed-position overlay
              rendered once at the bottom of the panel, so the table
              stays full-width. */}
          <div className="px-8 pb-8">
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
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

          </div>
        </>
      )}

      {/* Lineage view — full-bleed DAG, styled like the asset graph.
          No card / no subheader; the DbtPanel header already labels
          the surface. Clicking a node opens the shared detail drawer
          (rendered once at the bottom of the panel). */}
      {data && view === 'lineage' && data.dbt_project_relative_path && (
        <div className="relative bg-white" style={{ height: 'calc(100vh - 130px)' }}>
          <DbtLineageView
            models={data.models}
            onModelClick={(uid) => setSelectedUniqueId(uid)}
            selectedUniqueId={selectedUniqueId}
          />
          {/* Model count badge, mirroring the asset graph's status pill. */}
          <div className="absolute top-3 left-3 px-2 py-1 text-[11px] text-gray-600 bg-white/95 border border-gray-200 rounded shadow-sm pointer-events-none">
            {data.models.length} models · click a node to inspect
          </div>
        </div>
      )}

      {/* Docs view — renders overview.md + every {% docs %} block found
          in the dbt project. Bare-bones markdown to keep the surface
          predictable; users open the underlying files if they want the
          full editor. */}
      {data && view === 'docs' && (
        <div className="px-8 py-6 space-y-4">
          {/* Docs action strip — bootstrap overview from manifest, run
              `dbt docs generate` to refresh catalog.json. Both are safe
              to re-run. */}
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900">Docs actions</div>
              <div className="text-[11px] text-gray-500">
                Scaffold generates <code className="bg-gray-100 px-1 rounded">models/overview.md</code> + a per-model
                doc-blocks file from the manifest. Generate calls dbt's <code className="bg-gray-100 px-1 rounded">docs generate</code> for
                warehouse metadata (column types, row counts).
              </div>
            </div>
            <button
              onClick={scaffoldDocs}
              disabled={scaffoldingDocs}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              title="Bootstrap overview.md + doc blocks from the current manifest"
            >
              {scaffoldingDocs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Book className="w-4 h-4" />}
              Scaffold overview
            </button>
            <button
              onClick={generateDocsFromDbt}
              disabled={generatingDocs}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md disabled:opacity-50"
              title="Run `dbt docs generate` — populates target/catalog.json from the warehouse"
            >
              {generatingDocs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run dbt docs generate
            </button>
          </div>

          {docs?.overview_markdown ? (
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                  <Book className="w-4 h-4 text-orange-500" /> Project overview
                </h2>
                {docs.overview_relative_path && (
                  <button
                    onClick={() => onOpenFile?.(`${docs.dbt_project_relative_path}/${docs.overview_relative_path}`)}
                    className="text-[11px] text-gray-500 hover:text-gray-800 font-mono"
                  >
                    {docs.overview_relative_path}
                  </button>
                )}
              </div>
              <SimpleMarkdown text={docs.overview_markdown} />
            </div>
          ) : (
            <div className="bg-white border border-dashed border-gray-300 rounded-lg p-8 text-center">
              <Book className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-700 font-medium">No project overview yet</p>
              <p className="text-xs text-gray-500 mt-1 mb-3">
                Click <strong>Scaffold overview</strong> above to bootstrap
                <code className="bg-gray-100 px-1 rounded">models/overview.md</code> from your current manifest.
              </p>
              <button
                onClick={scaffoldDocs}
                disabled={scaffoldingDocs}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50"
              >
                {scaffoldingDocs ? <Loader2 className="w-4 h-4 animate-spin" /> : <Book className="w-4 h-4" />}
                Scaffold overview
              </button>
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-orange-500" /> Doc blocks
              </h2>
              <span className="text-xs text-gray-500">{docs?.blocks.length ?? 0} blocks</span>
            </div>
            {!docs || docs.blocks.length === 0 ? (
              <div className="p-8 text-center text-xs text-gray-500">
                No <code className="bg-gray-100 px-1 rounded">{'{% docs %}'}</code> blocks found.
                Add reusable descriptions in a .md file and reference them from schema.yml
                with <code className="bg-gray-100 px-1 rounded">{`{{ doc('block_name') }}`}</code>.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {docs.blocks.map((b) => (
                  <li key={`${b.relative_path}::${b.name}`} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-gray-900">{b.name}</span>
                      <button
                        onClick={() => onOpenFile?.(`${docs.dbt_project_relative_path}/${b.relative_path}`)}
                        className="text-[10px] text-gray-500 hover:text-gray-800 font-mono"
                      >
                        {b.relative_path}
                      </button>
                    </div>
                    <div className="mt-1">
                      <SimpleMarkdown text={b.content} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Selectors — saved `--select` recipes from selectors.yml.
          One-click run with dbt build --selector <name>. */}
      {data && view === 'selectors' && (
        <div className="px-8 py-6">
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                  <Filter className="w-4 h-4 text-orange-500" /> Saved selectors
                </h2>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Selectors defined in <code className="bg-gray-100 px-1 rounded">selectors.yml</code> — click to run.
                </p>
              </div>
              <span className="text-xs text-gray-500">{selectors?.selectors.length ?? 0}</span>
            </div>
            {!selectors || selectors.selectors.length === 0 ? (
              <div className="p-8 text-center text-xs text-gray-500">
                No selectors defined. Create <code className="bg-gray-100 px-1 rounded">selectors.yml</code> at the
                dbt project root to save reusable <code>--select</code> recipes.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {selectors.selectors.map((s) => (
                  <li key={s.name} className="px-4 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-sm font-semibold text-gray-900">{s.name}</span>
                        {s.default && (
                          <span className="px-1 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 font-mono">default</span>
                        )}
                      </div>
                      {s.description && (
                        <p className="text-xs text-gray-600 mt-1">{s.description}</p>
                      )}
                      <pre className="text-[10px] font-mono text-gray-500 bg-gray-50 border border-gray-100 rounded p-2 mt-2 overflow-auto max-h-32">
                        {JSON.stringify(s.definition, null, 2)}
                      </pre>
                    </div>
                    <button
                      onClick={() => runSelector(s.name)}
                      disabled={runningSelector === s.name}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-40 flex-shrink-0"
                    >
                      {runningSelector === s.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                      {runningSelector === s.name ? 'Running…' : 'Run'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Exposures — declared downstream consumers (dashboards, ML
          models, notebooks). Read straight from manifest.json. */}
      {data && view === 'exposures' && (
        <div className="px-8 py-6">
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                  <Share2 className="w-4 h-4 text-orange-500" /> Exposures
                </h2>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Downstream consumers of this dbt project — dashboards, ML models, notebooks.
                </p>
              </div>
              <span className="text-xs text-gray-500">{exposures?.exposures.length ?? 0}</span>
            </div>
            {!exposures || exposures.exposures.length === 0 ? (
              <div className="p-8 text-center text-xs text-gray-500">
                No exposures declared. Add <code className="bg-gray-100 px-1 rounded">exposures:</code> blocks to
                your schema.yml to document downstream consumers.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {exposures.exposures.map((e) => (
                  <li key={e.unique_id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-sm font-semibold text-gray-900">{e.name}</span>
                          {e.type && (
                            <span className="px-1.5 py-0.5 text-[10px] rounded bg-indigo-50 border border-indigo-200 text-indigo-700 font-mono">
                              {e.type}
                            </span>
                          )}
                          {e.maturity && (
                            <span className="text-[10px] text-gray-500">· {e.maturity}</span>
                          )}
                        </div>
                        {e.description && (
                          <p className="text-xs text-gray-700 mt-1">{e.description}</p>
                        )}
                        {(e.owner_name || e.owner_email) && (
                          <p className="text-[11px] text-gray-500 mt-1">
                            Owner: {e.owner_name}{e.owner_email && ` <${e.owner_email}>`}
                          </p>
                        )}
                        {e.depends_on_nodes.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {e.depends_on_nodes.slice(0, 8).map((d) => (
                              <span key={d} className="px-1.5 py-0.5 text-[10px] rounded bg-blue-50 border border-blue-200 text-blue-700 font-mono">
                                {d.replace(/^(model|source|seed)\./, '')}
                              </span>
                            ))}
                            {e.depends_on_nodes.length > 8 && (
                              <span className="text-[10px] text-gray-500 self-center">+{e.depends_on_nodes.length - 8}</span>
                            )}
                          </div>
                        )}
                      </div>
                      {e.url && (
                        <a
                          href={e.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50 flex-shrink-0"
                        >
                          <ExternalLink className="w-3 h-3" /> Open
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
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

      {/* Query result preview modal — dbt show compiles + executes. */}
      {previewOf && (
        <PreviewModal
          model={previewOf}
          preview={previewData}
          loading={previewLoading}
          onClose={() => { setPreviewOf(null); setPreviewData(null); }}
          onRerun={() => runPreview(previewOf)}
        />
      )}
      <GitCommitDialog
        open={showGitCommit}
        onOpenChange={setShowGitCommit}
        projectId={currentProject.id}
        subpath={data?.dbt_project_relative_path}
        defaultMessage="Update dbt models"
      />

      {/* Shared model detail drawer — fixed overlay, works across
          Models / Lineage / Docs / Selectors / etc. Rendered once so
          the aesthetic stays consistent and the drawer never fights
          for space with the underlying view. */}
      {selected && data?.dbt_project_relative_path && (
        <ModelDetail
          model={selected}
          dbtRelativePath={data.dbt_project_relative_path}
          runOutput={runOutput?.uid === selected.unique_id ? runOutput : null}
          lineage={lineage}
          cost={costByUid.get(selected.unique_id) ?? null}
          onOpenFile={onOpenFile}
          onClose={() => setSelectedUniqueId(null)}
          onRun={() => runOne(selected)}
          onDiff={
            selected.relative_sql_path
              ? () => setDiffFor({ path: selected.relative_sql_path!, name: selected.name })
              : undefined
          }
          onPreview={() => runPreview(selected)}
          onColumnLineage={() => setColumnLineageFor(selected)}
          running={runningModel === selected.unique_id}
        />
      )}

      {/* Visual column-to-column lineage modal — opens from the drawer's
          "Column lineage" button. Standalone so users can keep it open
          while comparing models. */}
      {columnLineageFor && data?.dbt_project_relative_path && (
        <DbtColumnLineageOverlay
          projectId={currentProject.id}
          dbtRelativePath={data.dbt_project_relative_path}
          modelUniqueId={columnLineageFor.unique_id}
          modelName={columnLineageFor.name}
          onClose={() => setColumnLineageFor(null)}
        />
      )}
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
  cost,
  onOpenFile,
  onClose,
  onRun,
  onDiff,
  onPreview,
  onColumnLineage,
  running,
}: {
  model: Model;
  dbtRelativePath: string;
  runOutput: { stdout: string; stderr: string; success: boolean } | null;
  lineage: Awaited<ReturnType<typeof projectsApi.getDbtColumnLineage>> | null;
  cost: Awaited<ReturnType<typeof projectsApi.getDbtCost>>['per_model'][number] | null;
  onOpenFile?: (path: string) => void;
  onClose: () => void;
  onRun: () => void;
  onDiff?: () => void;
  onPreview?: () => void;
  onColumnLineage?: () => void;
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
  // Slide-from-right drawer — matches the IngestionsPanel drawer
  // aesthetic: fixed-position, backdrop, full height, closes on
  // click-outside. Works uniformly from Models view AND the full-bleed
  // Lineage view without special positioning.
  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <div
        className="w-[440px] max-w-full bg-white h-full shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
      <div className="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileCode className="w-4 h-4 text-orange-500 flex-shrink-0" />
            <h3 className="font-mono text-sm font-semibold text-gray-900 truncate" title={model.name}>
              {model.name}
            </h3>
          </div>
          <div className="text-[11px] text-gray-500 font-mono truncate mt-0.5" title={model.unique_id}>
            {model.unique_id}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 rounded"
          aria-label="Close"
        >
          <X className="w-4 h-4 text-gray-500" />
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
          {onPreview && (
            <button
              onClick={onPreview}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
              title="Compile the SQL and preview results against the dev warehouse (dbt show)"
            >
              <Eye className="w-3 h-3" /> Preview data
            </button>
          )}
          {onColumnLineage && (
            <button
              onClick={onColumnLineage}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
              title="Visual column-to-column lineage — bezier lines between matched columns across models"
            >
              <Sparkles className="w-3 h-3" /> Column lineage
            </button>
          )}
        </div>

        {/* Description — first-class, rendered markdown. dbt docs live
            here for most users, so treat it like docs, not a caption. */}
        <section>
          <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
            <Book className="w-3 h-3" /> Docs
          </h4>
          {model.description ? (
            <SimpleMarkdown text={model.description} />
          ) : (
            <p className="text-xs text-gray-400 italic">
              Not documented yet — add a <code className="bg-gray-100 px-1 rounded">description</code> field in the model's schema.yml.
            </p>
          )}
          {model.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {model.tags.map((t) => (
                <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-700 font-mono">
                  #{t}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Facts — compact key/value grid, no header (facts speak for themselves) */}
        <div className="grid grid-cols-2 gap-2 text-xs border-t border-gray-100 pt-3">
          <Fact label="Materialization" value={model.materialization ?? '—'} mono />
          <Fact label="Schema" value={model.schema ?? '—'} mono />
          <Fact label="Row count" value={model.row_count != null ? model.row_count.toLocaleString() : '—'} />
          <Fact label="Bytes" value={model.bytes_bytes != null ? formatBytes(model.bytes_bytes) : '—'} />
        </div>

        {/* Cost — only when at least one run has surfaced adapter numbers. */}
        {cost && (cost.bytes_processed || cost.usd_estimate || cost.rows_processed) && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
              <DollarSign className="w-3 h-3" /> Cost estimate (last run)
            </h4>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {cost.usd_estimate != null && (
                <Fact label="USD" value={`~$${cost.usd_estimate.toFixed(6)}`} />
              )}
              {cost.bytes_processed != null && (
                <Fact label="Bytes scanned" value={formatBytes(cost.bytes_processed)} />
              )}
              {cost.rows_processed != null && (
                <Fact label="Rows processed" value={cost.rows_processed.toLocaleString()} />
              )}
              {cost.slot_ms != null && (
                <Fact label="Slot time" value={`${(cost.slot_ms / 1000).toFixed(1)}s`} />
              )}
            </div>
          </section>
        )}

        {/* Tests — first-class, clickable list of individual tests with
            pass/fail from the last run. This is what users came looking
            for when they clicked the tests count on the model row. */}
        {model.tests_detail && model.tests_detail.length > 0 && (
          <section>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 flex items-center gap-1">
              <TestTube2 className="w-3 h-3" /> Tests ({model.tests_detail.length})
            </h4>
            <div className="space-y-1">
              {model.tests_detail.map((t) => (
                <TestRow key={t.unique_id} test={t} />
              ))}
            </div>
          </section>
        )}

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

        {/* Columns — collapsed by default (can get long for wide tables). */}
        <details className="group">
          <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1 hover:text-gray-700 select-none">
            <span className="transition-transform group-open:rotate-90">▸</span>
            Columns ({cols.length})
          </summary>
          <div className="mt-2">
            {cols.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                No column-level docs found. Run <code className="bg-gray-100 px-1 rounded">dbt docs generate</code> to populate the catalog.
              </p>
            ) : (
              <div className="space-y-1.5">
                {cols.slice(0, 30).map(([name, col]) => (
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
                {cols.length > 30 && (
                  <p className="text-[11px] text-gray-500 italic">
                    +{cols.length - 30} more columns
                  </p>
                )}
              </div>
            )}
          </div>
        </details>

        {/* Column lineage — collapsed by default; power-user detail. */}
        {(incomingByCol.size > 0 || outgoingByCol.size > 0) && (
          <details className="group">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1 hover:text-gray-700 select-none">
              <span className="transition-transform group-open:rotate-90">▸</span>
              Column lineage
            </summary>
            <div className="mt-2 space-y-2">
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
                Heuristic lineage — pale chips are lower confidence.
              </p>
            </div>
          </details>
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
    </div>
  );
}

/**
 * Compact single-line-per-test renderer for the drawer's Tests
 * section. Kind + column on the left, pass/fail pill on the right.
 * The unique_id becomes a tooltip so users can jump to the file if
 * needed.
 */
function TestRow({ test }: { test: NonNullable<Model['tests_detail']>[number] }) {
  const status = test.last_run_status?.toLowerCase();
  const ok = status === 'pass' || status === 'success';
  const fail = status === 'fail' || status === 'error' || status === 'runtime error';
  const warn = status === 'warn';
  const tone = ok ? 'text-emerald-700' : fail ? 'text-rose-700' : warn ? 'text-amber-700' : 'text-gray-400';
  const Icon = ok ? CheckCircle2 : fail ? XCircle : warn ? AlertTriangle : TestTube2;
  return (
    <div
      className="text-[11px] flex items-center gap-1.5 px-2 py-1 border border-gray-100 rounded hover:bg-gray-50"
      title={test.last_run_message || test.unique_id}
    >
      <Icon className={`w-3 h-3 flex-shrink-0 ${tone}`} />
      <span className="font-mono text-gray-800 truncate flex-1">
        {test.test_kind}
        {test.target_column && (
          <span className="text-gray-500">.<span className="text-gray-700">{test.target_column}</span></span>
        )}
      </span>
      {test.last_run_failures != null && test.last_run_failures > 0 && (
        <span className="text-[10px] text-rose-700 font-medium flex-shrink-0">{test.last_run_failures} failed</span>
      )}
      <span className={`text-[10px] flex-shrink-0 ${tone}`}>
        {status ? status : 'never run'}
      </span>
    </div>
  );
}

/**
 * Bare-bones markdown renderer for dbt model descriptions. Handles
 * the constructs users actually put in schema.yml: **bold**, *italic*,
 * `code`, [link](url), and paragraph breaks. Full markdown is
 * overkill here — descriptions are typically 1–5 lines.
 */
function SimpleMarkdown({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className="text-xs text-gray-700 space-y-2">
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap leading-relaxed">
          {renderInline(p)}
        </p>
      ))}
    </div>
  );
}

function renderInline(text: string): (string | JSX.Element)[] {
  // Tokenise on bold/italic/code/link, in a single pass. Order
  // matters: match bold before italic so **foo** wins over *foo*.
  const parts: (string | JSX.Element)[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      parts.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      parts.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith('`')) {
      parts.push(<code key={key++} className="bg-gray-100 px-1 rounded font-mono text-[11px]">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const url = tok.slice(cut + 2, -1);
      parts.push(
        <a
          key={key++}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline"
        >
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
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

function PreviewModal({
  model,
  preview,
  loading,
  onClose,
  onRerun,
}: {
  model: Model;
  preview: Awaited<ReturnType<typeof projectsApi.previewDbtModel>> | null;
  loading: boolean;
  onClose: () => void;
  onRerun: () => void;
}) {
  const [tab, setTab] = useState<'data' | 'sql'>('data');
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-[1000px] max-w-full h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div>
            <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
              <Eye className="w-4 h-4 text-primary" /> Preview · <span className="font-mono">{model.name}</span>
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              {preview?.success
                ? <>{preview.row_count} rows returned in {(preview.duration_ms / 1000).toFixed(1)}s</>
                : loading
                  ? 'Running dbt show…'
                  : 'Compile + execute against the dev warehouse — read-only.'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onRerun}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
            >
              Rerun
            </button>
            <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" aria-label="Close">
              <X className="w-4 h-4 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-100 bg-gray-50 flex items-center px-2 gap-0.5">
          {(['data', 'sql'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-xs rounded-t ${tab === t ? 'bg-white text-gray-900 border-t border-l border-r border-gray-200 border-b-white -mb-px' : 'text-gray-600 hover:text-gray-800'}`}
            >
              {t === 'data' ? 'Data' : 'Compiled SQL'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="h-full flex items-center justify-center text-sm text-gray-500 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Running dbt show…
            </div>
          )}
          {!loading && preview && !preview.success && (
            <div className="p-4">
              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-xs font-mono text-rose-900 whitespace-pre-wrap max-h-full overflow-auto">
                {preview.error || 'Unknown error'}
              </div>
            </div>
          )}
          {!loading && preview && preview.success && tab === 'data' && (
            preview.columns.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">
                Query returned no columns. Check the model's SQL.
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} className="text-left px-3 py-2 font-medium text-gray-700 whitespace-nowrap">
                        <div>{c}</div>
                        {preview.dtypes[c] && (
                          <div className="text-[10px] font-normal text-gray-400">{preview.dtypes[c]}</div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.data.map((row, i) => (
                    <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}>
                      {preview.columns.map((c) => {
                        const v = row[c];
                        return (
                          <td key={c} className="px-3 py-1.5 text-gray-800 border-b border-gray-100 max-w-xs truncate" title={String(v ?? '')}>
                            {v === null || v === undefined ? <span className="italic text-gray-400">null</span> : String(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {!loading && preview && preview.success && tab === 'sql' && (
            <pre className="p-3 text-xs font-mono text-gray-800 whitespace-pre-wrap">
              {preview.compiled_sql || <span className="text-gray-400 italic">Compiled SQL not available.</span>}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
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
