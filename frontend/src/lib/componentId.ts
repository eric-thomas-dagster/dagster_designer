// A component_type string is the fully-qualified Python class path
// (e.g. "stellantis_financial_services.components.ocr_extractor.component.OcrExtractorComponent"),
// not the short manifest id ("ocr_extractor") -- confirmed live: that's
// what install-via-cli returns (parsed straight from the written
// defs.yaml's `type:` field) for both a template_only install and a
// real saved instance, and it's what ends up on a saved
// ComponentInstance.component_type too. Family-membership checks
// (AGENTIC_PIPELINE_FAMILY, DOCUMENT_EXTRACTOR_FAMILY, ...) are all
// keyed by the short id, so they need this extracted first --
// comparing a short id against the raw component_type directly never
// matches anything real.
export function extractComponentId(componentType: string): string {
  const parts = componentType.split('.');
  const idx = parts.indexOf('components');
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  // Already a short id, or a shape we don't recognize -- pass through
  // rather than guess further.
  return componentType;
}
