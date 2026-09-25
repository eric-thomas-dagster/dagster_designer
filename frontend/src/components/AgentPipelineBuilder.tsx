import { useState } from 'react';
import { Sparkles, X, Loader2, Check } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { useQueryClient } from '@tanstack/react-query';
import { notify } from './Notifications';
import { API_BASE } from '@/services/api';
import { applyGeniePicks, resolveComponentIdFromCurrentProject, type GeniePickLike } from '@/lib/applyGeniePicks';

interface AgentPick extends GeniePickLike {
  reason: string;
}

interface AgentPlanResponse {
  picks: AgentPick[];
  notes: string[];
}

/**
 * The "Agents & Pipelines" bin's scoped Genie entry point: describe what
 * you want in plain English, no component picker step. Unlike the general
 * DagsterAIBar flow (which searches the whole ~700-component
 * asset-producing catalog), this calls /ai/plan with
 * scope: "agents_pipelines" -- the backend plans against a small, fixed
 * ~16-component pool (real agent frameworks and whole-pipeline
 * components: agentic_pipeline, LangGraph, MCP tool-use agents, ...), so
 * there's no catalog-selection step for the LLM to get wrong and no
 * reason to make the user pick a component first for something this
 * sophisticated -- see agents_pipelines_component_ids in
 * genie_service.py for exactly which components that pool contains.
 */
export function AgentPipelineBuilder({ onClose }: { onClose: () => void }) {
  const { currentProject } = useProjectStore();
  const queryClient = useQueryClient();
  const [task, setTask] = useState('');
  const [refinement, setRefinement] = useState('');
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<AgentPlanResponse | null>(null);

  // `refineWith`, when given, is the user's answer to a Genie clarifying
  // question (or any other follow-up) -- resubmits with the prior plan as
  // context so Genie can fill in what it asked about instead of starting
  // over. Same refine/regenerate contract DagsterAIBar uses.
  const generate = async (refineWith?: string) => {
    const isRefinement = !!refineWith;
    if (!currentProject || (!isRefinement && !task.trim()) || planning) return;
    setPlanning(true);
    if (!isRefinement) setPlan(null);
    try {
      const existing = currentProject.graph.nodes
        .filter((n) => n.type === 'asset' || n.data?.asset_key)
        .map((n) => ({
          name: n.data?.asset_key || n.data?.label || n.id,
          component_type: n.data?.component_type,
          component_id: n.data?.component_id || n.id,
          io_output_type: n.data?.io_output_type,
          kinds: n.data?.kinds,
        }));
      const body: Record<string, any> = {
        task: task.trim(),
        existing_assets: existing,
        project_id: currentProject.id,
        scope: 'agents_pipelines',
      };
      if (isRefinement && plan) {
        body.previous_plan = plan.picks;
        body.refinement = refineWith;
      }
      const res = await fetch(`${API_BASE}/ai/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data: AgentPlanResponse = await res.json();
      setPlan(data);
      if (isRefinement) setRefinement('');
      if (data.picks.length === 0) {
        notify.warning(data.notes.join('\n') || 'Could not build a plan for that description.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to plan: ${msg}`);
    } finally {
      setPlanning(false);
    }
  };

  const apply = async () => {
    if (!plan || !currentProject || applying || plan.picks.length === 0) return;
    setApplying(true);
    try {
      const { installed, failed, warnings } = await applyGeniePicks(
        currentProject.id,
        plan.picks,
        resolveComponentIdFromCurrentProject,
      );
      await queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['primitives', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['definitions', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['installed-resources', currentProject.id] });

      if (failed === 0) {
        notify.success(`Added ${installed} asset${installed === 1 ? '' : 's'} to the graph.`);
        if (warnings.length === 0) {
          onClose();
          return;
        }
      } else if (installed === 0) {
        notify.error(`Could not install any of the ${plan.picks.length} proposed picks.`);
      } else {
        notify.warning(`Added ${installed} of ${plan.picks.length} picks; ${failed} failed. See console.`);
      }
      if (warnings.length > 0) {
        notify.warning(`Some applied config differs from the plan:\n${warnings.join('\n')}`);
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Build an agent or pipeline</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
          <p className="text-sm text-gray-500">
            Describe what it should do — no need to pick a component first. This is scoped to
            real agent frameworks and whole-pipeline components (LangGraph, MCP tool-use agents,
            multi-step pipelines, ...), so it can pick the right one and draft the full config in
            one shot.
          </p>

          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Triage incoming support tickets: classify by urgency, draft a suggested reply, and flag anything that mentions a refund for human review."
            rows={4}
            disabled={planning || applying}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          />

          <button
            onClick={() => generate()}
            disabled={!task.trim() || planning || applying}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {planning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" /> {plan ? 'Regenerate' : 'Generate'}
              </>
            )}
          </button>

          {/* Genie's own notes -- most importantly, a ❓ clarifying
              question when it had to fill a field (a data source,
              destination, etc.) it didn't have enough information to get
              right, rather than silently fabricating a plausible-looking
              fake value. Shown whenever present, not just when the plan
              came back empty -- a note can accompany a real (if
              incomplete) plan too. */}
          {plan && plan.notes.length > 0 && (
            <div className="space-y-1.5">
              {plan.notes.map((n, i) => {
                const isQuestion = n.startsWith('❓');
                const isInfo = n.startsWith('ℹ');
                return (
                  <div
                    key={i}
                    className={`text-sm rounded-md p-2.5 border ${
                      isQuestion
                        ? 'bg-blue-50 border-blue-200 text-blue-900'
                        : isInfo
                          ? 'bg-gray-50 border-gray-200 text-gray-600'
                          : 'bg-amber-50 border-amber-200 text-amber-800'
                    }`}
                  >
                    {n}
                  </div>
                );
              })}
            </div>
          )}

          {plan && plan.picks.length > 0 && (
            <div className="space-y-3 pt-2 border-t border-gray-100">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Proposed {plan.picks.length === 1 ? 'component' : `${plan.picks.length} components`}
              </div>
              {plan.picks.map((pick, i) => (
                <div key={i} className="border border-gray-200 rounded-md p-3 bg-gray-50">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-900">{pick.asset_name}</span>
                    <span className="text-xs text-gray-400 font-mono">{pick.component_type}</span>
                  </div>
                  {pick.reason && <p className="text-xs text-gray-600 mb-2">{pick.reason}</p>}
                  <details className="text-xs text-gray-500">
                    <summary className="cursor-pointer hover:text-gray-700">
                      Config ({Object.keys(pick.config || {}).length} field
                      {Object.keys(pick.config || {}).length === 1 ? '' : 's'})
                    </summary>
                    <pre className="mt-1.5 p-2 bg-white border border-gray-200 rounded text-[11px] overflow-x-auto whitespace-pre-wrap">
                      {JSON.stringify(pick.config, null, 2)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          )}

          {plan && plan.picks.length === 0 && plan.notes.length === 0 && (
            <div className="text-sm text-gray-500 border border-gray-200 rounded-md p-3 bg-gray-50">
              No plan could be built for that description — try adding more detail.
            </div>
          )}

          {/* Answer Genie's question (or give any other follow-up) and
              regenerate with the prior plan as context -- same
              refine/regenerate contract DagsterAIBar uses. */}
          {plan && (
            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                value={refinement}
                onChange={(e) => setRefinement(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && refinement.trim()) {
                    e.preventDefault();
                    generate(refinement.trim());
                  }
                }}
                placeholder="Answer Genie's question, or give other feedback — e.g. 'use the zendesk_tickets asset'"
                disabled={planning || applying}
                className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
              <button
                onClick={() => generate(refinement.trim())}
                disabled={!refinement.trim() || planning || applying}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {planning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Refine
              </button>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={apply}
            disabled={!plan || plan.picks.length === 0 || applying}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applying ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Adding…
              </>
            ) : (
              <>
                <Check className="w-4 h-4" /> Add to graph
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
