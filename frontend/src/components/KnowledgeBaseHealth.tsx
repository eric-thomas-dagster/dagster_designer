import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { API_BASE } from '@/services/api';

interface ChunkStat { chunk_id: string; retrievals: number; rated: number; mean_outcome: number | null; cited: number; excluded: Record<string, number> }
interface VersionStat { code_version: string; retrievals: number; rated: number; mean_outcome: number | null }
interface KnowledgeBaseReport {
  asset_key: string;
  window_days: number | null;
  receipts: number;
  chunks_retrieved: number;
  retrievals: number;
  rated_retrievals: number;
  mean_outcome: number | null;
  cited_retrievals: number;
  last_retrieved_at: string | null;
  excluded: Record<string, number>;
  failing_chunks: ChunkStat[];
  failing_chunk_count: number;
  top_chunks: ChunkStat[];
  by_code_version: VersionStat[];
  thresholds: { min_rated: number; failing_below: number };
}
interface HealthResponse { status: 'ok' | 'empty' | 'no_store' | 'unsupported_backend'; detail: string; knowledge_bases: KnowledgeBaseReport[] }

const WINDOWS = [7, 30, 90];

function outcomeTone(v: number | null): string {
  if (v === null) return 'text-gray-400';
  if (v >= 0.3) return 'text-emerald-600';
  if (v <= -0.3) return 'text-red-600';
  return 'text-amber-600';
}
const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(2));

/** What the receipt store says about each knowledge base in the project: use, quality, the chunks that keep failing,
 * and which recipe (code_version) built the chunks that are doing badly. Read-only; the numbers come from the store's
 * own tables, so this is empty until a serving layer (rag_pipeline, an MCP gateway) has recorded retrievals. */
export function KnowledgeBaseHealth({ projectId }: { projectId: string }) {
  const [days, setDays] = useState(30);
  const { data, isLoading, isFetching, refetch, error } = useQuery<HealthResponse>({
    queryKey: ['knowledge-base-health', projectId, days],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/projects/${projectId}/knowledge-base/health?days=${days}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-violet-600" />
          <h3 className="text-sm font-semibold text-gray-900">Knowledge base health</h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-gray-200 overflow-hidden text-xs">
            {WINDOWS.map((d) => (
              <button key={d} onClick={() => setDays(d)} className={`px-2 py-1 ${days === d ? 'bg-violet-50 text-violet-700' : 'text-gray-500 hover:bg-gray-50'}`}>{d}d</button>
            ))}
          </div>
          <button onClick={() => refetch()} className="p-1 text-gray-400 hover:text-gray-600" title="Refresh">
            {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {isLoading && <div className="text-xs text-gray-400">Loading…</div>}
        {error && <div className="text-xs text-red-600">{String((error as Error).message)}</div>}
        {data && data.status !== 'ok' && <div className="text-xs text-gray-500">{data.detail}</div>}
        {data?.knowledge_bases.map((kb) => (
          <div key={kb.asset_key} className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-gray-900 font-mono">{kb.asset_key}</span>
              {kb.last_retrieved_at && <span className="text-[10px] text-gray-400">last retrieved {new Date(kb.last_retrieved_at).toLocaleString()}</span>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              {[
                { label: 'Receipts', value: kb.receipts.toLocaleString(), tone: 'text-gray-900' },
                { label: 'Chunks served', value: kb.chunks_retrieved.toLocaleString(), tone: 'text-gray-900' },
                { label: 'Mean outcome', value: fmt(kb.mean_outcome), tone: outcomeTone(kb.mean_outcome) },
                { label: 'Cited', value: kb.retrievals ? `${Math.round((kb.cited_retrievals / kb.retrievals) * 100)}%` : '—', tone: 'text-gray-900' },
              ].map((s) => (
                <div key={s.label} className="rounded-md bg-gray-50 px-2 py-2">
                  <div className={`text-base font-semibold ${s.tone}`}>{s.value}</div>
                  <div className="text-[10px] text-gray-500">{s.label}</div>
                </div>
              ))}
            </div>
            {Object.keys(kb.excluded).length > 0 && (
              <div className="text-[11px] text-gray-500">
                Withheld by the gateway: {Object.entries(kb.excluded).map(([reason, n]) => `${n} ${reason}`).join(', ')}
              </div>
            )}
            {kb.failing_chunk_count > 0 && (
              <div>
                <div className="text-xs font-medium text-red-700 mb-1">
                  {kb.failing_chunk_count} chunk{kb.failing_chunk_count === 1 ? '' : 's'} keep getting rated badly
                  <span className="font-normal text-gray-400"> (mean ≤ {kb.thresholds.failing_below} over ≥ {kb.thresholds.min_rated} ratings)</span>
                </div>
                <div className="space-y-0.5">
                  {kb.failing_chunks.map((c) => (
                    <div key={c.chunk_id} className="flex justify-between text-[11px] font-mono bg-red-50 rounded px-2 py-1">
                      <span className="truncate mr-2">{c.chunk_id}</span>
                      <span className="text-red-700 flex-shrink-0">{fmt(c.mean_outcome)} · {c.rated} rated</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {kb.by_code_version.length > 1 && (
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">By recipe (code version)</div>
                <div className="space-y-0.5">
                  {kb.by_code_version.map((v) => (
                    <div key={v.code_version} className="flex justify-between text-[11px] font-mono bg-gray-50 rounded px-2 py-1">
                      <span className="truncate mr-2">{v.code_version}</span>
                      <span className={`flex-shrink-0 ${outcomeTone(v.mean_outcome)}`}>{fmt(v.mean_outcome)} · {v.retrievals} served · {v.rated} rated</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
