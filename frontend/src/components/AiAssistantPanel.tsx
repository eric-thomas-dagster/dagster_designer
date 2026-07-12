import { useEffect, useState } from 'react';
import {
  Sparkles, Loader2, Send, MessageSquare, Lightbulb, ChevronRight,
  AlertTriangle,
} from 'lucide-react';

/**
 * Reusable page-level AI Assistant callout — the same UX as the fleet
 * assistant on the Monitors index but pluggable per surface.
 *
 * Each page (dbt, Ingestions, Automation, Pipelines) provides:
 *   • a title + subtitle
 *   • an `insightsFetcher` that returns { summary, insights }
 *   • an `asker` that turns a question into an answer
 *   • suggestion chips
 *   • optional link resolvers for insight-referenced entities
 *
 * When no LLM key is configured, insightsFetcher returns an empty
 * response and this whole panel hides itself.
 */

export interface AiInsight {
  kind: string;                     // 'concern' | 'suggestion' | 'observation'
  title: string;
  detail: string;
  action: string | null;
  refs?: string[];                  // generic references (asset keys, model names)
}

export interface AiInsightsResponse {
  summary: string;
  insights: AiInsight[];
}

interface AiAssistantPanelProps {
  title: string;
  subtitle: string;
  suggestions: string[];
  fetchInsights: () => Promise<AiInsightsResponse>;
  ask: (question: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<string>;
  onOpenRef?: (ref: string) => void;   // click a chip → open the entity
  refIcon?: any;                       // icon for ref chips
}

export function AiAssistantPanel({
  title, subtitle, suggestions, fetchInsights, ask, onOpenRef, refIcon,
}: AiAssistantPanelProps) {
  const [insights, setInsights] = useState<AiInsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'insights' | 'chat'>('insights');
  // Collapsed by default. Insights arriving from the LLM can be
  // lengthy (10+ items), so users see the small header first and
  // expand only when they want the recommendations. Prevents the
  // panel from dominating the tab whenever it's open.
  const [collapsed, setCollapsed] = useState(true);
  const [turns, setTurns] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchInsights()
      .then((r) => { if (!cancelled) { setInsights(r); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hide when the backend returned no insights + no summary — happens
  // when no LLM key is configured.
  if (!loading && insights && insights.insights.length === 0 && !insights.summary) {
    return null;
  }

  const handleAsk = async (q: string) => {
    if (!q.trim() || chatLoading) return;
    const nextTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [...turns, { role: 'user', content: q.trim() }];
    setTurns(nextTurns);
    setInput('');
    setChatLoading(true);
    try {
      const answer = await ask(q.trim(), turns);
      setTurns([...nextTurns, { role: 'assistant', content: answer }]);
    } catch (e: any) {
      setTurns([...nextTurns, { role: 'assistant', content: `⚠️ ${e?.response?.data?.detail || e?.message || 'Ask failed'}` }]);
    } finally { setChatLoading(false); }
  };

  const RefIcon = refIcon;

  return (
    <div className="bg-gradient-to-r from-indigo-50 via-violet-50 to-fuchsia-50 border border-indigo-200 rounded-lg overflow-hidden">
      <div
        className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-white/40"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">
              {title}
              {loading && <Loader2 className="w-3 h-3 animate-spin inline ml-2 text-gray-400" />}
              {!loading && insights && insights.insights.length > 0 && (
                <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded-full bg-indigo-600 text-white font-medium">
                  {insights.insights.length} insight{insights.insights.length === 1 ? '' : 's'}
                </span>
              )}
            </h3>
            <p className="text-[11px] text-gray-600">{subtitle}</p>
          </div>
        </div>
        <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
      </div>

      {!collapsed && (
        <div className="border-t border-indigo-100 bg-white/40 p-4 space-y-3">
          <div className="flex items-center gap-1 bg-white/70 rounded p-0.5 w-fit">
            {(['insights', 'chat'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded ${
                  mode === m ? 'bg-indigo-600 text-white shadow-sm font-medium' : 'text-gray-700 hover:text-gray-900'
                }`}
              >
                {m === 'insights' ? <Lightbulb className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
                {m === 'insights' ? 'Insights' : 'Ask'}
              </button>
            ))}
          </div>

          {mode === 'insights' && insights && (
            <>
              {insights.summary && (
                <p className="text-sm text-gray-800 italic leading-relaxed">{insights.summary}</p>
              )}
              {insights.insights.length === 0 && !loading && (
                <p className="text-xs text-gray-500 italic">No specific insights right now.</p>
              )}
              {insights.insights.length > 0 && (
                <ul className="space-y-2">
                  {insights.insights.map((ins, i) => {
                    const toneStyle = ins.kind === 'concern' ? 'border-rose-300 bg-rose-50/70'
                      : ins.kind === 'suggestion' ? 'border-indigo-300 bg-indigo-50/70'
                      : 'border-gray-200 bg-white/70';
                    const IconEl = ins.kind === 'concern' ? AlertTriangle : ins.kind === 'suggestion' ? Lightbulb : Sparkles;
                    const iconTone = ins.kind === 'concern' ? 'text-rose-600' : ins.kind === 'suggestion' ? 'text-indigo-600' : 'text-gray-500';
                    return (
                      <li key={i} className={`border rounded p-3 ${toneStyle}`}>
                        <div className="flex items-start gap-2">
                          <IconEl className={`w-4 h-4 flex-shrink-0 mt-0.5 ${iconTone}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold text-gray-900">{ins.title}</div>
                            {ins.detail && <p className="text-xs text-gray-700 mt-0.5">{ins.detail}</p>}
                            {ins.action && (
                              <p className="text-[11px] text-indigo-700 mt-1 font-medium">→ {ins.action}</p>
                            )}
                            {ins.refs && ins.refs.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {ins.refs.map((r) => (
                                  <button
                                    key={r}
                                    onClick={() => onOpenRef?.(r)}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-white border border-gray-200 text-gray-700 hover:border-indigo-300 hover:text-indigo-700 font-mono"
                                  >
                                    {RefIcon && <RefIcon className="w-2.5 h-2.5" />}
                                    {r}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {mode === 'chat' && (
            <>
              {turns.length === 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleAsk(s)}
                      disabled={chatLoading}
                      className="px-2 py-1 text-[11px] rounded-full border border-indigo-200 bg-white/80 text-indigo-700 hover:bg-white disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {turns.length > 0 && (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {turns.map((t, i) => (
                    <div key={i} className={`text-xs ${t.role === 'user' ? 'text-right' : ''}`}>
                      <div className={`inline-block max-w-[90%] px-3 py-2 rounded-lg whitespace-pre-wrap leading-relaxed ${
                        t.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-800 border border-gray-200'
                      }`}>
                        {t.content}
                      </div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="text-xs">
                      <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-gray-200 text-gray-600">
                        <Loader2 className="w-3 h-3 animate-spin" /> thinking…
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(input); } }}
                  placeholder="Ask a question…"
                  disabled={chatLoading}
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 bg-white"
                />
                <button
                  onClick={() => handleAsk(input)}
                  disabled={chatLoading || !input.trim()}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  Ask
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
