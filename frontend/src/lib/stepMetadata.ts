// Each step's own metadata entries all share the "{step_id}__{field}"
// label convention (see genie_service.py's _AGENTIC_PIPELINE_FAMILY /
// PICK A MODEL/PROVIDER ONCE comments, and the real component source at
// dagster-component-templates/assets/ai/agentic_pipeline/component.py) --
// strip the known step id prefix to get the plain field name back. A
// step id containing "__" itself would be ambiguous with this scheme;
// not a real-world concern (steps are named like `classify_urgency`,
// single underscores) but worth knowing if a step's fields ever look
// wrong for this reason.
export function parseStepMetadataFields(
  stepId: string,
  entries: { label: string; value: any }[],
): Record<string, any> {
  const prefix = `${stepId}__`;
  const out: Record<string, any> = {};
  for (const e of entries) {
    if (e.label.startsWith(prefix)) out[e.label.slice(prefix.length)] = e.value;
  }
  return out;
}

export function formatCost(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `$${n < 0.01 ? n.toFixed(6) : n.toFixed(4)}`;
}

export function formatLatency(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}
