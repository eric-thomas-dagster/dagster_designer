/**
 * Pull a short, human reason out of dg's long validation output so a failed change can say WHY it was undone
 * ("customers_with_domain: attributes.source -- Input should be a valid dictionary") instead of only
 * "Project validation failed". Returns null when nothing recognisable is found (callers then show their generic text).
 */
export function conciseValidationReason(text?: string | null): string | null {
  if (!text) return null;
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  const component = clean.match(/Error while loading component ([^\s:\[]+)/)?.[1];
  const lines = clean.split('\n');
  // pydantic via dagster:  `attributes.source at /path/defs.yaml:8`  followed by  "  Input should be ... [type=...]"
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^`([^`]+?)(?: at [^`]*)?`\s*$/);
    if (!m) continue;
    const next = (lines[i + 1] || '').trim();
    if (!next) continue;
    const msg = next.replace(/\s*\[type=[^\]]*\]\s*$/, '').replace(/,?\s*input_value=.*$/, '').trim();
    const got = next.match(/input_value=('[^']*'|"[^"]*"|[^,\]]+)/)?.[1];
    return `${component ? `${component}: ` : ''}${m[1]} -- ${msg}${got ? ` (got ${got})` : ''}`;
  }
  const generic = lines.find((l) => /Component type '.+' not found|Duplicate (asset|definition)|was not found|DagsterInvalid\w+/.test(l));
  if (generic) return `${component ? `${component}: ` : ''}${generic.trim().slice(0, 240)}`;
  return component ? `${component} could not be loaded` : null;
}
