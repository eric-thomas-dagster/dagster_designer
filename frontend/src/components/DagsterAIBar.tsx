import { useState, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, ArrowUp, Loader2, ChevronDown, X, Check } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';

interface AIPick {
  component_type: string;
  asset_name: string;
  upstream_asset_names: string[];
  config: Record<string, any>;
  reason: string;
}

interface AIPlanResponse {
  picks: AIPick[];
  task: string;
  model_used: string;
  tokens_prompt: number;
  tokens_completion: number;
  notes: string[];
}

const MODEL_OPTIONS = [
  { value: 'gpt-4o-mini', label: 'GPT-4o mini (fast, cheap)' },
  { value: 'gpt-4o', label: 'GPT-4o (higher quality)' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { value: 'gpt-5-mini', label: 'GPT-5 mini' },
];

export function DagsterAIBar() {
  const { currentProject, loadProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [task, setTask] = useState('');
  const [thinking, setThinking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<AIPlanResponse | null>(null);
  const [refinement, setRefinement] = useState('');
  const [model, setModel] = useState(MODEL_OPTIONS[0].value);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [task]);

  const submit = async (refineWith?: string) => {
    if (!currentProject) return;
    const isRefinement = !!refineWith;
    if (!isRefinement && !task.trim()) return;
    if (thinking) return;

    setThinking(true);
    if (!isRefinement) setPlan(null);
    try {
      const existing = currentProject.graph.nodes
        .filter((n) => n.type === 'asset' || n.data?.asset_key)
        .map((n) => ({
          name: n.data?.asset_key || n.data?.label || n.id,
          component_type: n.data?.component_type,
        }));

      const body: Record<string, any> = {
        task: task.trim(),
        existing_assets: existing,
        model,
      };
      if (isRefinement && plan) {
        body.previous_plan = plan.picks;
        body.refinement = refineWith;
      }

      const res = await fetch('/api/v1/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data: AIPlanResponse = await res.json();
      setPlan(data);
      if (isRefinement) setRefinement('');
      if (data.picks.length === 0) {
        notify.warning(data.notes.join('\n') || 'Dagster AI could not build a plan for that task.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Dagster AI failed: ${msg}`);
    } finally {
      setThinking(false);
    }
  };

  const apply = async () => {
    if (!plan || !currentProject || applying) return;
    setApplying(true);
    let installed = 0;
    let failed = 0;
    try {
      for (const pick of plan.picks) {
        // pick.component_type is actually the manifest component_id (e.g.
        // "unique_dedup"). Pass the AI's proposed attrs as `attributes` so the
        // CLI-based endpoint merges them into the stub defs.yaml — otherwise
        // the LLM's carefully-planned config gets discarded and the user has
        // to re-enter it by hand.
        const attributes: Record<string, any> = {
          ...pick.config,
          asset_name: pick.config.asset_name || pick.asset_name,
        };
        if (pick.upstream_asset_names.length > 0) {
          attributes.upstream_asset_keys = pick.upstream_asset_names.join(', ');
        }
        try {
          const res = await fetch(`/api/v1/templates/install-via-cli/${pick.component_type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: currentProject.id,
              config: {},
              attributes,
              instance_name: pick.asset_name,
            }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({} as any));
            throw new Error(body.detail || `HTTP ${res.status}`);
          }
          installed++;
        } catch (e) {
          failed++;
          console.warn(`[DagsterAI] Failed to install ${pick.component_type}:`, e);
        }
      }

      // Refresh the palette + primitives lists so newly-installed community
      // components flip from dashed "available" to purple "installed" and any
      // new assets/schedules/etc. show up without a manual reload.
      await queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['primitives', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['definitions', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['installed-resources', currentProject.id] });
      await loadProject(currentProject.id);
      if (failed === 0) {
        notify.success(`Dagster AI added ${installed} asset${installed === 1 ? '' : 's'} to the graph.`);
      } else if (installed === 0) {
        notify.error(`Dagster AI could not install any of the ${plan.picks.length} proposed picks.`);
      } else {
        notify.warning(`Dagster AI added ${installed} of ${plan.picks.length} picks; ${failed} failed. See console.`);
      }
      setPlan(null);
      setTask('');
    } finally {
      setApplying(false);
    }
  };

  const cancel = () => {
    setPlan(null);
    setRefinement('');
  };

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-full max-w-3xl px-4 pointer-events-none">
      {plan && (
        <div className="mb-2 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden pointer-events-auto">
          <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />
              <span className="text-sm font-medium text-gray-900 truncate">
                Dagster AI plan · {plan.picks.length} pick{plan.picks.length === 1 ? '' : 's'}
              </span>
              <span className="text-[11px] text-gray-400 flex-shrink-0">
                {plan.model_used} · {plan.tokens_prompt + plan.tokens_completion} tokens
              </span>
            </div>
            <button
              onClick={cancel}
              disabled={applying}
              className="p-1 text-gray-400 hover:text-gray-600 rounded"
              aria-label="Dismiss plan"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {plan.picks.map((pick, i) => {
              // Format config entries so column names and other AI-guessed
              // values are visible before the user applies — helps catch
              // hallucinations like `col: purchase_price` when the actual
              // upstream column is `amount` or similar.
              const configEntries = Object.entries(pick.config || {})
                .filter(([k]) => k !== 'asset_name' && k !== 'upstream_asset_keys')
                .filter(([, v]) => v !== null && v !== undefined && v !== '');
              return (
                <div key={i} className="px-4 py-2.5 border-b border-gray-100 last:border-b-0 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-gray-400 font-mono w-5 flex-shrink-0">{i + 1}.</span>
                    <span className="font-medium text-gray-900">{pick.asset_name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                      {pick.component_type}
                    </span>
                  </div>
                  {pick.upstream_asset_names.length > 0 && (
                    <div className="mt-1 pl-7 text-xs text-gray-500">
                      from: <span className="font-mono">{pick.upstream_asset_names.join(', ')}</span>
                    </div>
                  )}
                  {pick.reason && (
                    <div className="mt-1 pl-7 text-xs text-gray-500 italic">{pick.reason}</div>
                  )}
                  {configEntries.length > 0 && (
                    <div className="mt-1 pl-7 text-[11px] font-mono text-gray-600 bg-gray-50 rounded px-2 py-1 space-y-0.5">
                      {configEntries.map(([k, v]) => (
                        <div key={k} className="truncate" title={`${k}: ${JSON.stringify(v)}`}>
                          <span className="text-gray-500">{k}</span>
                          {': '}
                          <span className="text-gray-800">
                            {typeof v === 'string' ? v : JSON.stringify(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {plan.notes.length > 0 && (
              <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs space-y-0.5">
                {plan.notes.map((n, i) => {
                  const isInfo = n.startsWith('ℹ');
                  return (
                    <div key={i} className={isInfo ? 'text-gray-600' : 'text-amber-700'}>
                      {n}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Refinement input */}
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-100">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={refinement}
                onChange={(e) => setRefinement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && refinement.trim()) {
                    e.preventDefault();
                    submit(refinement.trim());
                  }
                }}
                placeholder="Refine this plan — e.g. 'use dbt instead' or 'add a schedule'"
                disabled={thinking || applying}
                className="flex-1 px-3 py-1.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary placeholder-gray-400 disabled:opacity-50"
              />
              <button
                onClick={() => submit(refinement.trim())}
                disabled={!refinement.trim() || thinking || applying}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 rounded disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {thinking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Refine
              </button>
            </div>
          </div>

          <div className="px-4 py-2 bg-white flex items-center justify-end gap-2">
            <button
              onClick={cancel}
              disabled={applying}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={applying || plan.picks.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-50"
            >
              {applying ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Applying…
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Apply to graph
                </>
              )}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-2xl shadow-lg pointer-events-auto">
        <div className="flex items-start gap-2 px-4 py-2.5">
          <Sparkles className="w-5 h-5 text-primary flex-shrink-0 mt-1" />
          <textarea
            ref={inputRef}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask Dagster AI to build a pipeline (e.g. 'Ingest sales.csv, join with customers, aggregate by month, write to CSV')"
            rows={1}
            disabled={thinking || applying}
            className="flex-1 resize-none border-none outline-none text-sm placeholder-gray-400 bg-transparent max-h-[120px] py-1"
          />
          <div className="flex items-center gap-1 flex-shrink-0">
            <div className="relative">
              <button
                onClick={() => setShowModelMenu((v) => !v)}
                disabled={thinking || applying}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-gray-900 rounded"
                title="Choose model"
              >
                {model}
                <ChevronDown className="w-3 h-3" />
              </button>
              {showModelMenu && (
                <div className="absolute bottom-full right-0 mb-1 min-w-[220px] bg-white border border-gray-200 rounded-md shadow-lg py-1 z-50">
                  {MODEL_OPTIONS.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => {
                        setModel(m.value);
                        setShowModelMenu(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${
                        model === m.value ? 'text-primary font-medium' : 'text-gray-700'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => submit()}
              disabled={!task.trim() || thinking || applying}
              className="p-1.5 rounded-full bg-primary text-primary-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Submit"
            >
              {thinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
