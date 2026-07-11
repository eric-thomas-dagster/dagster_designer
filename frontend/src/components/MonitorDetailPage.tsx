import { useEffect, useState } from 'react';
import {
  ArrowLeft, ChevronRight, Play, Bell, MoreVertical, Loader2, ExternalLink,
  ShieldCheck, TestTube2, Sparkles, CheckCircle2, XCircle, AlertTriangle, Clock,
  Trash2, FileText, Zap, Radar, Layers,
} from 'lucide-react';
import { projectsApi } from '@/services/api';

type Monitor = Awaited<ReturnType<typeof projectsApi.listMonitors>>['monitors'][number];
type Status = 'passing' | 'failing' | 'warn' | 'never_run';

interface MonitorDetailPageProps {
  monitor: Monitor;
  projectId: string;
  onBack: () => void;
  onOpenFile?: (path: string) => void;
  onOpenAsset?: (assetKey: string) => void;
}

const KIND_META: Record<Monitor['kind'], { label: string; icon: any; accent: string; iconBg: string }> = {
  dbt_test:       { label: 'dbt test',       icon: TestTube2, accent: 'text-emerald-700', iconBg: 'bg-emerald-50' },
  asset_check:    { label: 'Asset check',    icon: ShieldCheck, accent: 'text-indigo-700', iconBg: 'bg-indigo-50' },
  enhanced_check: { label: 'Enhanced check', icon: Sparkles,  accent: 'text-violet-700', iconBg: 'bg-violet-50' },
};

const bucket = (m: Monitor | { last_status: string | null }): Status => {
  const s = (m.last_status || '').toLowerCase();
  if (s === 'pass' || s === 'success') return 'passing';
  if (s === 'fail' || s === 'error' || s === 'runtime error') return 'failing';
  if (s === 'warn') return 'warn';
  return 'never_run';
};

/**
 * Full-page monitor detail — inspired by Sifflet's monitor page.
 * Sections:
 *   • Header with kind label + name + status pill + tags + action rail
 *   • Tabs: Overview (details + chart + impact + alerts) / Runs / Settings
 *   • Big time-series chart with expected-range band when we have >1
 *     numeric points; otherwise a pass/fail history strip
 *   • Blast-radius panel — downstream assets + exposures + affected
 *     monitors, so failures translate to real "who cares" impact
 */
export function MonitorDetailPage({ monitor, projectId, onBack, onOpenFile, onOpenAsset }: MonitorDetailPageProps) {
  const [tab, setTab] = useState<'overview' | 'runs' | 'settings'>('overview');
  const [history, setHistory] = useState<Awaited<ReturnType<typeof projectsApi.getMonitorHistory>> | null>(null);
  const [impact, setImpact] = useState<Awaited<ReturnType<typeof projectsApi.getMonitorImpact>> | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [impactLoading, setImpactLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true); setImpactLoading(true);
    projectsApi.getMonitorHistory(projectId, monitor.id, 500)
      .then((r) => { if (!cancelled) { setHistory(r); setHistoryLoading(false); } })
      .catch(() => { if (!cancelled) setHistoryLoading(false); });
    projectsApi.getMonitorImpact(projectId, monitor.id)
      .then((r) => { if (!cancelled) { setImpact(r); setImpactLoading(false); } })
      .catch(() => { if (!cancelled) setImpactLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, monitor.id]);

  const b = bucket(monitor);
  const Kind = KIND_META[monitor.kind];

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      {/* Breadcrumb ribbon */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2">
        <button onClick={onBack} className="p-1 hover:bg-gray-100 rounded text-gray-500 hover:text-gray-900" title="Back to monitors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-900">Monitors</button>
        <ChevronRight className="w-3 h-3 text-gray-300" />
        <span className="text-xs text-gray-900 font-mono truncate max-w-[440px]" title={monitor.label}>{monitor.label}</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded" title="Edit (coming soon)"><FileText className="w-4 h-4" /></button>
          <button className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded" title="Notifications (coming soon)"><Bell className="w-4 h-4" /></button>
          <button className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded" title="Run now (coming soon)"><Play className="w-4 h-4" /></button>
          <button className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded" title="More"><MoreVertical className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-lg ${Kind.iconBg} flex items-center justify-center flex-shrink-0`}>
            <Kind.icon className={`w-6 h-6 ${Kind.accent}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-xs font-semibold uppercase tracking-wider ${Kind.accent}`}>
              {monitor.check_kind ?? Kind.label}
            </div>
            <div className="text-2xl font-semibold text-gray-900 mt-0.5 truncate" title={monitor.label}>
              {monitor.label}
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <BigStatusPill status={b} monitor={monitor} />
              {monitor.target_asset_keys.map((t) => (
                <button
                  key={t}
                  onClick={() => onOpenAsset?.(t)}
                  className="inline-flex items-center gap-1 text-xs font-mono text-blue-700 hover:text-blue-900 hover:underline"
                >
                  <Layers className="w-3 h-3" /> {t}
                </button>
              ))}
              {monitor.source_project && (
                <span className="text-xs text-gray-500">· {monitor.source_project}</span>
              )}
              {monitor.severity && (
                <span className="text-xs text-gray-500">· {monitor.severity} severity</span>
              )}
              {monitor.tags.map((tg) => (
                <span key={tg} className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-700 font-mono">#{tg}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-8">
        <div className="flex items-center gap-1">
          {(['overview', 'runs', 'settings'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-3 text-sm font-medium border-b-2 -mb-px capitalize ${
                tab === t ? 'text-blue-600 border-blue-600' : 'text-gray-600 border-transparent hover:text-gray-900'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Overview */}
      {tab === 'overview' && (
        <div className="px-8 py-6 space-y-4">
          {/* Details fold-out */}
          <details className="bg-white border border-gray-200 rounded-lg group" open>
            <summary className="cursor-pointer px-4 py-3 flex items-center gap-2 select-none">
              <ChevronRight className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-90" />
              <span className="text-sm font-semibold text-gray-900">Details</span>
            </summary>
            <div className="px-4 pb-4 pt-1 border-t border-gray-100">
              <div className="grid grid-cols-4 gap-4 text-xs">
                <Fact label="Kind" value={Kind.label} />
                <Fact label="Check" value={monitor.check_kind ?? '—'} mono />
                <Fact label="Severity" value={monitor.severity} />
                <Fact label="Source project" value={monitor.source_project ?? '—'} mono />
                {monitor.description && (
                  <div className="col-span-4">
                    <span className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">Description</span>
                    <p className="text-gray-800">{monitor.description}</p>
                  </div>
                )}
                {monitor.source_location && (
                  <div className="col-span-4">
                    <span className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">Defined in</span>
                    <button
                      onClick={() => onOpenFile?.(monitor.source_location!)}
                      className="text-blue-600 hover:text-blue-800 hover:underline break-all inline-flex items-center gap-1 font-mono"
                    >
                      <FileText className="w-3 h-3" /> {monitor.source_location}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </details>

          {/* Chart */}
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900">
                  {history?.numeric_label ?? 'Run history'}
                </h3>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {history && history.numeric_series.length > 1
                    ? `Numeric metric over ${history.numeric_series.length} runs. Green band = expected range.`
                    : 'Pass/fail history — each square is one run, oldest → newest.'}
                </p>
              </div>
              {historyLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
            </div>
            <div className="p-4">
              {history && history.numeric_series.length > 1 ? (
                <BigTimeSeriesChart points={history.numeric_series} />
              ) : (
                <>
                  <BigPassFailStrip events={history?.events ?? []} />
                  <p className="text-[11px] text-gray-500 mt-3">
                    Numeric-metric charts appear once the check reports a value (row_count, null_ratio, freshness_age, etc.).
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Datapoint Summary — Sifflet-style tabbed list of all
              datapoints with value + expected range. Filterable by
              All / Anomalies / Passing. */}
          {history && history.events.length > 0 && (
            <DatapointSummary events={history.events} />
          )}

          {/* Blast radius */}
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
                  <Radar className="w-4 h-4 text-indigo-600" />
                  Blast radius
                </h3>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {b === 'failing'
                    ? 'These downstream assets + exposures are at risk right now.'
                    : 'If this monitor fails, these downstream things are impacted.'}
                </p>
              </div>
              {impactLoading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
            </div>
            <div className="p-4">
              {impact ? (
                <BlastRadiusPanel impact={impact} onOpenAsset={onOpenAsset} />
              ) : (
                <div className="text-xs text-gray-500 italic">Computing…</div>
              )}
            </div>
          </div>

          {/* Recent runs (compact) */}
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Recent runs</h3>
            </div>
            {history && history.events.length > 0 ? (
              <ul className="divide-y divide-gray-50">
                {history.events.slice().reverse().slice(0, 8).map((e, i) => (
                  <li key={i} className="px-4 py-2 flex items-center gap-2 text-xs">
                    <StatusDot status={e.status} />
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
                {history.events.length > 8 && (
                  <li className="px-4 py-2 text-[11px] text-gray-500 border-t border-gray-100">
                    <button className="text-blue-600 hover:text-blue-800" onClick={() => setTab('runs')}>
                      View all {history.events.length} runs →
                    </button>
                  </li>
                )}
              </ul>
            ) : (
              <div className="p-6 text-xs text-gray-500 italic text-center">No runs recorded yet.</div>
            )}
          </div>
        </div>
      )}

      {tab === 'runs' && (
        <div className="px-8 py-6">
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">All runs</h3>
              <span className="text-xs text-gray-500">{history?.events.length ?? 0}</span>
            </div>
            {historyLoading && (
              <div className="p-6 flex items-center justify-center text-sm text-gray-500 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading history…
              </div>
            )}
            {history && history.events.length === 0 && (
              <div className="p-8 text-center text-xs text-gray-500 italic">
                No runs recorded yet.
              </div>
            )}
            {history && history.events.length > 0 && (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider w-8"></th>
                    <th className="text-left px-2 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">When</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Duration</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Failures</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Value</th>
                    <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {history.events.slice().reverse().map((e, i) => (
                    <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5"><StatusDot status={e.status} /></td>
                      <td className="px-2 py-2.5 font-mono text-xs text-gray-800">{e.status}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-700 tabular-nums">
                        {new Date(e.ts).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-700 tabular-nums">
                        {e.duration_ms != null ? `${(e.duration_ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {e.failures != null && e.failures > 0
                          ? <span className="text-rose-700 font-medium">{e.failures}</span>
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs font-mono text-gray-700">
                        {e.value != null ? formatValue(e.value) + (e.value_label ? ' ' + e.value_label : '') : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-gray-600 truncate max-w-[320px]" title={e.message || ''}>
                        {e.message || <span className="text-gray-400 italic">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="px-8 py-6 space-y-4">
          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Configuration</h3>
              <p className="text-[11px] text-gray-500 mt-0.5">
                Full inline edit lands in the next step. For now, jump to the source file to tweak.
              </p>
            </div>
            <div className="p-4 space-y-2 text-xs">
              <Fact label="Kind" value={Kind.label} />
              <Fact label="Check" value={monitor.check_kind ?? '—'} mono />
              <Fact label="Severity" value={monitor.severity} />
              <Fact label="Watches" value={monitor.target_asset_keys.join(', ') || '—'} mono />
              <Fact label="Schedule" value={monitor.schedule ?? 'default (on materialization)'} mono />
              {monitor.source_location && (
                <button
                  onClick={() => onOpenFile?.(monitor.source_location!)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded hover:bg-gray-50 mt-2"
                >
                  <FileText className="w-4 h-4" />
                  Open source file
                </button>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Danger zone</h3>
            </div>
            <div className="p-4">
              <button
                disabled
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-rose-700 border border-rose-200 rounded hover:bg-rose-50 disabled:opacity-40"
                title="Delete plumbing coming next — for now use the file editor or the drawer × on tests/selectors/exposures"
              >
                <Trash2 className="w-4 h-4" /> Delete monitor
              </button>
              <p className="text-[10px] text-gray-500 mt-2">
                Delete plumbing for native + enhanced checks lands next. dbt tests can be removed from the Tests tab today.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------

function BigStatusPill({ status, monitor }: { status: Status; monitor: Monitor }) {
  const label = monitor.last_status || 'Never run';
  const tone = status === 'passing' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : status === 'failing' ? 'bg-rose-50 text-rose-700 border-rose-200'
    : status === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-gray-100 text-gray-700 border-gray-200';
  const Icon = status === 'passing' ? CheckCircle2 : status === 'failing' ? XCircle : status === 'warn' ? AlertTriangle : Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border ${tone}`}>
      <Icon className="w-3.5 h-3.5" />
      {label}
      {monitor.duration_ms != null && (
        <span className="text-[10px] opacity-70 ml-1">· {(monitor.duration_ms / 1000).toFixed(1)}s</span>
      )}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  if (s === 'pass' || s === 'success') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />;
  if (s === 'fail' || s === 'error' || s === 'runtime error') return <XCircle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" />;
  if (s === 'warn') return <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />;
  return <Clock className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />;
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wider text-gray-500 block mb-0.5">{label}</span>
      <span className={`text-gray-800 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  if (Math.abs(v) < 0.01) return v.toExponential(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Full-size time-series chart with a Sifflet-style green "expected"
 * band. Band is computed from a rolling 7-run mean ± 2σ so it looks
 * proper on unfamiliar metrics without any config.
 */
interface NumericPoint { ts: string; value: number; expected_min?: number | null; expected_max?: number | null }

function BigTimeSeriesChart({ points }: { points: NumericPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 900;
  const height = 260;
  const padL = 40, padR = 20, padT = 20, padB = 30;

  // If EVERY point has expected_min/expected_max, use them directly
  // (Sifflet-style — the monitor emits its own band per datapoint).
  // Otherwise fall back to a rolling ±2σ window so we still show a
  // useful shape for pass/fail histories without per-run bounds.
  const hasPerPointBounds = points.every((p) => p.expected_min != null && p.expected_max != null);

  const values = points.map((p) => p.value);
  const lows = hasPerPointBounds ? points.map((p) => p.expected_min as number) : [];
  const highs = hasPerPointBounds ? points.map((p) => p.expected_max as number) : [];
  const overallMin = Math.min(...values, ...lows);
  const overallMax = Math.max(...values, ...highs);
  const range = overallMax - overallMin || 1;
  const stepX = (width - padL - padR) / Math.max(1, points.length - 1);
  const y = (v: number) => padT + (1 - (v - overallMin) / range) * (height - padT - padB);
  const x = (i: number) => padL + i * stepX;

  // Build band. Prefer per-point bounds; fall back to rolling window.
  const bandUpper: Array<{ x: number; y: number; value: number }> = [];
  const bandLower: Array<{ x: number; y: number; value: number }> = [];
  if (hasPerPointBounds) {
    for (let i = 0; i < points.length; i++) {
      bandUpper.push({ x: x(i), y: y(points[i].expected_max as number), value: points[i].expected_max as number });
      bandLower.push({ x: x(i), y: y(points[i].expected_min as number), value: points[i].expected_min as number });
    }
  } else {
    const win = 7;
    for (let i = 0; i < points.length; i++) {
      const start = Math.max(0, i - win + 1);
      const slice = values.slice(start, i + 1);
      const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
      const sd = Math.sqrt(variance);
      const hi = mean + 2 * sd, lo = mean - 2 * sd;
      bandUpper.push({ x: x(i), y: y(hi), value: hi });
      bandLower.push({ x: x(i), y: y(lo), value: lo });
    }
  }
  const bandPath = `M ${bandUpper.map((p) => `${p.x} ${p.y}`).join(' L ')} L ${bandLower.slice().reverse().map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.value)}`).join(' ');
  const yTicks = 4;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {/* Y grid */}
      {Array.from({ length: yTicks + 1 }).map((_, i) => {
        const yv = overallMin + (range * (1 - i / yTicks));
        const yy = padT + (i / yTicks) * (height - padT - padB);
        return (
          <g key={i}>
            <line x1={padL} y1={yy} x2={width - padR} y2={yy} stroke="#e5e7eb" strokeDasharray="2 3" />
            <text x={padL - 6} y={yy + 3} textAnchor="end" fontSize="9" fill="#9ca3af">{formatValue(yv)}</text>
          </g>
        );
      })}
      {/* Expected band */}
      <path d={bandPath} fill="rgb(16, 185, 129)" fillOpacity="0.15" />
      {/* Series line */}
      <path d={pathD} fill="none" stroke="rgb(16, 185, 129)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {/* Points — colored by anomaly (outside band) */}
      {points.map((p, i) => {
        const bx = x(i), by = y(p.value);
        const outside = by < bandUpper[i].y || by > bandLower[i].y;
        return (
          <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <circle cx={bx} cy={by} r={outside ? 4 : 3} fill={outside ? 'rgb(244, 63, 94)' : 'rgb(16, 185, 129)'} stroke="white" strokeWidth="1.5" />
            {hover === i && (
              <>
                <line x1={bx} x2={bx} y1={padT} y2={height - padB} stroke="#9ca3af" strokeDasharray="2 3" />
                <g transform={`translate(${bx + 8}, ${Math.max(padT + 40, by - 8)})`}>
                  <rect x="0" y="-30" rx="4" width="180" height="52" fill="rgba(17, 24, 39, 0.94)" />
                  <text x="8" y="-14" fill={outside ? '#f87171' : '#6ee7b7'} fontSize="10" fontWeight="600">
                    {outside ? '⚠ Anomaly' : '✓ In range'}
                  </text>
                  <text x="8" y="0" fill="white" fontSize="11" fontWeight="600">{formatValue(p.value)}</text>
                  {(p.expected_min != null && p.expected_max != null) && (
                    <text x="8" y="12" fill="#d1d5db" fontSize="9">
                      expected {formatValue(p.expected_min)} – {formatValue(p.expected_max)}
                    </text>
                  )}
                  <text x="8" y="24" fill="#9ca3af" fontSize="9">{new Date(p.ts).toLocaleString()}</text>
                </g>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Big pass/fail history strip for the overview when we don't have
 * numeric metrics to chart. Each slot is a full-height colored bar.
 */
function BigPassFailStrip({ events }: { events: Array<{ status: string; ts: string }> }) {
  const slots = events.slice(-120);
  if (slots.length === 0) {
    return <div className="text-xs text-gray-500 italic py-8 text-center">No run history yet — trigger the check to populate this chart.</div>;
  }
  return (
    <div className="flex items-center gap-[2px] h-16" title={`${slots.length} recent runs`}>
      {slots.map((e, i) => {
        const s = (e.status || '').toLowerCase();
        const tone = s === 'pass' || s === 'success' ? 'bg-emerald-500'
          : s === 'fail' || s === 'error' || s === 'runtime error' ? 'bg-rose-500'
          : s === 'warn' ? 'bg-amber-500'
          : 'bg-gray-300';
        return <div key={i} className={`${tone} rounded-sm flex-1 min-w-[3px]`} title={`${s} · ${new Date(e.ts).toLocaleString()}`} />;
      })}
    </div>
  );
}

/**
 * Datapoint Summary — mirrors Sifflet's "Datapoint Summary" section
 * below the chart. Tabs filter to All / Anomalies / Passing / Failed.
 * A datapoint is an "anomaly" when the numeric value falls outside
 * its per-run expected range OR its status is a failure.
 */
type Event = NonNullable<Awaited<ReturnType<typeof projectsApi.getMonitorHistory>>>['events'][number];

function isAnomaly(e: Event): boolean {
  const s = (e.status || '').toLowerCase();
  if (s === 'fail' || s === 'error' || s === 'runtime error' || s === 'warn') return true;
  if (e.value != null && e.expected_min != null && e.expected_max != null) {
    if (e.value < e.expected_min || e.value > e.expected_max) return true;
  }
  return false;
}
function isPassing(e: Event): boolean {
  const s = (e.status || '').toLowerCase();
  return (s === 'pass' || s === 'success') && !isAnomaly(e);
}

function DatapointSummary({ events }: { events: Event[] }) {
  const [tab, setTab] = useState<'all' | 'anomalies' | 'passing'>('anomalies');
  const anomalies = events.filter(isAnomaly);
  const passing = events.filter(isPassing);

  const shown = tab === 'all' ? events : tab === 'anomalies' ? anomalies : passing;
  // Newest first — matches Sifflet's default sort
  const rows = shown.slice().reverse();

  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          Datapoint Summary <span className="text-gray-500 font-normal">({events.length})</span>
        </h3>
      </div>
      <div className="border-b border-gray-100 flex items-center gap-1 px-4">
        {([
          { id: 'all', label: 'All', count: events.length },
          { id: 'anomalies', label: 'Anomalies', count: anomalies.length, tone: anomalies.length > 0 ? 'text-rose-700' : '' },
          { id: 'passing', label: 'Passing', count: passing.length, tone: 'text-emerald-700' },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px ${
              tab === t.id ? 'text-blue-600 border-blue-600' : 'text-gray-600 border-transparent hover:text-gray-900'
            }`}
          >
            {t.label} <span className={`ml-0.5 ${(t as any).tone ?? ''}`}>({t.count})</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-xs text-gray-500 italic text-center">
          {tab === 'anomalies' ? 'No anomalies — this monitor is behaving.' : 'No datapoints in this bucket.'}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider w-8"></th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Date</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Value</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Expected range</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((e, i) => {
              const anomaly = isAnomaly(e);
              const arrow = e.value != null && e.expected_min != null && e.expected_max != null
                ? (e.value < e.expected_min ? '↓' : e.value > e.expected_max ? '↑' : '')
                : '';
              return (
                <tr key={i} className={`border-b border-gray-50 last:border-0 hover:bg-gray-50/50 ${anomaly ? 'bg-rose-50/30' : ''}`}>
                  <td className="px-4 py-2"><StatusDot status={e.status} /></td>
                  <td className="px-4 py-2 text-xs text-gray-700 tabular-nums whitespace-nowrap">
                    {new Date(e.ts).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    {anomaly ? (
                      <span className="inline-flex items-center gap-1 text-xs text-rose-700 font-medium">
                        <XCircle className="w-3 h-3" /> Anomaly
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
                        <CheckCircle2 className="w-3 h-3" /> Passing
                      </span>
                    )}
                  </td>
                  <td className={`px-4 py-2 text-xs font-mono ${anomaly ? 'text-rose-700 font-semibold' : 'text-gray-800'}`}>
                    {arrow && <span className="mr-1">{arrow}</span>}
                    {e.value != null ? formatValue(e.value) : <span className="text-gray-400">—</span>}
                    {e.value_label && <span className="text-gray-500 ml-1 font-normal">{e.value_label}</span>}
                  </td>
                  <td className="px-4 py-2 text-xs font-mono text-gray-600">
                    {e.expected_min != null && e.expected_max != null
                      ? `${formatValue(e.expected_min)} – ${formatValue(e.expected_max)}`
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-2 text-[11px] text-gray-600 truncate max-w-[280px]" title={e.message || ''}>
                    {e.message || <span className="text-gray-400 italic">—</span>}
                    {e.failures != null && e.failures > 0 && !e.message && (
                      <span className="text-rose-700 font-medium">{e.failures} rows failed</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows.length > 200 && (
        <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-500 italic">
          Showing first 200 of {rows.length} — refine filter to see more.
        </div>
      )}
    </div>
  );
}

function BlastRadiusPanel({ impact, onOpenAsset }: {
  impact: NonNullable<Awaited<ReturnType<typeof projectsApi.getMonitorImpact>>>;
  onOpenAsset?: (assetKey: string) => void;
}) {
  const total = impact.affected_assets.length + impact.affected_exposures.length;
  if (total === 0) {
    return (
      <div className="text-xs text-gray-500 italic">
        Nothing downstream in the tracked graph — this monitor is a leaf. (Or upstream lineage isn't fully imported yet.)
      </div>
    );
  }
  // Group affected assets by hop count for the ranked display
  const byHop = new Map<number, string[]>();
  for (const a of impact.affected_assets) {
    const h = impact.hop_counts[a] ?? 0;
    const arr = byHop.get(h) ?? [];
    arr.push(a);
    byHop.set(h, arr);
  }
  const hops = Array.from(byHop.keys()).sort((a, b) => a - b);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs">
        <span className="text-gray-600">
          <strong className="text-gray-900">{impact.affected_assets.length}</strong> downstream asset{impact.affected_assets.length === 1 ? '' : 's'}
        </span>
        <span className="text-gray-600">
          <strong className="text-gray-900">{impact.affected_exposures.length}</strong> exposure{impact.affected_exposures.length === 1 ? '' : 's'}
        </span>
        <span className="text-gray-600">
          <strong className="text-gray-900">{impact.affected_monitors.length}</strong> other monitor{impact.affected_monitors.length === 1 ? '' : 's'} in reach
        </span>
      </div>

      <div className="space-y-2">
        {hops.map((h) => (
          <div key={h} className="flex items-start gap-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 pt-1 flex-shrink-0 w-16">
              +{h} hop{h === 1 ? '' : 's'}
            </div>
            <div className="flex flex-wrap gap-1">
              {byHop.get(h)!.map((a) => (
                <button
                  key={a}
                  onClick={() => onOpenAsset?.(a)}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded bg-blue-50 border border-blue-200 text-blue-700 font-mono hover:bg-blue-100"
                >
                  <Layers className="w-3 h-3" />
                  {a}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {impact.affected_exposures.length > 0 && (
        <div className="border-t border-gray-100 pt-3">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Exposures at risk</div>
          <ul className="space-y-1">
            {impact.affected_exposures.map((e) => (
              <li key={e.unique_id} className="text-xs flex items-center gap-2">
                <Zap className="w-3 h-3 text-amber-500 flex-shrink-0" />
                <span className="font-mono font-medium text-gray-900">{e.name}</span>
                {e.type && <span className="text-[10px] text-gray-500">· {e.type}</span>}
                {e.owner && <span className="text-[10px] text-gray-500">· {e.owner}</span>}
                {e.url && (
                  <a href={e.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-blue-600 hover:text-blue-800">
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
