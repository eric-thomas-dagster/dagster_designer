import { useMemo, useState } from 'react';
import { Sparkles, X, Loader2, Check, User, ChevronDown, ChevronRight, DollarSign, Clock, Hash } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from './Notifications';
import { API_BASE, assetsApi } from '@/services/api';
import { applyGeniePicks, resolveComponentIdFromCurrentProject, type GeniePickLike } from '@/lib/applyGeniePicks';
import { parseUpstreamAssetKeys } from '@/lib/upstreamAssetKeys';
import { parseStepMetadataFields, formatCost, formatLatency } from '@/lib/stepMetadata';
import type { ComponentInstance } from '@/types';

interface AgentPick extends GeniePickLike {
  reason: string;
}

interface ClarifyingQuestion {
  question: string;
  options: string[] | null;
}

interface AgentPlanResponse {
  picks: AgentPick[];
  notes: string[];
  // Null means the plan is complete and ready to apply. Non-null means
  // Genie needs an answer before it can finish -- see the ASK RATHER
  // THAN FABRICATE A DATA SOURCE rule in genie_service.py.
  clarifying_question: ClarifyingQuestion | null;
}

// A turn in the conversation. "genie" turns carry the plan they resulted
// in (which may itself carry a clarifying_question -- that's rendered as
// part of the same bubble, not a separate turn).
type Turn =
  | { role: 'user'; text: string }
  | { role: 'genie'; plan: AgentPlanResponse };

// Real text, not just a <textarea placeholder> -- a placeholder attribute
// isn't selectable/copyable in a browser and vanishes the instant the
// user starts typing, so "I liked that example, let me use it" had no
// path except retyping it by hand. A handful of these (not just one)
// covers more of the 16-op surface (route/debate/synthesize) so the
// blank-page problem doesn't just reproduce the same single shape every
// time -- clicking one sets `task` to its text directly.
const EXAMPLE_TASKS: { label: string; task: string }[] = [
  {
    label: 'Triage support tickets',
    task: 'Triage incoming support tickets: classify by urgency, draft a suggested reply, and flag anything that mentions a refund for human review.',
  },
  {
    label: 'Summarize documents',
    task: 'Summarize incoming documents into a short executive summary and extract key action items.',
  },
  {
    label: 'Route to a specialist',
    task: 'Route incoming questions to the right specialist (billing, technical, or general), then have that specialist draft a response.',
  },
  {
    label: 'Debate the best answer',
    task: 'Have two proposers debate the best answer to an incoming question, then have an arbitrator pick the winning response.',
  },
];

const HEADLINE_FIELDS = new Set(['cost_usd', 'latency_ms', 'tokens_total', 'router_reasoning']);

/**
 * Step-level cost/token/reasoning breakdown for an EXISTING agentic-
 * pipeline-family instance -- the payoff for the local metadata capture
 * work (DAGSTER_HOME pinning + scripts/extract_run_metadata.py): every
 * step is its own Dagster asset ("{prefix}_{step_id}"), and each one's
 * latest materialization carries real cost_usd/latency_ms/tokens_total/
 * router_reasoning/etc. metadata the component itself attaches. Reuses
 * the same ingestion-history event log IngestionsPanel already reads
 * (no new backend endpoint) -- just filtered down to this pipeline's own
 * step asset keys and grouped to the latest per key.
 */
function LastRunPanel({
  projectId,
  prefix,
  steps,
}: {
  projectId: string;
  prefix: string;
  steps: { id: string; op?: string }[];
}) {
  const stepAssetKeys = useMemo(() => steps.map((s) => `${prefix}_${s.id}`), [prefix, steps]);
  const { data: history } = useQuery({
    queryKey: ['ingestion-history-for-pipeline', projectId],
    queryFn: () => assetsApi.ingestionHistory(projectId, 3000),
    staleTime: 15_000,
  });
  const [expanded, setExpanded] = useState(false);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const latestByAssetKey = useMemo(() => {
    const keySet = new Set(stepAssetKeys);
    const map = new Map<string, NonNullable<typeof history>['events'][number]>();
    for (const e of history?.events ?? []) {
      if (e.type !== 'materialize' || e.status !== 'success' || !e.metadata || !keySet.has(e.asset_key)) continue;
      const prev = map.get(e.asset_key);
      if (!prev || new Date(e.ts).getTime() > new Date(prev.ts).getTime()) map.set(e.asset_key, e);
    }
    return map;
  }, [history, stepAssetKeys]);

  const stepRows = steps.map((step) => {
    const assetKey = `${prefix}_${step.id}`;
    const event = latestByAssetKey.get(assetKey);
    const fields = event?.metadata ? parseStepMetadataFields(step.id, event.metadata) : null;
    return { step, event, fields };
  });

  const totalCost = stepRows.reduce((s, r) => s + (Number(r.fields?.cost_usd) || 0), 0);
  const totalLatency = stepRows.reduce((s, r) => s + (Number(r.fields?.latency_ms) || 0), 0);
  const totalTokens = stepRows.reduce((s, r) => s + (Number(r.fields?.tokens_total) || 0), 0);
  const anyRun = stepRows.some((r) => r.event);

  if (!anyRun) {
    return (
      <div className="px-6 py-2 border-b border-gray-100 bg-gray-50 text-xs text-gray-400">
        No run data yet — materialize this pipeline to see its cost/token/reasoning breakdown here.
      </div>
    );
  }

  return (
    <div className="border-b border-gray-100 bg-gray-50">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-2 text-xs font-medium text-gray-700 hover:bg-gray-100"
      >
        <span className="flex items-center gap-1.5">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Last run
        </span>
        <span className="flex items-center gap-3 text-gray-500 font-normal">
          {totalCost > 0 && (
            <span className="inline-flex items-center gap-0.5"><DollarSign className="w-3 h-3" />{formatCost(totalCost)}</span>
          )}
          {totalLatency > 0 && (
            <span className="inline-flex items-center gap-0.5"><Clock className="w-3 h-3" />{formatLatency(totalLatency)}</span>
          )}
          {totalTokens > 0 && (
            <span className="inline-flex items-center gap-0.5"><Hash className="w-3 h-3" />{totalTokens} tokens</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="px-6 pb-3 space-y-1.5">
          {stepRows.map(({ step, event, fields }) => {
            const isStepExpanded = expandedSteps.has(step.id);
            const extraFields = fields
              ? Object.entries(fields).filter(([k]) => !HEADLINE_FIELDS.has(k))
              : [];
            return (
              <div key={step.id} className="bg-white border border-gray-200 rounded-md">
                <button
                  onClick={() =>
                    setExpandedSteps((prev) => {
                      const next = new Set(prev);
                      if (next.has(step.id)) next.delete(step.id);
                      else next.add(step.id);
                      return next;
                    })
                  }
                  disabled={!event}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 text-xs text-left disabled:cursor-default"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="font-medium text-gray-800 truncate">{step.id}</span>
                    {step.op && <span className="text-gray-400 font-mono flex-shrink-0">{step.op}</span>}
                  </span>
                  {event ? (
                    <span className="flex items-center gap-2.5 text-gray-500 flex-shrink-0">
                      {fields?.cost_usd != null && <span>{formatCost(fields.cost_usd)}</span>}
                      {fields?.latency_ms != null && <span>{formatLatency(fields.latency_ms)}</span>}
                      {fields?.tokens_total != null && <span>{fields.tokens_total} tok</span>}
                      {isStepExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </span>
                  ) : (
                    <span className="text-gray-300 italic flex-shrink-0">not run yet</span>
                  )}
                </button>
                {isStepExpanded && fields && (
                  <div className="px-2.5 pb-2 space-y-1 border-t border-gray-100 pt-1.5">
                    {fields.router_reasoning && (
                      <p className="text-[11px] text-gray-600 italic">"{String(fields.router_reasoning)}"</p>
                    )}
                    {extraFields.length > 0 && (
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                        {extraFields.map(([k, v]) => {
                          const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
                          return (
                            <div key={k} className="truncate" title={display}>
                              <span className="text-gray-400">{k}:</span> {display}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The "Agents & Pipelines" bin's scoped Genie entry point: describe what
 * you want in plain English, no component picker step, as an actual
 * back-and-forth chat rather than a one-shot form. Unlike the general
 * DagsterAIBar flow (which searches the whole ~700-component
 * asset-producing catalog), this calls /ai/plan with
 * scope: "agents_pipelines" -- the backend plans against a small, fixed
 * ~16-component pool (real agent frameworks and whole-pipeline
 * components: agentic_pipeline, LangGraph, MCP tool-use agents, ...), so
 * there's no catalog-selection step for the LLM to get wrong and no
 * reason to make the user pick a component first for something this
 * sophisticated -- see agents_pipelines_component_ids in
 * genie_service.py for exactly which components that pool contains.
 *
 * When Genie doesn't have enough information for a field (a data source,
 * a destination, ...), it sets `clarifying_question` instead of guessing
 * a plausible-looking fake value -- rendered here as a chat bubble with
 * clickable suggested answers (when Genie offered any) plus a free-text
 * reply, always. Answering resubmits with the prior plan + your answer
 * as context (the same refine/regenerate contract DagsterAIBar uses),
 * and Genie may ask another question in response -- the conversation
 * continues until clarifying_question comes back null, at which point
 * "Add to graph" becomes available.
 *
 * `editingComponent`, when given (from ComponentConfigModal's "Edit with
 * Genie" button on an existing whole-pipeline-family instance -- see
 * AGENTIC_PIPELINE_FAMILY), skips the "describe from scratch" intro
 * entirely: the conversation opens already seeded with that component's
 * REAL current config as if Genie had just proposed it, so the user only
 * has to say what to change. This reuses the exact same refine/regenerate
 * mechanism as any other follow-up (send() doesn't need to know it's
 * "editing" vs "building" -- previous_plan is previous_plan either way),
 * which is also why _build_user_prompt's previous-plan rendering had to
 * start including each pick's actual `config` -- without that, the model
 * would have no visibility into what it's supposed to be editing.
 */
export function AgentPipelineBuilder({
  onClose,
  editingComponent,
}: {
  onClose: () => void;
  editingComponent?: ComponentInstance | null;
}) {
  const { currentProject } = useProjectStore();
  const queryClient = useQueryClient();
  const seedPick: AgentPick | null = editingComponent
    ? {
        component_type: editingComponent.component_type,
        asset_name: (editingComponent.attributes?.asset_name as string) || editingComponent.label || editingComponent.id,
        upstream_asset_names: parseUpstreamAssetKeys(
          editingComponent.attributes?.upstream_asset_keys ?? editingComponent.attributes?.upstream_asset_key,
        ),
        config: editingComponent.attributes || {},
        reason: '',
        action: 'edit',
      }
    : null;
  const [task, setTask] = useState(() =>
    editingComponent ? `Edit the existing "${seedPick!.asset_name}" pipeline` : '',
  );
  const [reply, setReply] = useState('');
  const [turns, setTurns] = useState<Turn[]>(() =>
    seedPick ? [{ role: 'genie', plan: { picks: [seedPick], notes: [], clarifying_question: null } }] : [],
  );
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  // Filter text for a long clarifying_question.options list (real project
  // asset names -- could be hundreds, not the 2-4 generic categories a
  // fixed row of chat-bubble buttons was designed for). Reset whenever a
  // new question comes in so stale filter text from a previous turn's
  // options doesn't carry over.
  const [optionFilter, setOptionFilter] = useState('');
  // Above this many options, render a filterable list instead of a flat
  // wrap of chip buttons -- a handful of categories ("A file", "A URL/API")
  // reads fine as chips, but real_names off an existing_assets list (see
  // genie_service.py's DataFrame-output backstop) does not.
  const MANY_OPTIONS_THRESHOLD = 8;

  const latestPlan = [...turns].reverse().find((t): t is Extract<Turn, { role: 'genie' }> => t.role === 'genie')?.plan ?? null;
  // In edit mode, turns starts pre-seeded with the existing pick (so the
  // user sees its current config immediately) -- turns.length > 1 means
  // at least one real exchange happened, not just the seed. Without this
  // gate, "Add to graph" would be clickable before the user asked for
  // any change at all, which would just reinstall an identical copy.
  const isReady = !!latestPlan && latestPlan.picks.length > 0 && !latestPlan.clarifying_question
    && (!editingComponent || turns.length > 1);

  // `answer`, when given, is the user's reply to Genie's last
  // clarifying_question -- resubmits with the prior plan as context so
  // Genie can fill in what it asked about instead of starting over. Same
  // refine/regenerate contract DagsterAIBar uses. With no `answer`, this
  // is the FIRST message in the conversation (the initial task).
  const send = async (text: string, answer?: string) => {
    if (!currentProject || !text.trim() || planning) return;
    setPlanning(true);
    setTurns((prev) => [...prev, { role: 'user', text: text.trim() }]);
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
      if (answer && latestPlan) {
        body.previous_plan = latestPlan.picks;
        body.refinement = answer;
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
      setTurns((prev) => [...prev, { role: 'genie', plan: data }]);
      setOptionFilter('');
      if (data.picks.length === 0 && !data.clarifying_question) {
        notify.warning(data.notes.join('\n') || 'Could not build a plan for that description.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to plan: ${msg}`);
      // Drop the just-added user turn -- it never got a response, so
      // leaving it in the thread would look like Genie silently ignored it.
      setTurns((prev) => prev.slice(0, -1));
    } finally {
      setPlanning(false);
    }
  };

  const startConversation = () => {
    if (!task.trim()) return;
    send(task);
  };

  const replyTo = (answer: string) => {
    if (!answer.trim()) return;
    send(answer, answer);
    setReply('');
  };

  const apply = async () => {
    if (!latestPlan || !currentProject || applying || latestPlan.picks.length === 0) return;
    setApplying(true);
    try {
      const { installed, failed, warnings } = await applyGeniePicks(
        currentProject.id,
        latestPlan.picks,
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
        notify.error(`Could not install any of the ${latestPlan.picks.length} proposed picks.`);
      } else {
        notify.warning(`Added ${installed} of ${latestPlan.picks.length} picks; ${failed} failed. See console.`);
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
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">
              {editingComponent ? `Edit "${seedPick!.asset_name}" with Genie` : 'Build an agent or pipeline'}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        {editingComponent && currentProject
          && Array.isArray(editingComponent.attributes?.steps)
          && typeof editingComponent.attributes?.asset_name_prefix === 'string'
          && (
            <LastRunPanel
              projectId={currentProject.id}
              prefix={editingComponent.attributes.asset_name_prefix}
              steps={editingComponent.attributes.steps}
            />
          )}

        {turns.length === 0 ? (
          <div className="px-6 py-4 flex-1 space-y-4">
            <p className="text-sm text-gray-500">
              Describe what it should do — no need to pick a component first. This is scoped to
              real agent frameworks and whole-pipeline components (LangGraph, MCP tool-use agents,
              multi-step pipelines, ...), so it can pick the right one and draft the full config,
              asking if it needs anything it can't figure out on its own.
            </p>

            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what it should do…"
              rows={4}
              disabled={planning}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />

            {!task && (
              <div className="-mt-2 space-y-1.5">
                <p className="text-xs text-gray-400">Or try an example:</p>
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLE_TASKS.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      onClick={() => setTask(ex.task)}
                      disabled={planning}
                      className="px-2.5 py-1 text-xs border border-gray-300 text-gray-700 bg-white rounded-full hover:border-primary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              onClick={startConversation}
              disabled={!task.trim() || planning}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {planning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" /> Generate
                </>
              )}
            </button>
          </div>
        ) : (
          <>
            <div className="px-6 py-4 flex-1 overflow-y-auto space-y-4">
              {turns.map((turn, i) =>
                turn.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] flex items-start gap-2 flex-row-reverse">
                      <div className="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <User className="w-3.5 h-3.5 text-gray-500" />
                      </div>
                      <div className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">
                        {turn.text}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[85%] flex items-start gap-2">
                      <div className="w-6 h-6 rounded-full bg-violet-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Sparkles className="w-3.5 h-3.5 text-violet-600" />
                      </div>
                      <div className="space-y-2 min-w-0">
                        {/* Picks proposed so far this turn */}
                        {turn.plan.picks.length > 0 && (
                          <div className="space-y-2">
                            {turn.plan.picks.map((pick, j) => (
                              <div key={j} className="border border-gray-200 rounded-md p-3 bg-gray-50">
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

                        {/* The question itself, as a bubble */}
                        {turn.plan.clarifying_question ? (
                          <div className="bg-blue-50 border border-blue-200 text-blue-900 rounded-lg px-3 py-2 text-sm">
                            {turn.plan.clarifying_question.question}
                          </div>
                        ) : i === 0 && editingComponent ? (
                          <div className="bg-gray-50 border border-gray-200 text-gray-700 rounded-lg px-3 py-2 text-sm">
                            This is the current config — expand it below. What would you like to change?
                          </div>
                        ) : turn.plan.picks.length > 0 ? (
                          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2 text-sm">
                            Ready — click "Add to graph" below, or tell me what to change.
                          </div>
                        ) : (
                          <div className="bg-gray-50 border border-gray-200 text-gray-600 rounded-lg px-3 py-2 text-sm">
                            {turn.plan.notes.join('\n') || 'Could not build a plan for that — try adding more detail.'}
                          </div>
                        )}

                        {/* Info/warning notes (auto-repair, etc.) -- shown
                            plainly, never as the primary bubble. */}
                        {turn.plan.notes.filter((n) => !n.startsWith('❓')).map((n, k) => (
                          <div
                            key={k}
                            className={`text-xs rounded px-2.5 py-1.5 ${
                              n.startsWith('ℹ') ? 'bg-gray-50 text-gray-500' : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {n}
                          </div>
                        ))}

                        {/* Suggested answers -- only on the LAST turn's
                            question, so old questions don't stay clickable
                            after the conversation has moved on. A short
                            list of categories reads fine as a row of chat
                            chips; a long list of real project asset names
                            (could be hundreds) does not -- past
                            MANY_OPTIONS_THRESHOLD, render a filterable
                            scrollable list instead, the same "search a
                            long list of assets" pattern ComponentConfigModal
                            uses for upstream_asset_keys. */}
                        {turn.plan.clarifying_question?.options && i === turns.length - 1 && (
                          turn.plan.clarifying_question.options.length > MANY_OPTIONS_THRESHOLD ? (
                            <div className="space-y-1.5">
                              <input
                                type="text"
                                value={optionFilter}
                                onChange={(e) => setOptionFilter(e.target.value)}
                                placeholder={`Filter ${turn.plan.clarifying_question.options.length} options…`}
                                disabled={planning}
                                className="w-full px-2.5 py-1 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                              />
                              <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100 bg-white">
                                {turn.plan.clarifying_question.options
                                  .filter((opt) => opt.toLowerCase().includes(optionFilter.toLowerCase()))
                                  .map((opt) => (
                                    <button
                                      key={opt}
                                      onClick={() => replyTo(opt)}
                                      disabled={planning}
                                      className="block w-full text-left px-2.5 py-1.5 text-xs text-violet-700 hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      {opt}
                                    </button>
                                  ))}
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {turn.plan.clarifying_question.options.map((opt) => (
                                <button
                                  key={opt}
                                  onClick={() => replyTo(opt)}
                                  disabled={planning}
                                  className="px-2.5 py-1 text-xs border border-violet-300 text-violet-700 bg-white rounded-full hover:bg-violet-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {opt}
                                </button>
                              ))}
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                ),
              )}
              {planning && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…
                  </div>
                </div>
              )}
            </div>

            {/* Persistent reply box -- answers a pending question when
                there is one, or just keeps refining the plan otherwise
                (e.g. "also handle Spanish-language tickets"). */}
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && reply.trim()) {
                      e.preventDefault();
                      replyTo(reply);
                    }
                  }}
                  placeholder={
                    latestPlan?.clarifying_question
                      ? 'Type your answer…'
                      : 'Ask for changes, or add more detail…'
                  }
                  disabled={planning || applying}
                  className="flex-1 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                />
                <button
                  onClick={() => replyTo(reply)}
                  disabled={!reply.trim() || planning || applying}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/10 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {planning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  Send
                </button>
              </div>
            </div>
          </>
        )}

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
            disabled={!isReady || applying}
            title={!isReady && latestPlan?.clarifying_question ? 'Answer the question above first' : undefined}
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
