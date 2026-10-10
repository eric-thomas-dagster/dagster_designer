import { useEffect, useMemo, useState } from 'react';
import { Sparkles, X, Loader2, Check, User, ChevronDown, ChevronRight, DollarSign, Clock, Hash, FolderOpen } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { notify } from './Notifications';
import { openSettings, onAiProvidersChanged } from './SettingsDialog';
import { API_BASE, assetsApi, aiApi, type AiProvidersStatus } from '@/services/api';
import { pickFile } from '@/services/tauri';
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
    // Plain analyst-voice phrasing, not schema-literal -- the earlier,
    // equally-plain version of this exact example ("Triage incoming
    // support tickets: classify by urgency...") was what first exposed a
    // real planner bug: it got built as ONE agentic_pipeline chaining
    // plain classify/llm_call steps against the whole ticket DataFrame at
    // once, which always fails materialize (that component only ever
    // emits one aggregate dict, never a per-row DataFrame the project's
    // IO manager can store). That's now covered by a deterministic
    // backstop (_per_row_partition_misuse in genie_service.py) plus
    // stronger SYSTEM_PROMPT guidance, so the example text itself can go
    // back to reading like a real request instead of leaking component
    // internals (upstream_asset_key, response_column, ...) that have no
    // business being in a "just describe it" example. Model choice
    // (gpt-4o-mini) baked in to match every one of these examples' own
    // validated reference run and skip the "which LLM" question --
    // a real analyst describing this would already know what they want.
    label: 'Triage support tickets',
    task: 'We get a steady stream of customer support tickets and I want to automatically triage them: figure out how urgent each one is, draft a suggested reply the team can review, and flag anything that mentions a refund so a person double-checks it before it goes out. Use gpt-4o-mini for all of it.',
  },
  {
    // Matches the officially-bundled document_summarization example --
    // ran for real against a checkout-latency incident postmortem.
    label: 'Summarize documents',
    task: 'Summarize incoming documents (think incident postmortems, status reports, that kind of thing) into a short executive summary and extract key action items. Use gpt-4o-mini.',
  },
  {
    // Matches the officially-bundled route_to_specialist example's real,
    // validated roster + sample questions verbatim.
    label: 'Route to a specialist',
    task: 'We have three specialists -- billing (refunds, subscription charges, payment issues), technical (bugs, errors, API problems), and general (plans, pricing, anything that doesn\'t fit the other two) -- and I want incoming customer questions routed to whichever one actually fits, then have that specialist draft a response. Use gpt-4o-mini.',
  },
  {
    // Matches the officially-bundled debate_best_answer example's real
    // proposal verbatim.
    label: 'Debate the best answer',
    task: 'Have two agents debate this proposal: "our team should switch from a 2-week sprint cadence to continuous/weekly releases." One should argue for it, one against, then a separate arbitrator should weigh both sides and render a final verdict. Use gpt-4o-mini.',
  },
  {
    // Matches the officially-bundled pipeline_incident_triage example
    // (tool_use_loop: one agent, three real tools, iterating freely
    // until it has enough evidence -- not a forced single call).
    label: 'Pipeline incident triage',
    task: 'When something breaks in one of our pipelines, I want an assistant that pulls together the vendor status page, recent deploys, and anything we know from past incidents, figures out the likely root cause, and tells me whether to just wait it out or start actually debugging. Use gpt-4o-mini.',
  },
  {
    // Matches the officially-bundled oncall_escalation_simulator example
    // (extends pipeline_incident_triage one stage further: diagnosis,
    // THEN a genuine semantic delegate pick of which on-call team owns
    // it -- no required_capabilities lookup table, real judgment call).
    label: 'On-call escalation',
    task: 'When an incident needs to be escalated, look at the vendor status, recent deploys, and our runbooks to figure out what\'s actually going on, then decide which on-call team -- infra, data, or payments -- should own it, and draft them a message explaining why. Use gpt-4o-mini.',
  },
  {
    // Matches the officially-bundled pr_review_bot example, including
    // the exact real, benign PR it was validated against
    // (dagster-io/dagster#31999) so this is runnable as-is, not just
    // illustrative.
    label: 'PR review bot',
    task: 'When a pull request comes in, pull its real diff from GitHub, have a security reviewer, a style reviewer, and a test-coverage reviewer each look it over from their own angle, then combine their feedback into one review. Use dagster-io/dagster#31999 as the pull request to review, and gpt-4o-mini for all three reviewers.',
  },
  {
    // Matches the officially-bundled support_fleet_mission_control
    // example's real, validated 6-agent roster verbatim (the "at scale"
    // story: a whole roster of agents loaded from one external manifest,
    // each incoming item routed to whichever one genuinely fits,
    // digested into one summary via synthesize).
    label: 'Specialist fleet routing',
    task: 'We have a roster of six specialists -- billing, technical, security, refunds, legal, and enterprise -- and a stream of incoming support tickets. For each ticket, route it to whichever specialist on the roster actually fits, then give me one daily digest summarizing what got routed where and why. Use gpt-4o-mini.',
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

// Same ordering/rationale as DagsterAIBar's copy of this list: first
// available-per-provider entry becomes the default.
const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (recommended)' },
  { value: 'gpt-4o', label: 'GPT-4o (recommended)' },
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5 (highest quality)' },
  { value: 'gpt-5-mini', label: 'GPT-5 mini' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini (fast, cheap)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast)' },
];

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

  // Which LLM providers have an API key configured -- surfaced as an
  // actionable "add a key" banner up front (same pattern as DagsterAIBar),
  // instead of letting the user type a whole task description only to
  // hit an opaque "OPENAI_API_KEY is not set on the backend" error after
  // clicking submit.
  const [providers, setProviders] = useState<AiProvidersStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      aiApi.providers()
        .then((d) => { if (!cancelled) setProviders(d); })
        .catch(() => { if (!cancelled) setProviders({ openai_available: false, anthropic_available: false, any_available: false, anthropic_workspace_id_configured: false }); });
    };
    load();
    const unsubscribe = onAiProvidersChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // The banner above only checked `any_available` (true if EITHER
  // provider has a key), but the actual /ai/plan request never included a
  // `model` field at all -- it silently fell through to the backend's
  // DEFAULT_MODEL ("gpt-4o"), which only works if OPENAI_API_KEY is set.
  // Configuring only an Anthropic key passed the banner check but still
  // hit "OPENAI_API_KEY is not set on the backend", confirmed live.
  // Mirrors DagsterAIBar's provider-aware model selection so a configured
  // Anthropic-only key actually gets used instead of silently defaulting
  // to a provider with no key.
  const availableModels = useMemo(() => {
    if (!providers) return MODEL_OPTIONS;
    return MODEL_OPTIONS.filter((m) => {
      const isClaude = m.value.startsWith('claude');
      return isClaude ? providers.anthropic_available : providers.openai_available;
    });
  }, [providers]);
  const [model, setModel] = useState(MODEL_OPTIONS[0].value);
  useEffect(() => {
    if (!providers || availableModels.length === 0) return;
    if (!availableModels.find((m) => m.value === model)) {
      setModel(availableModels[0].value);
    }
  }, [providers, availableModels, model]);
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

  // `text` is this turn's new message -- either the very first task
  // description, or the user's reply to Genie's last clarifying_question.
  // No separate "answer" param needed any more: with real `history` now
  // doing the remembering (see below), every call is just "here's the
  // next thing the user said," the same shape whether it's turn 1 or
  // turn 10.
  const send = async (text: string) => {
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
      // Real conversation history instead of a previous_plan/refinement
      // reconstruction -- see genie_service.py's `history` param
      // docstring for why. `turns` already has exactly what's needed
      // (every past user message + every past Genie JSON reply); this
      // just maps it to {role, content} pairs and appends the NEWEST
      // user message (not yet in `turns` -- setTurns above is
      // async/batched, so building from the closure value plus this
      // call's own `text` is the reliable way to include it).
      const history: { role: 'user' | 'assistant'; content: string }[] = [];
      const firstTurn = turns[0];
      if (firstTurn?.role === 'genie') {
        // Edit-mode seed: turns starts with a Genie turn (the existing
        // component's current config), no user turn before it -- both
        // providers require the first message to be `user`, and a human
        // reader needs the same framing. Synthesize one.
        history.push({ role: 'user', content: `Here is the existing "${firstTurn.plan.picks[0]?.asset_name}" component's current configuration:\n${JSON.stringify(firstTurn.plan)}` });
      }
      for (const t of turns) {
        if (t.role === 'user') {
          history.push({ role: 'user', content: t.text });
        } else if (t !== firstTurn) {
          // The seed turn (if any) was already pushed above as the
          // synthetic user message's "content" -- don't also push it
          // here as a second, redundant assistant turn.
          history.push({ role: 'assistant', content: JSON.stringify(t.plan) });
        }
      }
      history.push({ role: 'user', content: text.trim() });

      const body: Record<string, any> = {
        task: task.trim(),
        existing_assets: existing,
        project_id: currentProject.id,
        scope: 'agents_pipelines',
        model,
        history,
      };
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
    send(answer);
    setReply('');
  };

  // A clarifying_question can bundle two unrelated asks into one turn --
  // e.g. "What's the path to the CSV, AND which LLM provider?" -- where
  // only the second half has quick-pick option buttons. Clicking an
  // option used to call replyTo(opt) directly, which SILENTLY DISCARDED
  // whatever the user had just typed into the reply box for the other
  // half (setReply('') clears it without ever reading it first).
  // Confirmed live: typing a CSV path then clicking "Claude (Anthropic)"
  // sent only "Claude (Anthropic)" -- the path was never sent at all, so
  // the next turn asked the exact same combined question again, looking
  // like an endless loop. Folding any pending typed text in with the
  // clicked option fixes this without needing to restructure
  // clarifying_question into separate sub-answers.
  const pickOption = (opt: string) => {
    const typed = reply.trim();
    replyTo(typed && typed !== opt ? `${typed}; ${opt}` : opt);
  };

  // Heuristic, not a structured field from the backend (clarifying_question
  // only ever carries {question, options} -- no "kind" to key off) --
  // good enough to decide whether a "Browse…" file picker is worth
  // offering alongside the plain text reply box.
  const pendingQuestionWantsPath = /\bpath\b|\bfile\b|\bcsv\b|\burl\b/i.test(
    latestPlan?.clarifying_question?.question || ''
  );
  const browseForFile = async () => {
    const picked = await pickFile({ filters: [{ name: 'Data files', extensions: ['csv', 'json', 'parquet', 'tsv'] }] });
    if (picked) setReply((prev) => (prev.trim() ? `${prev.trim()} ${picked}` : picked));
  };

  const apply = async () => {
    if (!latestPlan || !currentProject || applying || latestPlan.picks.length === 0) return;
    setApplying(true);
    try {
      const { installed, failed, warnings, rolledBack } = await applyGeniePicks(
        currentProject.id,
        latestPlan.picks,
        resolveComponentIdFromCurrentProject,
      );
      await queryClient.invalidateQueries({ queryKey: ['installed-components', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['primitives', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['definitions', currentProject.id] });
      await queryClient.invalidateQueries({ queryKey: ['installed-resources', currentProject.id] });

      if (rolledBack) {
        // Dagster's definitions build is all-or-nothing -- applyGeniePicks
        // already caught this (post-install validation) and undid the
        // adds, so the project is back to exactly how it was before this
        // click. Said plainly so the user knows nothing is broken AND
        // nothing silently landed, rather than reading like an ordinary
        // per-pick failure.
        notify.error(`This plan would have broken the project, so nothing was added:\n${rolledBack}`);
        return;
      }

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
    } catch (e) {
      // This try had no catch before -- confirmed live as the reason a
      // partial-apply failure was completely invisible: applyGeniePicks
      // (or the invalidateQueries calls after it) throwing here used to
      // propagate as an unhandled rejection, logged only to the browser
      // console, while the modal just sat there looking like nothing
      // happened. Now it's an ordinary visible error instead.
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to add picks to the graph: ${msg}`);
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

            {providers && !providers.any_available && (
              <div className="flex items-start gap-3 px-4 py-3 border border-amber-200 bg-amber-50 rounded-md">
                <Sparkles className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-sm">
                  <div className="font-semibold text-gray-900 mb-1">Genie needs an API key</div>
                  <div className="text-xs text-gray-600 mb-2">
                    Add an OpenAI or Anthropic key to plan agents/pipelines — takes effect immediately, no restart needed.
                  </div>
                  <button
                    onClick={openSettings}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Add API key…
                  </button>
                </div>
              </div>
            )}

            {/* Confirmed live: users describe a pipeline assuming it'll
                somehow handle the data question for them, then get stuck
                being asked for a file path they don't have. Setting the
                expectation up front, before they even start typing, beats
                them discovering the constraint mid-conversation. */}
            <p className="text-xs text-gray-500">
              The pipeline needs real data to run on: an existing asset in this
              project, a file/database/API you can point to, or synthetic test
              data Designer generates for you. You'll be asked which, if it
              isn't obvious from your description.
            </p>

            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what it should do…"
              rows={4}
              disabled={planning || (providers ? !providers.any_available : false)}
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
                      disabled={planning || (providers ? !providers.any_available : false)}
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
              disabled={!task.trim() || planning || (providers ? !providers.any_available : false)}
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

                        {/* Info/warning notes (auto-repair, dropped/renamed
                            picks, etc.) -- real signal for someone
                            debugging a plan, but raw and alarming-looking
                            to read cold (e.g. "references unknown asset"
                            reads as "your pipeline is broken" even when
                            it's just a redundant duplicate pick getting
                            silently cleaned up). Tucked behind a single
                            disclosure instead of shown as bare lines, same
                            pattern as each pick's own Config disclosure. */}
                        {(() => {
                          const visible = turn.plan.notes.filter((n) => !n.startsWith('❓'));
                          if (visible.length === 0) return null;
                          const warnings = visible.filter((n) => !n.startsWith('ℹ'));
                          return (
                            <details className="text-xs">
                              <summary className="cursor-pointer text-gray-400 hover:text-gray-600 select-none">
                                {warnings.length > 0
                                  ? `${warnings.length} thing${warnings.length === 1 ? '' : 's'} to double-check`
                                  : `${visible.length} automatic fix${visible.length === 1 ? '' : 'es'} applied`}
                              </summary>
                              <div className="mt-1.5 space-y-1">
                                {visible.map((n, k) => (
                                  <div
                                    key={k}
                                    className={`rounded px-2.5 py-1.5 ${
                                      n.startsWith('ℹ') ? 'bg-gray-50 text-gray-500' : 'bg-amber-50 text-amber-700'
                                    }`}
                                  >
                                    {n}
                                  </div>
                                ))}
                              </div>
                            </details>
                          );
                        })()}

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
                                      onClick={() => pickOption(opt)}
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
                                  onClick={() => pickOption(opt)}
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
                (e.g. "also handle Spanish-language tickets"). The pending
                question itself only ever appeared up in the scrolling chat
                transcript, with nothing tying it to this box -- confirmed
                live as genuinely confusing: it read as a generic "ask for
                changes" field, not "this is where you answer the question
                above," especially once the transcript had scrolled. Each
                question gets restated right here, directly above where
                the answer goes, closing that gap. */}
            {latestPlan?.clarifying_question && (
              <div className="px-4 pt-2.5 pb-1.5 bg-violet-50 border-t border-violet-100 text-xs text-violet-900">
                <span className="font-semibold">Answering:</span>{' '}
                {latestPlan.clarifying_question.question}
              </div>
            )}
            <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
              <div className="flex items-center gap-2">
                {pendingQuestionWantsPath && (
                  <button
                    onClick={browseForFile}
                    disabled={planning || applying}
                    title="Browse for a local file -- fills in its path below"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-sm text-gray-700 border border-gray-300 bg-white rounded-md hover:bg-gray-100 disabled:opacity-50"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    Browse…
                  </button>
                )}
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
              {/* A clarifying_question can bundle an open-ended ask (the
                  file path) together with quick-pick options (the model) in
                  one turn -- type the path here, THEN click a model button
                  below; both now get sent together instead of the typed
                  text being silently dropped. */}
              {pendingQuestionWantsPath && latestPlan?.clarifying_question?.options && (
                <p className="mt-1.5 text-[11px] text-gray-500">
                  Type the path above, then click a model below — both get sent together.
                </p>
              )}
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
