import { useEffect, useMemo, useState } from 'react';
import {
  Cloud, RefreshCw, Loader2, ShieldCheck, Layers, Play, Search,
  CheckCircle2, XCircle, AlertTriangle, Clock, ExternalLink,
} from 'lucide-react';
import { projectsApi } from '@/services/api';

/**
 * Cloud-mode panel — the single view that shows up when the current
 * project is a Dagster+ connection (is_dagster_plus=true). Everything
 * is read-only over GraphQL for now. Three sub-tabs:
 *
 *   • Assets   — the asset graph from assetsOrError
 *   • Checks   — asset checks + last-execution status
 *   • Runs     — recent run history
 *
 * Same design language as the local panels (KPIs + filter + table
 * pattern) so users switching between local + cloud projects see a
 * consistent shape.
 */
interface DagsterPlusPanelProps {
  projectId: string;
  org: string | null;
  deployment: string | null;
}

export function DagsterPlusPanel({ projectId, org, deployment }: DagsterPlusPanelProps) {
  const [tab, setTab] = useState<'assets' | 'checks' | 'runs'>('assets');
  const [assets, setAssets] = useState<Awaited<ReturnType<typeof projectsApi.getDagsterPlusAssets>> | null>(null);
  const [checks, setChecks] = useState<Awaited<ReturnType<typeof projectsApi.getDagsterPlusAssetChecks>> | null>(null);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof projectsApi.getDagsterPlusRuns>> | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<Record<string, string | null>>({});
  const [search, setSearch] = useState('');

  const load = async (which: 'assets' | 'checks' | 'runs') => {
    setLoading((l) => ({ ...l, [which]: true }));
    setError((e) => ({ ...e, [which]: null }));
    try {
      if (which === 'assets') setAssets(await projectsApi.getDagsterPlusAssets(projectId));
      else if (which === 'checks') setChecks(await projectsApi.getDagsterPlusAssetChecks(projectId));
      else setRuns(await projectsApi.getDagsterPlusRuns(projectId, 50));
    } catch (e: any) {
      setError((s) => ({ ...s, [which]: e?.response?.data?.detail || e?.message || 'Load failed' }));
    } finally {
      setLoading((l) => ({ ...l, [which]: false }));
    }
  };

  useEffect(() => { load('assets'); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);
  useEffect(() => {
    if (tab === 'checks' && !checks) load('checks');
    if (tab === 'runs' && !runs) load('runs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Build the deep-link base for "Open in Dagster+" links. Empty
  // deployment → top-level host so Dagster+ redirects to whichever
  // deployment is the org's default.
  const cloudUrl = org
    ? `https://${org.replace('.dagster.cloud', '').replace('.dagster.plus', '').split('/')[0]}.dagster.cloud${deployment ? '/' + deployment : ''}`
    : null;

  const filteredAssets = useMemo(() => {
    if (!assets) return [];
    const q = search.trim().toLowerCase();
    if (!q) return assets.assets;
    return assets.assets.filter((a) => a.asset_key.toLowerCase().includes(q) || (a.group_name || '').toLowerCase().includes(q));
  }, [assets, search]);

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      {/* Slim ribbon — cloud-connected indicator */}
      <div className="flex-shrink-0 bg-white border-b border-gray-200 px-4 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center flex-shrink-0">
            <Cloud className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-xs font-mono text-gray-700 truncate">
            <strong className="text-gray-900">{org}</strong> · {deployment}
          </span>
          <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded font-medium">
            LIVE · read-only
          </span>
        </div>
        <div className="flex items-center gap-2">
          {cloudUrl && (
            <a href={cloudUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-700 hover:text-gray-900">
              <ExternalLink className="w-3.5 h-3.5" /> Open in Dagster+
            </a>
          )}
          <button
            onClick={() => load(tab)}
            disabled={loading[tab]}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
          >
            {loading[tab] ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </button>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div className="bg-white border-b border-gray-200 px-8">
        <div className="flex items-center gap-1">
          {([
            { v: 'assets', label: 'Assets', icon: Layers, count: assets?.total },
            { v: 'checks', label: 'Asset checks', icon: ShieldCheck, count: checks?.total },
            { v: 'runs', label: 'Runs', icon: Play, count: runs?.total },
          ] as const).map((t) => (
            <button
              key={t.v}
              onClick={() => setTab(t.v)}
              className={`inline-flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.v ? 'text-blue-600 border-blue-600' : 'text-gray-600 border-transparent hover:text-gray-900'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
              {t.count != null && (
                <span className="text-[10px] text-gray-500">({t.count})</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="px-8 py-6 space-y-4">
        {tab === 'assets' && (
          <>
            <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search assets…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-300 rounded" />
              </div>
              <span className="text-[11px] text-gray-500">{filteredAssets.length} / {assets?.total ?? 0}</span>
            </div>
            {loading.assets && !assets && (
              <div className="p-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading assets from Dagster+…
              </div>
            )}
            {error.assets && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error.assets}</div>
            )}
            {assets && (
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Asset</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Group</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Kind</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Upstream</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Downstream</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Partitioned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAssets.map((a) => (
                      <tr key={a.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                        <td className="px-4 py-2.5">
                          <a
                            href={cloudUrl ? `${cloudUrl}/assets/${a.asset_key}` : '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-gray-900 hover:text-blue-600 inline-flex items-center gap-1"
                          >
                            {a.asset_key}
                            <ExternalLink className="w-3 h-3 text-gray-300" />
                          </a>
                          {a.description && (
                            <div className="text-[11px] text-gray-500 truncate max-w-[320px]" title={a.description}>{a.description}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs font-mono text-gray-700">{a.group_name || '—'}</td>
                        <td className="px-4 py-2.5 text-xs">
                          {a.compute_kind ? (
                            <span className="px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 font-mono text-[10px]">
                              {a.compute_kind}
                            </span>
                          ) : (
                            <span className="text-gray-400 italic">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-600 tabular-nums">{a.upstream.length}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-600 tabular-nums">{a.downstream.length}</td>
                        <td className="px-4 py-2.5 text-xs">
                          {a.is_partitioned ? (
                            <span className="text-emerald-700">✓ {(a.partition_definition && a.partition_definition.name) || 'yes'}</span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'checks' && (
          <>
            {loading.checks && !checks && (
              <div className="p-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading asset checks…
              </div>
            )}
            {error.checks && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error.checks}</div>
            )}
            {checks && (
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Check</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Asset</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Last status</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Severity</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Last run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.checks.map((c, i) => {
                      const s = (c.last_status || '').toLowerCase();
                      const tone = s === 'succeeded' ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                        : s === 'failed' ? 'text-rose-700 bg-rose-50 border-rose-200'
                        : s === 'skipped' ? 'text-gray-600 bg-gray-50 border-gray-200'
                        : 'text-amber-700 bg-amber-50 border-amber-200';
                      const Icon = s === 'succeeded' ? CheckCircle2 : s === 'failed' ? XCircle : s ? AlertTriangle : Clock;
                      return (
                        <tr key={`${c.asset_key}-${c.name}-${i}`} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                          <td className="px-4 py-2.5">
                            <div className="font-mono text-xs text-gray-900">{c.name}</div>
                            {c.description && (
                              <div className="text-[11px] text-gray-500 truncate max-w-[280px]">{c.description}</div>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs font-mono text-gray-700">{c.asset_key}</td>
                          <td className="px-4 py-2.5">
                            {c.last_status ? (
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${tone}`}>
                                <Icon className="w-3 h-3" />
                                {c.last_status}
                              </span>
                            ) : (
                              <span className="text-[11px] text-gray-400 italic">never run</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs font-mono text-gray-600">{c.last_severity ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-600 tabular-nums">
                            {c.last_timestamp ? new Date(c.last_timestamp * 1000).toLocaleString() : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'runs' && (
          <>
            {loading.runs && !runs && (
              <div className="p-8 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading runs…
              </div>
            )}
            {error.runs && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error.runs}</div>
            )}
            {runs && (
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Status</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Pipeline</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Started</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Duration</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Steps</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Materializations</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Run ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.runs.map((r) => {
                      const s = (r.status || '').toLowerCase();
                      const ok = s === 'success';
                      const fail = s === 'failure' || s === 'canceled';
                      const running = s === 'started' || s === 'starting' || s === 'queued';
                      const tone = ok ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                        : fail ? 'text-rose-700 bg-rose-50 border-rose-200'
                        : running ? 'text-blue-700 bg-blue-50 border-blue-200'
                        : 'text-gray-600 bg-gray-50 border-gray-200';
                      const dur = r.start_time && r.end_time ? `${(r.end_time - r.start_time).toFixed(0)}s` : '—';
                      return (
                        <tr key={r.run_id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded border ${tone}`}>
                              {r.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs font-mono text-gray-800">{r.pipeline_name || '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-600 tabular-nums">
                            {r.start_time ? new Date(r.start_time * 1000).toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-700 tabular-nums">{dur}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-700 tabular-nums">
                            <span className="text-emerald-700">{r.steps_succeeded ?? 0}</span>
                            {r.steps_failed != null && r.steps_failed > 0 && (
                              <>
                                {' / '}
                                <span className="text-rose-700">{r.steps_failed} failed</span>
                              </>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-gray-700 tabular-nums">{r.materializations ?? 0}</td>
                          <td className="px-4 py-2.5 text-xs font-mono text-gray-500">
                            <a
                              href={cloudUrl ? `${cloudUrl}/runs/${r.run_id}` : '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-blue-600 hover:underline"
                            >
                              {r.run_id.slice(0, 12)}…
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
