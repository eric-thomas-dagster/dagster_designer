import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, { Background, BackgroundVariant, Controls, MiniMap, Handle, Position, type NodeProps } from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Play, RefreshCw, Loader2, ChevronRight, ChevronLeft, ExternalLink,
  CheckCircle2, XCircle, Clock, AlertTriangle, Ban, Search, Filter as FilterIcon,
  Copy, Tag as TagIcon, Layers, FileText,
} from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { runsApi, dagsterUIApi, type Run, type RunDetail } from '@/services/api';
import { notify } from './Notifications';

/**
 * Runs surface -- paginated list of Dagster run history.
 *
 *   * Local projects: talks to `dagster dev`'s GraphQL at
 *     localhost:3000. Empty state guides users to start dev if it
 *     isn't running.
 *   * Dagster+ projects: talks to the deployment's GraphQL via our
 *     existing client. Same response shape either way.
 *
 * Pagination is cursor-based (opaque string, from the previous page's
 * last runId). Filter by status. Job-name filter is server-side too.
 * Clicking a row opens the run in the Dagster UI (local or cloud).
 */
export function RunsPanel() {
  const { currentProject } = useProjectStore();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [source, setSource] = useState<'local' | 'cloud' | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<(string | null)[]>([]);   // stack for back-nav
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // Multi-select statuses. `all` = no filter, otherwise a set of
  // Dagster status names (upper case).
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [jobFilter, setJobFilter] = useState('');
  const [codeLocation, setCodeLocation] = useState('');
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [dateFrom, setDateFrom] = useState('');   // YYYY-MM-DD
  const [dateTo, setDateTo] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [codeLocationOptions, setCodeLocationOptions] = useState<string[]>([]);
  const [tagKeyOptions, setTagKeyOptions] = useState<string[]>([]);
  const [tagValueOptions, setTagValueOptions] = useState<string[]>([]);

  const isCloud = !!(currentProject as any)?.is_dagster_plus;

  // Populate the code-location + tag-key dropdowns once per project.
  // Backend routes to local dagster dev or Dagster+ based on project.
  useEffect(() => {
    if (!currentProject) { setCodeLocationOptions([]); setTagKeyOptions([]); return; }
    let alive = true;
    runsApi.codeLocations(currentProject.id)
      .then((r) => { if (alive) setCodeLocationOptions(r.code_locations || []); })
      .catch(() => { if (alive) setCodeLocationOptions([]); });
    runsApi.tagKeys(currentProject.id)
      .then((r) => { if (alive) setTagKeyOptions(r.tag_keys || []); })
      .catch(() => { if (alive) setTagKeyOptions([]); });
    return () => { alive = false; };
  }, [currentProject?.id]);

  // Load values for the currently picked tag key. Clear when key clears.
  useEffect(() => {
    if (!currentProject || !tagKey) { setTagValueOptions([]); return; }
    let alive = true;
    runsApi.tagValues(currentProject.id, tagKey)
      .then((r) => { if (alive) setTagValueOptions(r.values || []); })
      .catch(() => { if (alive) setTagValueOptions([]); });
    return () => { alive = false; };
  }, [currentProject?.id, tagKey]);
  const limit = 25;

  const load = async (c: string | null) => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const tags: Array<{ key: string; value: string }> = [];
      if (tagKey.trim()) tags.push({ key: tagKey.trim(), value: tagValue.trim() });
      const toEpoch = (yyyyMmDd: string): number | null => {
        if (!yyyyMmDd) return null;
        const d = new Date(yyyyMmDd);
        return isNaN(d.getTime()) ? null : d.getTime() / 1000;
      };
      const r = await runsApi.query(currentProject.id, {
        limit,
        cursor: c,
        statuses: statusFilter.size > 0 ? Array.from(statusFilter) : null,
        job_name: jobFilter.trim() || null,
        code_location: codeLocation.trim() || null,
        tags: tags.length ? tags : null,
        created_after: toEpoch(dateFrom),
        created_before: toEpoch(dateTo),
      });
      setRuns(r.runs);
      setSource(r.source);
      setNextCursor(r.next_cursor);
      if (r.error) setWarning(r.error);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to load runs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Reset cursor stack whenever filters change so we're back on page 1.
    setCursor(null);
    setPrevCursors([]);
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentProject?.id,
    // Set identity changes on toggle -- serialise so useEffect fires.
    Array.from(statusFilter).sort().join(','),
    jobFilter, codeLocation, tagKey, tagValue, dateFrom, dateTo,
  ]);

  const goNext = () => {
    if (!nextCursor) return;
    setPrevCursors((p) => [...p, cursor]);
    setCursor(nextCursor);
    load(nextCursor);
  };
  const goPrev = () => {
    if (prevCursors.length === 0) return;
    const prev = prevCursors[prevCursors.length - 1];
    setPrevCursors((p) => p.slice(0, -1));
    setCursor(prev);
    load(prev);
  };

  const openRun = (run: Run) => setSelectedRunId(run.run_id);

  // Detail view replaces the list view inside the same tab -- keeps
  // the app shell (left nav, top bar) visible.
  if (selectedRunId) {
    return <RunDetailPage runId={selectedRunId} onBack={() => setSelectedRunId(null)} />;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Ribbon */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Multi-select status chips */}
            <div className="inline-flex items-center gap-1 flex-wrap">
              {(['SUCCESS', 'FAILURE', 'STARTED', 'QUEUED', 'STARTING', 'CANCELED'] as const).map((s) => {
                const active = statusFilter.has(s);
                return (
                  <button
                    key={s}
                    onClick={() => {
                      setStatusFilter((prev) => {
                        const next = new Set(prev);
                        if (next.has(s)) next.delete(s); else next.add(s);
                        return next;
                      });
                    }}
                    className={`px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded border ${
                      active
                        ? 'bg-blue-50 border-blue-400 text-blue-800'
                        : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                    }`}
                    title={`Toggle ${s.toLowerCase()} filter`}
                  >
                    {s.toLowerCase()}
                  </button>
                );
              })}
              {statusFilter.size > 0 && (
                <button
                  onClick={() => setStatusFilter(new Set())}
                  className="text-[10px] text-gray-500 hover:text-gray-800 underline decoration-dotted ml-1"
                >
                  clear
                </button>
              )}
            </div>
            <div className="relative w-52">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                value={jobFilter}
                onChange={(e) => setJobFilter(e.target.value)}
                placeholder="Filter by job name…"
                className="w-full pl-7 pr-2 py-1 text-xs border border-gray-300 rounded"
              />
            </div>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border ${showAdvanced ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}
              title="More filters"
            >
              <FilterIcon className="w-3 h-3" />
              More filters
            </button>
            {source && (
              <span className="text-[11px] text-gray-500 ml-1">
                Source: <span className="font-medium">{source === 'cloud' ? 'Dagster+' : 'Local dg dev'}</span>
              </span>
            )}
          </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(cursor)}
            disabled={loading}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={goPrev}
            disabled={prevCursors.length === 0 || loading}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Prev
          </button>
          <button
            onClick={goNext}
            disabled={!nextCursor || loading}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next <ChevronRight className="w-3.5 h-3.5" />
          </button>
          </div>
        </div>
        {showAdvanced && (
          <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-100">
            <label className="inline-flex items-center gap-1 text-[11px] text-gray-600">
              Code location
              <select
                value={codeLocation}
                onChange={(e) => setCodeLocation(e.target.value)}
                className="pl-2 pr-6 py-1 text-xs border border-gray-300 rounded bg-white"
                title="Filter by the `dagster/code_location` tag Dagster attaches to runs"
              >
                <option value="">All</option>
                {codeLocationOptions.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1 text-[11px] text-gray-600">
              Tag
              <select
                value={tagKey}
                onChange={(e) => { setTagKey(e.target.value); setTagValue(''); }}
                className="pl-2 pr-6 py-1 text-xs border border-gray-300 rounded bg-white font-mono max-w-[220px]"
                title="Filter runs by a tag key (list is populated from your project's known tag keys)"
              >
                <option value="">any key…</option>
                {tagKeyOptions.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <span className="text-xs text-gray-400">=</span>
              <select
                value={tagValue}
                onChange={(e) => setTagValue(e.target.value)}
                disabled={!tagKey}
                className="pl-2 pr-6 py-1 text-xs border border-gray-300 rounded bg-white font-mono max-w-[220px] disabled:bg-gray-100 disabled:text-gray-400"
                title={tagKey ? `Values seen for tag "${tagKey}"` : 'Pick a tag key first'}
              >
                <option value="">any value…</option>
                {tagValueOptions.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-1 text-[11px] text-gray-600">
              From
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="pl-2 pr-2 py-1 text-xs border border-gray-300 rounded"
              />
            </label>
            <label className="inline-flex items-center gap-1 text-[11px] text-gray-600">
              To
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="pl-2 pr-2 py-1 text-xs border border-gray-300 rounded"
              />
            </label>
            {(codeLocation || tagKey || dateFrom || dateTo) && (
              <button
                onClick={() => { setCodeLocation(''); setTagKey(''); setTagValue(''); setDateFrom(''); setDateTo(''); }}
                className="text-[11px] text-gray-500 hover:text-gray-800 underline decoration-dotted"
              >
                clear advanced
              </button>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
        {warning && (
          <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{warning}</span>
            </div>
            {!isCloud && (
              <StartDgDevButton onStarted={() => load(cursor)} />
            )}
          </div>
        )}
        {error && (
          <div className="mb-3 p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">
            {error}
          </div>
        )}
        {!loading && !error && runs.length === 0 && !warning && (
          <div className="text-center py-16 text-gray-500">
            <Play className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm">No runs found for the current filters.</p>
          </div>
        )}
        {runs.length > 0 && <RunsTable runs={runs} onOpen={openRun} />}
      </div>
    </div>
  );
}

function RunsTable({ runs, onOpen }: { runs: Run[]; onOpen: (r: Run) => void }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Status</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Run</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Job</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Started</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Duration</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Steps</th>
            <th className="w-12 px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <RunRow key={run.run_id} run={run} onOpen={() => onOpen(run)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const duration = useMemo(() => formatDuration(run.start_time, run.end_time), [run.start_time, run.end_time]);
  const started = useMemo(() => formatRelativeTs(run.start_time), [run.start_time]);
  return (
    <tr onClick={onOpen} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer">
      <td className="px-3 py-2"><StatusBadge status={run.status} /></td>
      <td className="px-3 py-2 font-mono text-[11px] text-gray-700 truncate max-w-[180px]" title={run.run_id}>{run.run_id.slice(0, 8)}</td>
      <td className="px-3 py-2 text-xs text-gray-800">{run.job_name || run.pipeline_name || '—'}</td>
      <td className="px-3 py-2 text-xs text-gray-700">{started}</td>
      <td className="px-3 py-2 text-xs text-gray-700 tabular-nums">{duration}</td>
      <td className="px-3 py-2 text-xs text-gray-700">
        {(run.steps_succeeded ?? 0) + (run.steps_failed ?? 0) > 0 ? (
          <span>
            <span className="text-emerald-700">{run.steps_succeeded ?? 0}</span>
            {(run.steps_failed ?? 0) > 0 && <span className="text-rose-700"> · {run.steps_failed} failed</span>}
          </span>
        ) : '—'}
      </td>
      <td className="px-3 py-2 text-right">
        <ExternalLink className="w-3.5 h-3.5 text-gray-400" />
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  // Matches Dagster's palette: blue running · green success · orange
  // retried · red failure · gray canceled/skipped.
  const s = status.toUpperCase();
  if (s === 'SUCCESS' || s === 'SUCCEEDED') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-emerald-50 border-emerald-300 text-emerald-800"><CheckCircle2 className="w-3 h-3" />success</span>;
  }
  if (s === 'FAILURE' || s === 'FAILED') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-rose-50 border-rose-300 text-rose-800"><XCircle className="w-3 h-3" />failure</span>;
  }
  if (s === 'STARTED' || s === 'RUNNING') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-blue-50 border-blue-300 text-blue-800"><Loader2 className="w-3 h-3 animate-spin" />running</span>;
  }
  if (s === 'RESTARTING' || s === 'UP_FOR_RETRY' || s === 'RETRIED' || s === 'RETRY_REQUESTED') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-amber-50 border-amber-300 text-amber-800"><RefreshCw className="w-3 h-3" />retried</span>;
  }
  if (s === 'CANCELED' || s === 'CANCELING') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-gray-100 border-gray-300 text-gray-700"><Ban className="w-3 h-3" />canceled</span>;
  }
  if (s === 'QUEUED' || s === 'STARTING' || s === 'NOT_STARTED') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-sky-50 border-sky-300 text-sky-800"><Clock className="w-3 h-3" />{s.toLowerCase()}</span>;
  }
  if (s === 'SKIPPED') {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-gray-50 border-gray-300 text-gray-600">skipped</span>;
  }
  return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-gray-100 border-gray-200 text-gray-600">{s.toLowerCase()}</span>;
}

// ---------------------------------------------------------------------------
// RunDetailPage -- native view of a single run. Fetches full detail
// (status, steps, materializations, config, tags) from the local /
// cloud Dagster GraphQL. Logs are deferred to the Dagster UI (link
// at top) since they can be huge and streaming is a separate lift.
// ---------------------------------------------------------------------------

type DetailTab = 'overview' | 'steps' | 'logs' | 'materializations' | 'config';

function RunDetailPage({ runId, onBack }: { runId: string; onBack: () => void }) {
  const { currentProject } = useProjectStore();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [polling, setPolling] = useState(false);
  // When a step row is clicked in the Steps tab, we jump to Logs with
  // that step pre-selected. Setting to 'all' clears the filter. Kept
  // here (parent) so the tab switch + filter fire together.
  const [initialLogStepFilter, setInitialLogStepFilter] = useState<string>('all');
  const jumpToStepLogs = (stepKey: string) => {
    setInitialLogStepFilter(stepKey);
    setTab('logs');
  };

  const load = async () => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    try {
      const r = await runsApi.detail(currentProject.id, runId);
      setDetail(r);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to load run.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [currentProject?.id, runId]);

  // Poll every 5s while the run is still in-flight so the user sees
  // progress without a manual refresh.
  useEffect(() => {
    if (!detail) return;
    const s = detail.status.toUpperCase();
    const running = s === 'STARTED' || s === 'STARTING' || s === 'QUEUED';
    if (!running) return;
    setPolling(true);
    const id = setInterval(load, 5000);
    return () => { clearInterval(id); setPolling(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.status]);

  if (loading && !detail) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 mb-3"><ChevronLeft className="w-3.5 h-3.5" /> Back to runs</button>
        <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error}</div>
      </div>
    );
  }
  if (!detail) return null;

  const duration = formatDuration(detail.start_time, detail.end_time);
  const started = formatRelativeTs(detail.start_time);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 border-b border-gray-200 px-6 py-3 flex items-start justify-between gap-4 bg-white">
        <div className="min-w-0 flex-1">
          <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 mb-1">
            <ChevronLeft className="w-3 h-3" /> Runs
          </button>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <span className="font-mono">{detail.run_id.slice(0, 12)}</span>
              <button
                onClick={() => { navigator.clipboard.writeText(detail.run_id); notify.success('Run id copied'); }}
                className="p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
                title="Copy full run id"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </h1>
            <StatusBadge status={detail.status} />
            {polling && (
              <span className="inline-flex items-center gap-1 text-[10px] text-blue-600">
                <Loader2 className="w-3 h-3 animate-spin" /> live
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
            <span>Job: <span className="font-medium text-gray-800">{detail.job_name || detail.pipeline_name || '—'}</span></span>
            <span>· Started {started}</span>
            <span>· {duration}</span>
            {detail.source === 'cloud' && <span className="px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700 text-[9px] uppercase tracking-wider">Dagster+</span>}
            {detail.source === 'local' && <span className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200 text-gray-700 text-[9px] uppercase tracking-wider">Local</span>}
          </div>
        </div>
        <div className="flex-shrink-0 flex items-center gap-2">
          <ReexecuteMenu runId={detail.run_id} status={detail.status} onLaunched={(newId) => { notify.success(`Launched new run ${newId.slice(0, 8)}. Opening…`); }} />
          {['STARTED', 'STARTING', 'QUEUED'].includes(detail.status.toUpperCase()) && (
            <TerminateButton runId={detail.run_id} onDone={load} />
          )}
          {detail.external_url && (
            <a
              href={detail.external_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              title="Open in Dagster UI (includes streaming logs and full timeline)"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in Dagster UI
            </a>
          )}
          <button
            onClick={load}
            className="p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 border-b border-gray-200 px-6 flex items-center gap-1">
        {(['overview', 'steps', 'logs', 'materializations', 'config'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ${
              tab === t ? 'text-blue-600 border-blue-600' : 'text-gray-600 border-transparent hover:text-gray-900'
            }`}
          >
            {t === 'materializations' ? `Materializations (${detail.materializations.length})` : t === 'steps' ? `Steps (${detail.steps.length})` : t}
          </button>
        ))}
      </div>

      <div className={`flex-1 overflow-hidden ${tab === 'logs' ? 'bg-gray-900' : 'bg-gray-50 overflow-y-auto p-6'}`}>
        {tab === 'overview' && <RunOverviewTab detail={detail} onOpenStepLogs={jumpToStepLogs} />}
        {tab === 'steps' && <RunStepsTab detail={detail} onOpenStepLogs={jumpToStepLogs} />}
        {tab === 'logs' && (
          <RunLogsTab
            runId={detail.run_id}
            runStatus={detail.status}
            initialStepFilter={initialLogStepFilter}
          />
        )}
        {tab === 'materializations' && <RunMaterializationsTab detail={detail} />}
        {tab === 'config' && <RunConfigTab detail={detail} />}
      </div>
    </div>
  );
}

// ---------- Logs ----------------------------------------------------------

interface LogRow {
  type_name: string;
  message: string | null;
  level: string | null;
  timestamp: number | null;
  step_key: string | null;
}

function RunLogsTab({ runId, runStatus, initialStepFilter = 'all' }: { runId: string; runStatus: string; initialStepFilter?: string }) {
  const { currentProject } = useProjectStore();
  const [events, setEvents] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<string>('all');
  const [stepFilter, setStepFilter] = useState<string>(initialStepFilter);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);

  // Whenever the parent hands in a fresh step filter (from a click on
  // the Steps tab), snap to it. Uses initialStepFilter as the trigger.
  useEffect(() => {
    setStepFilter(initialStepFilter);
  }, [initialStepFilter]);

  const isRunning = ['STARTED', 'STARTING', 'QUEUED'].includes(runStatus.toUpperCase());

  const fetchInitial = async () => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    try {
      const r = await runsApi.logs(currentProject.id, runId, { limit: 500 });
      setEvents(r.events);
      setCursor(r.cursor);
      if (r.error) setError(r.error);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Failed to load logs.');
    } finally {
      setLoading(false);
    }
  };

  const fetchMore = async () => {
    if (!currentProject || !cursor) return;
    setLoadingMore(true);
    try {
      const r = await runsApi.logs(currentProject.id, runId, { cursor, limit: 500 });
      setEvents((prev) => [...prev, ...r.events]);
      setCursor(r.cursor);
    } catch (e: any) {
      notify.error(e?.message || 'Failed to fetch more.');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => { fetchInitial(); /* eslint-disable-next-line */ }, [currentProject?.id, runId]);

  // Poll for new events while the run is in-flight AND auto-refresh
  // is on. Only fetches from the current cursor forward (tail-follow).
  useEffect(() => {
    if (!isRunning || !autoRefresh || !currentProject) return;
    const id = setInterval(async () => {
      if (!cursor) return;
      try {
        const r = await runsApi.logs(currentProject.id, runId, { cursor, limit: 500 });
        if (r.events.length > 0) {
          setEvents((prev) => [...prev, ...r.events]);
          setCursor(r.cursor);
        }
      } catch { /* silent poll error */ }
    }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, autoRefresh, cursor, currentProject?.id, runId]);

  const stepKeys = useMemo(() => {
    const s = new Set<string>();
    for (const e of events) if (e.step_key) s.add(e.step_key);
    return Array.from(s).sort();
  }, [events]);

  const filtered = useMemo(() => events.filter((e) => {
    if (levelFilter !== 'all' && (e.level || '').toUpperCase() !== levelFilter.toUpperCase()) return false;
    if (stepFilter !== 'all') {
      // Retry attempts carry a synthetic `#attempt-N` suffix on their
      // step_key so the DAG shows them as separate nodes. Actual log
      // events reference the original step key, so strip the suffix
      // before matching.
      const baseStep = stepFilter.replace(/#attempt-\d+$/, '');
      if (e.step_key !== baseStep) return false;
    }
    return true;
  }), [events, levelFilter, stepFilter]);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900">
      <div className="flex-shrink-0 px-4 py-2 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200 flex items-center gap-3 text-xs">
        <span className="text-gray-500 dark:text-gray-400">{filtered.length} / {events.length} events</span>
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded px-2 py-0.5 text-xs text-gray-800 dark:text-gray-200"
        >
          <option value="all">All levels</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
          <option value="CRITICAL">CRITICAL</option>
        </select>
        {stepKeys.length > 0 && (
          <select
            value={stepFilter}
            onChange={(e) => setStepFilter(e.target.value)}
            className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded px-2 py-0.5 text-xs text-gray-800 dark:text-gray-200 max-w-[220px]"
          >
            <option value="all">All steps</option>
            {stepKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
        {isRunning && (
          <label className="inline-flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            <span>Follow tail</span>
          </label>
        )}
        <div className="flex-1" />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        <button
          onClick={fetchInitial}
          disabled={loading}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          title="Reload logs from the beginning"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>
      <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed text-gray-800 dark:text-gray-200">
        {error && (
          <div className="p-3 bg-rose-50 dark:bg-rose-950 text-rose-800 dark:text-rose-200 border-b border-rose-200 dark:border-rose-800">{error}</div>
        )}
        {!loading && filtered.length === 0 && !error && (
          <div className="p-6 text-center text-gray-500 italic">No log events match the current filters.</div>
        )}
        {filtered.map((e, i) => (
          <LogLine key={i} event={e} />
        ))}
        {cursor && !isRunning && (
          <div className="p-3 border-t border-gray-100 dark:border-gray-800">
            <button
              onClick={fetchMore}
              disabled={loadingMore}
              className="text-xs text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-200 disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : 'Load more events'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function LogLine({ event }: { event: LogRow }) {
  const lvl = (event.level || '').toUpperCase();
  const levelStyle =
    lvl === 'ERROR' || lvl === 'CRITICAL' ? 'text-rose-700 dark:text-rose-400'
    : lvl === 'WARNING' ? 'text-amber-700 dark:text-amber-400'
    : lvl === 'INFO' ? 'text-blue-700 dark:text-blue-300'
    : lvl === 'DEBUG' ? 'text-gray-500'
    : 'text-gray-500 dark:text-gray-400';
  const ts = event.timestamp ? new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19) : '';
  return (
    <div className="px-3 py-0.5 hover:bg-gray-50 dark:hover:bg-gray-800/40 border-b border-gray-100 dark:border-gray-800/40 flex items-start gap-3">
      <span className="text-gray-500 tabular-nums flex-shrink-0">{ts}</span>
      {event.level && <span className={`${levelStyle} font-semibold w-14 flex-shrink-0 uppercase`}>{lvl}</span>}
      {event.step_key && <span className="text-indigo-700 dark:text-indigo-300 flex-shrink-0 truncate max-w-[160px]" title={event.step_key}>{event.step_key}</span>}
      <span className="text-gray-500 flex-shrink-0 uppercase text-[9px] tracking-wider w-40 truncate" title={event.type_name}>{event.type_name.replace(/Event$/, '')}</span>
      <span className="flex-1 whitespace-pre-wrap break-all text-gray-800 dark:text-gray-200">{event.message || <span className="text-gray-500 italic">(no message)</span>}</span>
    </div>
  );
}

function RunOverviewTab({ detail, onOpenStepLogs }: { detail: RunDetail; onOpenStepLogs: (stepKey: string) => void }) {
  const tags = Object.entries(detail.tags || {});
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-[1600px] mx-auto">
      <div className="lg:col-span-2 space-y-4">
        <Card title="Status">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Kpi label="Status" value={detail.status.toLowerCase()} />
            <Kpi label="Steps succeeded" value={detail.steps_succeeded ?? '—'} tone="success" />
            <Kpi label="Steps failed" value={detail.steps_failed ?? '—'} tone={(detail.steps_failed || 0) > 0 ? 'error' : 'neutral'} />
            <Kpi label="Materializations" value={detail.materializations.length} />
          </div>
        </Card>
        <Card title={`Steps (${detail.steps.length})`}>
          {detail.steps.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No step stats available.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {detail.steps.slice(0, 20).map((s) => (
                <li key={s.step_key} className="py-1.5 flex items-center gap-2 text-xs group">
                  <StatusBadge status={s.status} />
                  <span className="font-mono text-gray-800 flex-1 truncate">{s.step_key}</span>
                  <span className="text-gray-500 tabular-nums">{formatDuration(s.start_time, s.end_time)}</span>
                  <button
                    onClick={() => onOpenStepLogs(s.step_key)}
                    className="opacity-0 group-hover:opacity-100 text-[10px] text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap"
                    title="View logs filtered to this step"
                  >
                    Logs →
                  </button>
                </li>
              ))}
              {detail.steps.length > 20 && (
                <li className="py-1.5 text-[11px] text-gray-500 italic">+{detail.steps.length - 20} more (see Steps tab)</li>
              )}
            </ul>
          )}
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Job">
          <div className="text-xs space-y-1">
            <div><span className="text-gray-500">Name:</span> <span className="font-mono text-gray-800">{detail.job_name || detail.pipeline_name || '—'}</span></div>
            <div><span className="text-gray-500">Duration:</span> <span className="tabular-nums text-gray-800">{formatDuration(detail.start_time, detail.end_time)}</span></div>
          </div>
        </Card>
        <Card title={`Tags (${tags.length})`}>
          {tags.length === 0 ? (
            <p className="text-xs text-gray-500 italic">No tags.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {tags.map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono bg-gray-100 border border-gray-200 rounded">
                  <TagIcon className="w-2.5 h-2.5" />{k}={v}
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function RunStepsTab({ detail, onOpenStepLogs }: { detail: RunDetail; onOpenStepLogs: (stepKey: string) => void }) {
  // Split view mirrors Dagster's native run page: step visualization
  // on top (lineage / timeline / list), log stream below. Clicking a
  // step filters logs in place; clicking the SAME step again clears
  // the filter so the user can get back to the full log view without
  // hunting for a Clear button.
  const [view, setView] = useState<'lineage' | 'timeline' | 'list'>('lineage');
  const [stepFilter, setStepFilter] = useState<string>('all');
  const filterByStep = (k: string) => {
    // Toggle -- second click on the selected step clears the filter.
    setStepFilter((prev) => (prev === k ? 'all' : k));
  };
  const clearStepFilter = () => setStepFilter('all');
  const jumpToFullLogs = (k: string) => onOpenStepLogs(k);

  // Resizable split -- top pane height as a percentage of the tab
  // content area. Users drag the horizontal handle to give logs more
  // room when debugging a failure. Persisted per browser so the
  // preferred layout survives navigation.
  const [topPct, setTopPct] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('runsPanel.topPct');
      const n = saved ? Number(saved) : NaN;
      return Number.isFinite(n) && n >= 15 && n <= 85 ? n : 50;
    } catch { return 50; }
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const box = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientY - box.top) / box.height) * 100;
      const clamped = Math.max(15, Math.min(85, pct));
      setTopPct(clamped);
    };
    const onUp = () => {
      draggingRef.current = false;
      try { localStorage.setItem('runsPanel.topPct', String(topPct)); } catch { /* private mode */ }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div ref={containerRef} className="h-full flex flex-col overflow-hidden">
      {/* Top: step visualization */}
      <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50 overflow-hidden" style={{ height: `${topPct}%` }}>
        <div className="max-w-[1600px] mx-auto p-3 h-full flex flex-col">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <div className="text-sm text-gray-700">
              <span className="font-medium">{detail.steps.length}</span> step{detail.steps.length === 1 ? '' : 's'}
              {detail.step_edges.length > 0 && (
                <span className="text-xs text-gray-500 ml-2">· {detail.step_edges.length} edge{detail.step_edges.length === 1 ? '' : 's'}</span>
              )}
              {stepFilter !== 'all' && (
                <span className="ml-3 text-xs text-blue-700">
                  Logs filtered to <span className="font-mono">{stepFilter}</span> ·
                  <button onClick={clearStepFilter} className="ml-1 underline decoration-dotted hover:text-blue-900">Clear</button>
                  <span className="ml-2 text-gray-500">(click the step again to unselect)</span>
                </span>
              )}
            </div>
            <div className="inline-flex items-center bg-white border border-gray-200 rounded p-0.5">
              {(['lineage', 'timeline', 'list'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-2.5 py-1 text-xs font-medium rounded capitalize ${view === v ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'text-gray-600'}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {view === 'lineage' && <StepLineage steps={detail.steps} edges={detail.step_edges} onOpenStepLogs={filterByStep} onOpenFullLogs={jumpToFullLogs} selectedStep={stepFilter} />}
            {view === 'timeline' && <StepTimeline steps={detail.steps} onOpenStepLogs={filterByStep} selectedStep={stepFilter} />}
            {view === 'list' && <StepList steps={detail.steps} onOpenStepLogs={filterByStep} selectedStep={stepFilter} />}
          </div>
        </div>
      </div>
      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="flex-shrink-0 h-1.5 bg-gray-200 hover:bg-blue-400 cursor-ns-resize transition-colors relative group"
        title="Drag to resize"
      >
        <div className="absolute inset-x-0 -top-0.5 -bottom-0.5" />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-0.5 bg-gray-400 group-hover:bg-white rounded" />
      </div>
      {/* Bottom: logs, filtered to the selected step */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <RunLogsTab
          runId={detail.run_id}
          runStatus={detail.status}
          initialStepFilter={stepFilter}
        />
      </div>
    </div>
  );
}

/**
 * Execution-plan DAG. Longest-path layered layout: each step's x-column
 * = max(upstream column) + 1, so parallel steps stack in the same
 * column and serialized steps read left-to-right. Node color follows
 * step status; click a node to jump to Logs filtered to that step.
 */
function StepLineage({ steps, edges, onOpenStepLogs, onOpenFullLogs, selectedStep }: {
  steps: RunDetail['steps'];
  edges: RunDetail['step_edges'];
  onOpenStepLogs: (stepKey: string) => void;
  onOpenFullLogs?: (stepKey: string) => void;
  selectedStep?: string;
}) {
  const { nodes, rfEdges } = useMemo(() => {
    if (steps.length === 0) return { nodes: [] as any[], rfEdges: [] as any[] };
    // Layered layout via longest-path from step keys with no upstream.
    const outAdj = new Map<string, string[]>();
    const inDeg = new Map<string, number>();
    for (const s of steps) { outAdj.set(s.step_key, []); inDeg.set(s.step_key, 0); }
    for (const e of edges) {
      if (!outAdj.has(e.from_step) || !inDeg.has(e.to_step)) continue;
      outAdj.get(e.from_step)!.push(e.to_step);
      inDeg.set(e.to_step, (inDeg.get(e.to_step) || 0) + 1);
    }
    const layer = new Map<string, number>();
    for (const s of steps) layer.set(s.step_key, 0);
    const remaining = new Map(inDeg);
    const queue: string[] = steps.filter((s) => (inDeg.get(s.step_key) || 0) === 0).map((s) => s.step_key);
    while (queue.length) {
      const k = queue.shift()!;
      for (const t of outAdj.get(k) || []) {
        layer.set(t, Math.max(layer.get(t) || 0, (layer.get(k) || 0) + 1));
        remaining.set(t, (remaining.get(t) || 0) - 1);
        if (remaining.get(t) === 0) queue.push(t);
      }
    }
    const X_STEP = 260;
    const Y_STEP = 90;
    const pos: Record<string, { x: number; y: number }> = {};
    // Natural sort so `process_chunk[10]` sits below `process_chunk[9]`
    // (default string sort puts `[10]` before `[2]`). Also groups
    // dynamic instances by base name for tidy fan-outs.
    const naturalCmp = (a: string, b: string) => {
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      return collator.compare(a, b);
    };
    // Retry attempts share an "original key" (the step key with the
    // `#attempt-N` suffix stripped). We want every attempt of the same
    // instance to land on the SAME horizontal row — retries read as a
    // chain to the right of their parent, not floating up to row 0 of
    // their new layer. To do that we:
    //   1) collapse each attempt back to its original key
    //   2) group originals by the FIRST layer they appear in
    //   3) sort those originals naturally within their birth layer,
    //      producing a row index for every original
    //   4) place each node at (layer * X_STEP, row[original] * Y_STEP)
    const originalKey = (k: string) => k.replace(/#attempt-\d+$/, '');
    const minLayerByOriginal = new Map<string, number>();
    for (const s of steps) {
      const orig = originalKey(s.step_key);
      const L = layer.get(s.step_key) || 0;
      const cur = minLayerByOriginal.get(orig);
      if (cur == null || L < cur) minLayerByOriginal.set(orig, L);
    }
    const rowByOriginal = new Map<string, number>();
    const originalsByBirth = new Map<number, string[]>();
    for (const [orig, L] of minLayerByOriginal.entries()) {
      if (!originalsByBirth.has(L)) originalsByBirth.set(L, []);
      originalsByBirth.get(L)!.push(orig);
    }
    for (const [, keys] of originalsByBirth) {
      keys.sort(naturalCmp).forEach((k, i) => rowByOriginal.set(k, i));
    }
    for (const s of steps) {
      const L = layer.get(s.step_key) || 0;
      const row = rowByOriginal.get(originalKey(s.step_key)) || 0;
      pos[s.step_key] = { x: L * X_STEP, y: row * Y_STEP };
    }
    // Palette matches Dagster's native step colors:
    //   blue   = in progress (STARTED)
    //   green  = success
    //   orange = retried (RESTARTING / UP_FOR_RETRY / retry markers)
    //   red    = failure
    //   gray   = skipped / unknown / not yet started
    const statusMeta = (status: string) => {
      const s = status.toUpperCase();
      if (s === 'SUCCESS' || s === 'SUCCEEDED')
        return { bg: 'bg-emerald-50', border: 'border-emerald-500', dot: 'bg-emerald-500', ring: '', shadow: '' };
      if (s === 'FAILURE' || s === 'FAILED')
        return { bg: 'bg-rose-50', border: 'border-rose-500', dot: 'bg-rose-500', ring: 'ring-2 ring-rose-300', shadow: 'shadow-[0_0_0_3px_rgba(244,63,94,0.15)]' };
      if (s === 'STARTED' || s === 'RUNNING')
        return { bg: 'bg-blue-50', border: 'border-blue-500', dot: 'bg-blue-500 animate-pulse', ring: '', shadow: '' };
      if (s === 'RESTARTING' || s === 'UP_FOR_RETRY' || s === 'RETRIED' || s === 'RETRY_REQUESTED')
        return { bg: 'bg-amber-50', border: 'border-amber-500', dot: 'bg-amber-500', ring: '', shadow: '' };
      if (s === 'SKIPPED')
        return { bg: 'bg-gray-50', border: 'border-gray-300', dot: 'bg-gray-400', ring: '', shadow: '' };
      if (s === 'CANCELED' || s === 'CANCELING')
        return { bg: 'bg-gray-50', border: 'border-gray-400', dot: 'bg-gray-500', ring: '', shadow: '' };
      return { bg: 'bg-gray-50', border: 'border-gray-300', dot: 'bg-gray-400', ring: '', shadow: '' };
    };
    const nodes = steps.map((s) => ({
      id: s.step_key,
      type: 'stepNode',
      position: pos[s.step_key] || { x: 0, y: 0 },
      data: {
        step: s,
        statusMeta: statusMeta(s.status),
        selected: selectedStep === s.step_key,
        onClick: () => onOpenStepLogs(s.step_key),
        onOpenFullLogs: onOpenFullLogs ? () => onOpenFullLogs(s.step_key) : undefined,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    }));
    const rfEdges = edges.map((e) => ({
      id: `${e.from_step}__${e.to_step}`,
      source: e.from_step,
      target: e.to_step,
      type: 'default',
      style: { stroke: '#9ca3af', strokeWidth: 1 },
    }));
    return { nodes, rfEdges };
  }, [steps, edges, onOpenStepLogs]);

  if (steps.length === 0) {
    return <Card title="Lineage"><p className="text-sm text-gray-500 italic">No steps.</p></Card>;
  }

  return (
    <div className="h-full bg-white border border-gray-200 rounded-lg overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        nodeTypes={STEP_NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={(n) => {
          const s = ((n.data as any)?.step?.status || '').toUpperCase();
          if (s === 'SUCCESS' || s === 'SUCCEEDED') return '#10b981';         // green
          if (s === 'FAILURE' || s === 'FAILED') return '#f43f5e';             // red
          if (s === 'STARTED' || s === 'RUNNING') return '#3b82f6';            // blue
          if (s === 'RESTARTING' || s === 'UP_FOR_RETRY' || s === 'RETRIED' || s === 'RETRY_REQUESTED') return '#f59e0b';  // orange
          return '#9ca3af';                                                    // gray
        }} />
      </ReactFlow>
    </div>
  );
}

const StepNodeComp = memo(({ data }: NodeProps) => {
  const step = data.step;
  const meta = data.statusMeta;
  const dur = formatDuration(step.start_time, step.end_time);
  const selected = !!data.selected;
  const status = step.status.toUpperCase();
  const isFailed = status === 'FAILURE' || status === 'FAILED';
  // Retry attempts carry a synthetic `#attempt-N` suffix. Strip for
  // display and surface as a small "try N" badge instead, so the row
  // reads cleanly as the same step keyed multiple times.
  const attemptMatch = /^(.*)#attempt-(\d+)$/.exec(step.step_key);
  const displayKey = attemptMatch ? attemptMatch[1] : step.step_key;
  const attemptNum = attemptMatch ? parseInt(attemptMatch[2], 10) + 1 : null;
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={{ background: '#9ca3af' }} />
      <div
        onClick={() => data.onClick?.()}
        className={`relative rounded-md border-2 ${meta.border} ${meta.bg} ${meta.shadow || ''} p-2 min-w-[200px] max-w-[240px] cursor-pointer shadow-sm hover:shadow-md transition ${selected ? 'ring-2 ring-blue-500 ring-offset-1' : meta.ring || ''}`}
        title={`${step.step_key} · ${step.status.toLowerCase()} · ${dur} · click to filter logs`}
      >
        {isFailed && (
          <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-rose-500 border-2 border-white flex items-center justify-center shadow" title="Step failed">
            <span className="text-white text-[9px] font-bold leading-none">!</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
          <span className="font-mono text-[11px] text-gray-800 truncate flex-1">{displayKey}</span>
          {attemptNum != null && (
            <span
              className="px-1 py-[1px] text-[8px] font-semibold rounded bg-amber-100 border border-amber-300 text-amber-800"
              title={`Retry attempt ${attemptNum}`}
            >
              try {attemptNum}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between mt-1 text-[9px] text-gray-500">
          <span className={`uppercase tracking-wider ${isFailed ? 'text-rose-700 font-semibold' : ''}`}>{step.status.toLowerCase()}</span>
          <span className="tabular-nums">{dur === '—' ? '' : dur}</span>
        </div>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={{ background: '#9ca3af' }} />
    </>
  );
});
const STEP_NODE_TYPES = { stepNode: StepNodeComp };

function StepList({ steps, onOpenStepLogs, selectedStep }: { steps: RunDetail['steps']; onOpenStepLogs: (stepKey: string) => void; selectedStep?: string }) {
  if (steps.length === 0) {
    return <Card title="Steps"><p className="text-sm text-gray-500 italic">No step data.</p></Card>;
  }
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-auto h-full">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Status</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Step key</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Duration</th>
            <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Started</th>
            <th className="w-24 px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const isSel = selectedStep === s.step_key;
            return (
              <tr
                key={s.step_key}
                onClick={() => onOpenStepLogs(s.step_key)}
                className={`border-t border-gray-100 hover:bg-blue-50/40 cursor-pointer group ${isSel ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
                title="Click to filter logs to this step"
              >
                <td className="px-3 py-1.5"><StatusBadge status={s.status} /></td>
                <td className="px-3 py-1.5 font-mono text-xs text-gray-800">{s.step_key}</td>
                <td className="px-3 py-1.5 text-xs text-gray-700 tabular-nums">{formatDuration(s.start_time, s.end_time)}</td>
                <td className="px-3 py-1.5 text-xs text-gray-700">{formatRelativeTs(s.start_time)}</td>
                <td className="px-3 py-1.5 text-right">
                  <span className="text-[10px] text-blue-600 font-medium opacity-0 group-hover:opacity-100 whitespace-nowrap">
                    Filter logs →
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Waterfall/Gantt view of step timings. Each step becomes a bar whose
 * horizontal position + width represents when it ran relative to the
 * whole run's timeline. Parallel steps stack visually, serialized
 * steps read left-to-right. Bar color follows step status.
 */
function StepTimeline({ steps, onOpenStepLogs, selectedStep }: { steps: RunDetail['steps']; onOpenStepLogs: (stepKey: string) => void; selectedStep?: string }) {
  const { runStart, runEnd, sorted } = useMemo(() => {
    const withStart = steps.filter((s) => s.start_time != null);
    if (withStart.length === 0) return { runStart: 0, runEnd: 0, sorted: [] as typeof steps };
    const runStart = Math.min(...withStart.map((s) => s.start_time as number));
    const runEnd = Math.max(...steps.map((s) => (s.end_time as number) || (s.start_time as number) || 0));
    const sorted = [...steps].sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
    return { runStart, runEnd, sorted };
  }, [steps]);

  if (sorted.length === 0) {
    // Happens when a run fails before any step starts (e.g. the code
    // server was unreachable). Dagster native's timeline is empty
    // too in that case; we point users at the lineage view which
    // still shows structure from the execution plan.
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 text-center h-full flex flex-col items-center justify-center">
        <p className="text-sm text-gray-700">No timing data for this run.</p>
        <p className="text-xs text-gray-500 mt-1">
          This run failed before any step started (or step stats aren't available yet). Switch to <span className="font-medium">Lineage</span> to see the execution plan.
        </p>
      </div>
    );
  }
  const totalSpan = Math.max(0.001, runEnd - runStart);

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between text-xs text-gray-600 flex-shrink-0">
        <span>Total: <span className="font-mono">{formatDuration(runStart, runEnd)}</span></span>
        <span className="text-[10px] text-gray-500">Click a bar to filter logs below →</span>
      </div>
      <div className="divide-y divide-gray-50 overflow-y-auto flex-1">
        {sorted.map((s) => {
          const start = s.start_time || runStart;
          const end = s.end_time || runEnd;                     // if still running, extend to now
          const leftPct = Math.max(0, ((start - runStart) / totalSpan) * 100);
          const widthPct = Math.max(0.4, ((end - start) / totalSpan) * 100);
          const status = s.status.toUpperCase();
          const barColor =
            status === 'SUCCESS' || status === 'SUCCEEDED' ? 'bg-emerald-500'
            : status === 'FAILURE' || status === 'FAILED' ? 'bg-rose-500'
            : status === 'STARTED' || status === 'RUNNING' ? 'bg-blue-500 animate-pulse'
            : status === 'RESTARTING' || status === 'UP_FOR_RETRY' || status === 'RETRIED' || status === 'RETRY_REQUESTED' ? 'bg-amber-500'
            : status === 'SKIPPED' ? 'bg-gray-300'
            : 'bg-gray-400';
          const isSel = selectedStep === s.step_key;
          return (
            <div
              key={s.step_key}
              onClick={() => onOpenStepLogs(s.step_key)}
              className={`grid grid-cols-[240px_1fr_60px] items-center gap-3 px-3 py-1.5 hover:bg-blue-50/40 cursor-pointer group ${isSel ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
              title={`${s.step_key} · ${formatDuration(s.start_time, s.end_time)} · click to filter logs`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <StatusBadge status={s.status} />
                <span className="font-mono text-xs text-gray-800 truncate">{s.step_key}</span>
              </div>
              <div className="relative h-4 bg-gray-100 rounded overflow-hidden">
                <div
                  className={`absolute top-0 h-full rounded ${barColor} transition-opacity group-hover:opacity-90`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                />
              </div>
              <div className="text-[10px] font-mono text-gray-500 tabular-nums text-right">
                {formatDuration(s.start_time, s.end_time)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RunMaterializationsTab({ detail }: { detail: RunDetail }) {
  return (
    <div className="max-w-[1600px] mx-auto">
      <Card title={`Materialized assets (${detail.materializations.length})`}>
        {detail.materializations.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No assets materialized in this run.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Asset key</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Partition</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Materialized</th>
                <th className="text-left px-3 py-2 text-[10px] font-medium text-gray-600 uppercase tracking-wider">Metadata</th>
              </tr>
            </thead>
            <tbody>
              {detail.materializations.map((m, i) => (
                <tr key={`${m.asset_key}-${i}`} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-mono text-xs text-gray-900">{m.asset_key}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-700">{m.partition || '—'}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-700">{m.timestamp ? formatRelativeTs(m.timestamp / 1000) : '—'}</td>
                  <td className="px-3 py-1.5 text-[11px] text-gray-600">
                    {m.metadata.length === 0 ? '—' : (
                      <div className="flex flex-wrap gap-1">
                        {m.metadata.slice(0, 4).map((me, mi) => (
                          <span key={mi} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px]">
                            <Layers className="w-2.5 h-2.5" />{me.label}
                          </span>
                        ))}
                        {m.metadata.length > 4 && <span className="text-gray-500">+{m.metadata.length - 4}</span>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function RunConfigTab({ detail }: { detail: RunDetail }) {
  const yaml = detail.run_config_yaml || '';
  return (
    <div className="max-w-[1600px] mx-auto">
      <Card
        title="Run config (YAML)"
        headerRight={
          yaml ? (
            <button
              onClick={() => { navigator.clipboard.writeText(yaml); notify.success('Config copied'); }}
              className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900"
            >
              <Copy className="w-3 h-3" /> Copy
            </button>
          ) : null
        }
      >
        {yaml ? (
          <pre className="text-[11px] font-mono bg-gray-900 text-gray-100 rounded p-3 overflow-x-auto max-h-[60vh] whitespace-pre">
            {yaml}
          </pre>
        ) : (
          <p className="text-sm text-gray-500 italic flex items-center gap-2">
            <FileText className="w-4 h-4" /> Run was launched without config.
          </p>
        )}
      </Card>
    </div>
  );
}

function Card({ title, children, headerRight }: { title: string; children: React.ReactNode; headerRight?: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {headerRight}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: any; tone?: 'success' | 'error' | 'neutral' }) {
  const t = tone === 'success' ? 'text-emerald-700' : tone === 'error' ? 'text-rose-700' : 'text-gray-900';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{label}</div>
      <div className={`text-sm font-semibold mt-1 ${t}`}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Re-execute + terminate controls. Live at the top of the run detail
// page. The dropdown mirrors Dagster native: full re-run vs. re-run
// from failure. Both mutations return a new run id.
// ---------------------------------------------------------------------------

function ReexecuteMenu({ runId, status, onLaunched }: {
  runId: string;
  status: string;
  onLaunched?: (newRunId: string) => void;
}) {
  const { currentProject } = useProjectStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const isTerminal = ['SUCCESS', 'SUCCEEDED', 'FAILURE', 'FAILED', 'CANCELED'].includes(status.toUpperCase());
  const hasFailure = ['FAILURE', 'FAILED'].includes(status.toUpperCase());

  const launch = async (strategy: 'ALL_STEPS' | 'FROM_FAILURE') => {
    if (!currentProject || busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const r = await runsApi.reexecute(currentProject.id, runId, strategy);
      if (r.success && r.new_run_id) {
        onLaunched?.(r.new_run_id);
      } else {
        notify.error(r.detail || 'Re-execution failed.');
      }
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Re-execution failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={busy || !isTerminal}
        title={isTerminal ? 'Re-execute this run' : 'Wait for the current run to finish before re-executing.'}
        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
        Re-execute
        <ChevronDownSVG className="w-3 h-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-64 bg-white border border-gray-200 rounded shadow-lg z-20 text-xs overflow-hidden">
            <button
              onClick={() => launch('ALL_STEPS')}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-100"
            >
              <div className="font-medium text-gray-900">All steps</div>
              <div className="text-[10px] text-gray-500">Fresh execution from scratch. Same config.</div>
            </button>
            <button
              onClick={() => launch('FROM_FAILURE')}
              disabled={!hasFailure}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed"
              title={hasFailure ? 'Skip succeeded steps, restart failed ones' : 'Only available for failed runs.'}
            >
              <div className="font-medium text-gray-900">From failure</div>
              <div className="text-[10px] text-gray-500">Skip succeeded steps, restart the ones that failed.</div>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TerminateButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const { currentProject } = useProjectStore();
  const [busy, setBusy] = useState(false);
  const terminate = async () => {
    if (!currentProject) return;
    if (!confirm('Request termination of this run? Dagster will try to stop workers gracefully.')) return;
    setBusy(true);
    try {
      const r = await runsApi.terminate(currentProject.id, runId);
      if (r.success) {
        notify.success(r.detail || 'Termination requested.');
        onDone();
      } else {
        notify.error(r.detail || 'Termination failed.');
      }
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Termination failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={terminate}
      disabled={busy}
      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-rose-700 border border-rose-300 hover:bg-rose-50 rounded disabled:opacity-50"
      title="Request run termination"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
      Terminate
    </button>
  );
}

// Tiny chevron so we don't need another lucide import.
function ChevronDownSVG({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/** Inline button that spawns `dg dev` via the existing dagster-ui/start
 *  endpoint. When the user is stuck on the "GraphQL not running" warning
 *  in the Runs panel, this saves them a trip through the Actions menu.
 *  Polls status briefly after starting so we can re-fetch runs cleanly.
 */
function StartDgDevButton({ onStarted }: { onStarted: () => void }) {
  const { currentProject } = useProjectStore();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!currentProject) return;
    setBusy(true);
    try {
      await dagsterUIApi.start(currentProject.id);
      notify.success('Starting `dg dev`… giving it a few seconds to spin up.');
      // Dev takes a moment to bind the port + serve GraphQL. Small
      // grace period, then re-fetch runs.
      setTimeout(onStarted, 4000);
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Failed to start dg dev.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={start}
      disabled={busy}
      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded disabled:opacity-50 whitespace-nowrap flex-shrink-0"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
      Start dg dev
    </button>
  );
}

function formatDuration(start: number | null, end: number | null): string {
  if (!start) return '—';
  const endTs = end || Date.now() / 1000;
  const secs = Math.max(0, endTs - start);
  if (secs < 60) return `${secs.toFixed(1)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
}

function formatRelativeTs(ts: number | null): string {
  if (!ts) return '—';
  const then = ts * 1000;
  const diff = Date.now() - then;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(then).toLocaleDateString();
}
