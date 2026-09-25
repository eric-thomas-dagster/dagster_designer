// Mirrors _AGENTIC_PIPELINE_FAMILY in genie_service.py -- the whole-
// pipeline "one YAML" component family (produces: multi_asset via a
// single `steps:` list). Config here is deeply nested (steps,
// specialists, proposers, arbitrator, ...), so "Edit with Genie" (a
// conversational edit instead of the raw JSON-schema form) is offered
// specifically for these, not every component.
export const AGENTIC_PIPELINE_FAMILY = new Set([
  'agentic_pipeline',
  'ml_pipeline',
  'polars_pipeline',
  'warehouse_pipeline',
]);
