import { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, TestTube2, Zap, Sparkles, AlertTriangle, CheckCircle2, XCircle,
  Search, Loader2, Clock, X, Play, FileText, ChevronDown,
} from 'lucide-react';
import { projectsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';
import { AddMonitorDialog } from './AddMonitorDialog';
import { MonitorDetailPage } from './MonitorDetailPage';

type Monitor = Awaited<ReturnType<typeof projectsApi.listMonitors>>['monitors'][number];
type Status = 'passing' | 'failing' | 'warn' | 'never_run';

const KIND_META: Record<Monitor['kind'], { label: string; icon: any; tone: string }> = {
  dbt_test:        { label: 'dbt test',        icon: TestTube2, tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  asset_check:     { label: 'Asset check',     icon: ShieldCheck, tone: 'text-indigo-700 bg-indigo-50 border-indigo-200' },
  enhanced_check:  { label: 'Enhanced check',  icon: Sparkles,   tone: 'text-violet-700 bg-violet-50 border-violet-200' },
};

const bucket = (m: Monitor): Status => {
  const s = (m.last_status || '').toLowerCase();
  if (s === 'pass' || s === 'success') return 'passing';
  if (s === 'fail' || s === 'error' || s === 'runtime error') return 'failing';
  if (s === 'warn') return 'warn';
  return 'never_run';
};

/**
 * Top-level Monitors surface — Monte-Carlo-style unified view of every
 * data-quality check in the project (native asset checks, community
 * enhanced checks, dbt tests). Read-only v1; write endpoints follow.
 *
 * Design notes:
 *  • Failures sort to the top so the eye lands on what needs help
 *  • Alert strip surfaces the current-failure count separately from
 *    the KPI band so it's actionable even when scrolling
 *  • Table row → drawer with full detail + failure sample
 */
interface MonitorsPanelProps {
  onOpenFile?: (path: string) => void;
}

export function MonitorsPanel({ onOpenFile }: MonitorsPanelProps) {
  const { currentProject } = useProjectStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Awaited<ReturnType<typeof projectsApi.listMonitors>> | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all');
  const [kindFilter, setKindFilter] = useState<'all' | Monitor['kind']>('all');
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Monitor | null>(null);
  const [showAddMonitor, setShowAddMonitor] = useState(false);

  const refresh = async () => {
    if (!currentProject) return;
    setLoading(true);
    setError(null);
    try {
      const r = await projectsApi.listMonitors(currentProject.id);
      setData(r);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [currentProject?.id]);

  const monitors = data?.monitors ?? [];
  const stats = data?.stats ?? {};
  const targets = useMemo(() => {
    const all = new Set<string>();
    for (const m of monitors) for (const t of m.target_asset_keys) all.add(t);
    return Array.from(all).sort();
  }, [monitors]);

  const failing = monitors.filter((m) => bucket(m) === 'failing');
  const filtered = monitors.filter((m) => {
    if (statusFilter !== 'all' && bucket(m) !== statusFilter) return false;
    if (kindFilter !== 'all' && m.kind !== kindFilter) return false;
    if (assetFilter !== 'all' && !m.target_asset_keys.includes(assetFilter)) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${m.label} ${m.target_asset_keys.join(' ')} ${m.kind} ${m.check_kind ?? ''} ${m.source_project ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!currentProject) {
    return <div className="p-8 text-center text-sm text-gray-500">Open a project first.</div>;
  }

  // Full-page detail — swallows the list when a monitor is selected.
  // Sifflet-style: click a row → dedicated page with tabs, chart,
  // blast radius. Back button returns to the index.
  if (selected) {
    return (
      <MonitorDetailPage
        monitor={selected}
        projectId={currentProject.id}
        onBack={() => setSelected(null)}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      {/* Slim ribbon — matches other main pages */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-2">
        <div className="text-xs text-gray-400">
          One place for every data-quality check in the project — dbt tests, native asset checks, enhanced checks.
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Refresh
          </button>
          <button
            onClick={() => setShowAddMonitor(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md"
          >
            <ShieldCheck className="w-4 h-4" /> New monitor
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="p-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading monitors…
        </div>
      )}
      {error && (
        <div className="mx-8 mt-4 p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error}</div>
      )}

      {data && (
        <div className="px-8 py-6 space-y-4">
          {/* KPI band */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Kpi label="Monitors" value={stats.total ?? 0} icon={ShieldCheck} tone="neutral" hint={`${stats.dbt_tests ?? 0} dbt · ${stats.asset_checks ?? 0} native · ${stats.enhanced_checks ?? 0} enhanced`} />
            <Kpi label="Passing" value={stats.passing ?? 0} icon={CheckCircle2} tone="success" hint={stats.total ? `${Math.round(((stats.passing ?? 0) / stats.total) * 100)}%` : undefined} />
            <Kpi label="Failing" value={stats.failing ?? 0} icon={XCircle} tone={(stats.failing ?? 0) > 0 ? 'error' : 'neutral'} />
            <Kpi label="Warning" value={stats.warn ?? 0} icon={AlertTriangle} tone={(stats.warn ?? 0) > 0 ? 'warning' : 'neutral'} />
            <Kpi label="Never run" value={stats.never_run ?? 0} icon={Clock} tone="neutral" />
          </div>

          {/* Alerts strip — failures right now */}
          {failing.length > 0 && (
            <div className="px-4 py-2.5 bg-rose-50 border border-rose-200 rounded-md flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-rose-900">
                  {failing.length} monitor{failing.length === 1 ? '' : 's'} failing right now
                </div>
                <div className="text-xs text-rose-700 truncate">
                  {failing.slice(0, 6).map((f) => f.label).join(' · ')}
                  {failing.length > 6 && ` +${failing.length - 6} more`}
                </div>
              </div>
              <button
                onClick={() => { setStatusFilter('failing'); }}
                className="text-xs font-medium text-rose-700 hover:text-rose-900 flex-shrink-0"
              >
                Show failing →
              </button>
            </div>
          )}

          {/* Filter bar */}
          <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, asset, kind, source…"
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-300 rounded" />
            </div>
            <FilterPill label="Status" value={statusFilter} onChange={(v) => setStatusFilter(v as any)}
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'failing', label: 'Failing' },
                { value: 'warn', label: 'Warning' },
                { value: 'passing', label: 'Passing' },
                { value: 'never_run', label: 'Never run' },
              ]}
            />
            <FilterPill label="Kind" value={kindFilter} onChange={(v) => setKindFilter(v as any)}
              options={[
                { value: 'all', label: 'All kinds' },
                { value: 'dbt_test', label: 'dbt tests' },
                { value: 'asset_check', label: 'Native asset checks' },
                { value: 'enhanced_check', label: 'Enhanced checks' },
              ]}
            />
            <FilterPill label="Asset" value={assetFilter} onChange={setAssetFilter}
              options={[
                { value: 'all', label: 'All assets' },
                ...targets.map((t) => ({ value: t, label: t })),
              ]}
            />
            <span className="text-[11px] text-gray-500 ml-auto">{filtered.length} / {monitors.length}</span>
          </div>

          {/* Table */}
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            {filtered.length === 0 ? (
              <div className="p-10 text-center">
                <ShieldCheck className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-700 font-medium">
                  {monitors.length === 0 ? "No monitors defined yet in this project." : "No monitors match the current filters."}
                </p>
                {monitors.length === 0 && (
                  <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
                    Add native asset checks, community enhanced checks, or dbt tests to protect your assets.
                    We'll pull them all together here.
                  </p>
                )}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider w-8"></th>
                    <th className="text-left px-2 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Monitor</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Target</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Kind</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Trend</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => {
                    const Kind = KIND_META[m.kind];
                    const b = bucket(m);
                    return (
                      <tr
                        key={m.id}
                        className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer"
                        onClick={() => setSelected(m)}
                      >
                        <td className="px-4 py-2.5">
                          <StatusIcon status={b} />
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="font-mono text-xs text-gray-900">{m.label}</div>
                          {m.description && (
                            <div className="text-[11px] text-gray-500 truncate max-w-[240px]" title={m.description}>{m.description}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {m.target_asset_keys.length === 0 ? (
                            <span className="italic text-gray-400">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {m.target_asset_keys.slice(0, 2).map((t) => (
                                <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 font-mono text-gray-700 truncate max-w-[180px]" title={t}>
                                  {t}
                                </span>
                              ))}
                              {m.target_asset_keys.length > 2 && (
                                <span className="text-[10px] text-gray-500 self-center">+{m.target_asset_keys.length - 2}</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border ${Kind.tone}`}>
                            <Kind.icon className="w-3 h-3" />
                            {m.check_kind ?? Kind.label}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusPill monitor={m} />
                        </td>
                        <td className="px-4 py-2.5">
                          <RowSparkline statuses={m.recent_statuses ?? []} />
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-600 truncate max-w-[200px]" title={m.source_project ?? ''}>
                          {m.source_project ?? <span className="italic text-gray-400">—</span>}
                          {m.source_location && (
                            <div className="text-[10px] text-gray-400 font-mono truncate">{m.source_location}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Drawer */}
      {selected && (
        <MonitorDrawer monitor={selected} onClose={() => setSelected(null)} onOpenFile={onOpenFile} />
      )}

      {/* Add-monitor wizard */}
      <AddMonitorDialog
        open={showAddMonitor}
        onOpenChange={setShowAddMonitor}
        projectId={currentProject.id}
        onSaved={refresh}
      />
    </div>
  );
}

function Kpi({ label, value, hint, icon: Icon, tone }: { label: string; value: number; hint?: string; icon: any; tone: 'neutral' | 'success' | 'warning' | 'error' }) {
  const toneClasses = {
    neutral: 'text-gray-500 bg-gray-100',
    success: 'text-emerald-600 bg-emerald-50',
    warning: 'text-amber-600 bg-amber-50',
    error:   'text-rose-600 bg-rose-50',
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
          {hint && <div className="text-xs text-gray-500 truncate">{hint}</div>}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'passing') return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
  if (status === 'failing') return <XCircle className="w-4 h-4 text-rose-500" />;
  if (status === 'warn')    return <AlertTriangle className="w-4 h-4 text-amber-500" />;
  return <Clock className="w-4 h-4 text-gray-300" />;
}

function StatusPill({ monitor }: { monitor: Monitor }) {
  const s = monitor.last_status;
  if (!s) return <span className="text-[11px] text-gray-400 italic">never run</span>;
  const b = bucket(monitor);
  const tone = b === 'passing' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : b === 'failing' ? 'bg-rose-50 text-rose-700 border-rose-200'
    : b === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-gray-100 text-gray-700 border-gray-200';
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${tone}`}>
      <StatusIcon status={b} />
      {s}
      {monitor.last_run_failures != null && monitor.last_run_failures > 0 && (
        <span className="text-[10px] font-medium">· {monitor.last_run_failures} failed</span>
      )}
      {monitor.duration_ms != null && (
        <span className="text-[10px] opacity-70">· {(monitor.duration_ms / 1000).toFixed(1)}s</span>
      )}
    </span>
  );
}

function FilterPill<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="pl-2 pr-6 py-1 text-xs border border-gray-300 rounded bg-white appearance-none"
        aria-label={label}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="w-3 h-3 text-gray-400 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
    </div>
  );
}

function MonitorDrawer({ monitor, onClose, onOpenFile }: { monitor: Monitor; onClose: () => void; onOpenFile?: (path: string) => void }) {
  const { currentProject } = useProjectStore();
  const b = bucket(monitor);
  const Kind = KIND_META[monitor.kind];
  const [history, setHistory] = useState<Awaited<ReturnType<typeof projectsApi.getMonitorHistory>> | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    setHistoryLoading(true);
    projectsApi.getMonitorHistory(currentProject.id, monitor.id, 200)
      .then((r) => { if (!cancelled) { setHistory(r); setHistoryLoading(false); } })
      .catch(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [currentProject?.id, monitor.id]);
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
              <Kind.icon className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <h3 className="text-sm font-semibold text-gray-900 truncate">{monitor.label}</h3>
            </div>
            <p className="text-[11px] text-gray-500 font-mono truncate mt-0.5" title={monitor.id}>{monitor.id}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" aria-label="Close">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Fact label="Kind" value={Kind.label} />
            <Fact label="Check" value={monitor.check_kind ?? '—'} mono />
            <Fact label="Severity" value={monitor.severity} />
            <Fact label="Source" value={monitor.source_project ?? '—'} mono />
          </div>

          {/* History + numeric metric chart */}
          <section>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 flex items-center justify-between">
              <span>History{history && history.events.length > 0 ? ` (${history.events.length})` : ''}</span>
              {historyLoading && <Loader2 className="w-3 h-3 animate-spin text-gray-400" />}
            </h4>
            {!historyLoading && history && history.events.length === 0 && (
              <p className="text-[11px] text-gray-500 italic">
                No history yet. dbt tests snapshot on each run + on every visit to this page.
                Native asset check history lands in the next step (Dagster event-log integration).
              </p>
            )}
            {history && history.numeric_series.length > 1 && (
              <div className="mt-2 mb-3 p-2 border border-gray-200 rounded bg-white">
                <div className="text-[10px] text-gray-500 mb-1">
                  {history.numeric_label ?? 'value'} · last {history.numeric_series.length} runs
                </div>
                <TimeSeriesChart points={history.numeric_series} />
              </div>
            )}
            {history && history.events.length > 0 && (
              <div className="mt-2 border border-gray-100 rounded overflow-hidden">
                <PassFailStrip events={history.events} />
                <ul className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
                  {history.events.slice().reverse().slice(0, 40).map((e, i) => (
                    <li key={i} className="px-2 py-1.5 flex items-center gap-2 text-[11px]">
                      <HistoryRowIcon status={e.status} />
                      <span className="text-gray-800 font-mono">{e.status}</span>
                      {e.failures != null && e.failures > 0 && (
                        <span className="text-rose-700 font-medium">{e.failures} failed</span>
                      )}
                      {e.value != null && (
                        <span className="text-gray-600 font-mono">{formatValue(e.value)} {e.value_label ?? ''}</span>
                      )}
                      <span className="ml-auto text-gray-400 tabular-nums">
                        {new Date(e.ts).toLocaleString()}
                        {e.duration_ms != null && ` · ${(e.duration_ms / 1000).toFixed(1)}s`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section>
            <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Last run</h4>
            <div className="p-3 border border-gray-200 rounded">
              <div className="flex items-center gap-2 mb-1">
                <StatusIcon status={b} />
                <span className="text-sm font-medium text-gray-900">{monitor.last_status ?? 'Never run'}</span>
                {monitor.duration_ms != null && (
                  <span className="text-[11px] text-gray-500 ml-auto">{(monitor.duration_ms / 1000).toFixed(1)}s</span>
                )}
              </div>
              {monitor.last_run_at && <div className="text-[11px] text-gray-500 mb-1">{new Date(monitor.last_run_at).toLocaleString()}</div>}
              {monitor.last_run_failures != null && monitor.last_run_failures > 0 && (
                <div className="text-[11px] text-rose-700 font-medium mb-1">{monitor.last_run_failures} row{monitor.last_run_failures === 1 ? '' : 's'} failed</div>
              )}
              {monitor.last_run_message && (
                <pre className="text-[11px] font-mono bg-gray-50 border border-gray-100 rounded p-2 mt-1 whitespace-pre-wrap overflow-x-auto">
                  {monitor.last_run_message}
                </pre>
              )}
              {!monitor.last_status && (
                <p className="text-[11px] text-gray-500 italic">Run this monitor to populate its status.</p>
              )}
            </div>
          </section>

          {monitor.target_asset_keys.length > 0 && (
            <section>
              <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Watches</h4>
              <div className="flex flex-wrap gap-1">
                {monitor.target_asset_keys.map((t) => (
                  <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-blue-50 border border-blue-200 text-blue-700 font-mono">
                    {t}
                  </span>
                ))}
              </div>
            </section>
          )}

          {monitor.description && (
            <section>
              <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Description</h4>
              <p className="text-xs text-gray-700 whitespace-pre-wrap">{monitor.description}</p>
            </section>
          )}

          {monitor.tags.length > 0 && (
            <section>
              <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Tags</h4>
              <div className="flex flex-wrap gap-1">
                {monitor.tags.map((t) => (
                  <span key={t} className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-700 font-mono">#{t}</span>
                ))}
              </div>
            </section>
          )}

          {monitor.source_location && (
            <section>
              <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Defined in</h4>
              <button
                onClick={() => onOpenFile?.(monitor.source_location!)}
                className="text-xs font-mono text-blue-600 hover:text-blue-800 hover:underline break-all inline-flex items-center gap-1"
              >
                <FileText className="w-3 h-3" />
                {monitor.source_location}
              </button>
            </section>
          )}

          <section className="pt-2 border-t border-gray-100">
            <p className="text-[11px] text-gray-500 italic">
              Run / edit / schedule support lands next — for now this is a read-only unified view of every check in the project.
            </p>
          </section>
        </div>

        <div className="px-4 py-3 border-t border-gray-200 flex items-center gap-2 flex-shrink-0">
          <button
            disabled
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded disabled:opacity-40"
            title="Run-now support coming in the next step"
          >
            <Play className="w-3 h-3" />
            Run now
          </button>
          {monitor.source_location && (
            <button
              onClick={() => onOpenFile?.(monitor.source_location!)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
            >
              <FileText className="w-3 h-3" /> Open source
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Bare SVG line chart for numeric monitor metrics. No dep on
 * recharts / d3 — small enough to hand-roll cleanly, and matches
 * the aesthetic of the sparklines we use elsewhere.
 */
function TimeSeriesChart({ points }: { points: Array<{ ts: string; value: number }> }) {
  const width = 380;
  const height = 90;
  const paddingX = 6;
  const paddingY = 8;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - 2 * paddingX) / Math.max(1, points.length - 1);
  const y = (v: number) => paddingY + (1 - (v - min) / range) * (height - 2 * paddingY);
  const x = (i: number) => paddingX + i * stepX;
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const areaD = `${pathD} L ${x(points.length - 1)} ${height - paddingY} L ${x(0)} ${height - paddingY} Z`;
  const last = points[points.length - 1];
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
        <defs>
          <linearGradient id="mon-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(99, 102, 241)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="rgb(99, 102, 241)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#mon-chart-fill)" />
        <path d={pathD} fill="none" stroke="rgb(99, 102, 241)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.value)} r={1.5} fill="rgb(99, 102, 241)" />
        ))}
      </svg>
      <div className="flex items-baseline justify-between text-[10px] text-gray-500 mt-1">
        <span>min {formatValue(min)}</span>
        <span className="text-gray-900 font-medium">latest {formatValue(last.value)}</span>
        <span>max {formatValue(max)}</span>
      </div>
    </div>
  );
}

/**
 * Compact pass/fail history strip — one tiny colored square per run,
 * left-to-right in chronological order. Gives users the "did this
 * check ever fail" answer at a glance.
 */
function PassFailStrip({ events }: { events: Array<{ status: string }> }) {
  const slots = events.slice(-60); // cap so it fits
  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5 bg-gray-50 border-b border-gray-100">
      {slots.map((e, i) => {
        const s = (e.status || '').toLowerCase();
        const tone = s === 'pass' || s === 'success' ? 'bg-emerald-500'
          : s === 'fail' || s === 'error' || s === 'runtime error' ? 'bg-rose-500'
          : s === 'warn' ? 'bg-amber-500'
          : 'bg-gray-300';
        return (
          <span
            key={i}
            className={`inline-block ${tone} rounded-sm`}
            style={{ width: 6, height: 12 }}
            title={s}
          />
        );
      })}
      {slots.length === 0 && (
        <span className="text-[10px] text-gray-400 italic">no runs yet</span>
      )}
    </div>
  );
}

/**
 * Tiny per-row sparkline — 20 squares of pass/fail from the recent
 * history. Right-most is the newest. Empty state renders muted dashes
 * so the column doesn't collapse.
 */
function RowSparkline({ statuses }: { statuses: string[] }) {
  const slots = statuses.slice(-20);
  if (slots.length === 0) {
    return <span className="text-[10px] text-gray-300 italic">no runs</span>;
  }
  return (
    <div className="flex items-center gap-[1.5px]" title={`Last ${slots.length} run${slots.length === 1 ? '' : 's'} (oldest → newest)`}>
      {slots.map((s, i) => {
        const l = (s || '').toLowerCase();
        const tone = l === 'pass' || l === 'success' ? 'bg-emerald-500'
          : l === 'fail' || l === 'error' || l === 'runtime error' ? 'bg-rose-500'
          : l === 'warn' ? 'bg-amber-500'
          : 'bg-gray-300';
        return <span key={i} className={`inline-block ${tone} rounded-sm`} style={{ width: 3, height: 12 }} />;
      })}
    </div>
  );
}

function HistoryRowIcon({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  if (s === 'pass' || s === 'success') return <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />;
  if (s === 'fail' || s === 'error' || s === 'runtime error') return <XCircle className="w-3 h-3 text-rose-500 flex-shrink-0" />;
  if (s === 'warn') return <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0" />;
  return <Clock className="w-3 h-3 text-gray-300 flex-shrink-0" />;
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  if (Math.abs(v) < 0.01) return v.toExponential(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`text-gray-800 ${mono ? 'font-mono' : ''} break-all`}>{value}</span>
    </div>
  );
}
