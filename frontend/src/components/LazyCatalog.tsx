import { useEffect, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { projectsApi } from '@/services/api';

type Row = Awaited<ReturnType<typeof projectsApi.graphSearch>>['rows'][number];

const PAGE = 100;

/**
 * The asset catalog for a very large project (served in pieces -- see backend services/graph_index.py).
 * The full asset list isn't in the browser, so search, group filter and paging are answered by the server.
 * Opening an asset loads just its group, then hands off to the normal asset detail view.
 */
export function LazyCatalog({
  projectId, groups, totalAssets, initialQuery, onOpenAsset,
}: {
  projectId: string;
  groups: string[];
  totalAssets: number;
  initialQuery?: string;
  onOpenAsset: (row: Row) => void | Promise<void>;
}) {
  const [q, setQ] = useState(initialQuery ?? '');
  const [group, setGroup] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true); // true from the start: don't flash "No assets match" before the first fetch
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  // Debounced fresh search whenever the query or group changes.
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await projectsApi.graphSearch(projectId, { q, group: group || undefined, offset: 0, limit: PAGE });
        if (mine !== seq.current) return;
        setRows(r.rows); setTotal(r.total); setError(null);
      } catch (e: any) {
        if (mine === seq.current) setError(e?.response?.data?.detail || e?.message || 'Search failed');
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [projectId, q, group]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const r = await projectsApi.graphSearch(projectId, { q, group: group || undefined, offset: rows.length, limit: PAGE });
      setRows((prev) => [...prev, ...r.rows]);
      setTotal(r.total);
    } catch (e: any) {
      setError(e?.response?.data?.detail || e?.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50 p-6" data-testid="lazy-catalog">
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-900">Asset catalog</h2>
          <span className="text-xs text-gray-500">
            {total.toLocaleString()} of {totalAssets.toLocaleString()} assets{q || group ? ' match' : ''}
          </span>
          <div className="relative ml-auto">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search assets..."
              className="pl-7 pr-2 py-1.5 text-xs border border-gray-300 rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            className="px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white max-w-[220px]"
          >
            <option value="">All groups ({groups.length.toLocaleString()})</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        </div>
        {error && <div className="px-4 py-2 text-xs text-rose-700 bg-rose-50 border-b border-rose-100">{error}</div>}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left">
              <th className="px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Asset key</th>
              <th className="px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Group</th>
              <th className="px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider">Kinds</th>
              <th className="px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider text-right">Deps</th>
              <th className="px-4 py-2 text-xs font-medium text-gray-700 uppercase tracking-wider text-right">Checks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer"
                onClick={async () => {
                  setOpening(r.id);
                  try { await onOpenAsset(r); } finally { setOpening(null); }
                }}
              >
                <td className="px-4 py-2 font-mono text-xs text-gray-900">
                  {r.asset_key}
                  {opening === r.id && <Loader2 className="inline w-3 h-3 ml-2 animate-spin text-gray-400" />}
                </td>
                <td className="px-4 py-2 text-xs text-gray-700">{r.group_name}</td>
                <td className="px-4 py-2 text-xs">
                  <div className="flex flex-wrap gap-1">
                    {r.kinds.map((k) => (
                      <span key={k} className="px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] font-mono">{k}</span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-gray-700 text-right">{r.deps}</td>
                <td className="px-4 py-2 text-xs text-gray-700 text-right">{r.checks}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-gray-500 italic">No assets match.</td></tr>
            )}
          </tbody>
        </table>
        {rows.length < total && (
          <div className="px-4 py-3 text-center text-xs text-gray-600 bg-gray-50 border-t border-gray-100">
            Showing {rows.length.toLocaleString()} of {total.toLocaleString()} ·{' '}
            <button className="text-blue-600 hover:underline" onClick={loadMore} disabled={loading}>Show {PAGE} more</button>
          </div>
        )}
      </div>
    </div>
  );
}
