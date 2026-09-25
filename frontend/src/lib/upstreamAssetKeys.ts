/**
 * `upstream_asset_keys` is schema'd as an array on every component we've
 * seen (sql_transform, dataframe_transformer, ...), but has been written
 * as a comma-separated STRING in a few places in this codebase's history
 * -- each one a real, confirmed incident this session:
 *
 * - DagsterAIBar's apply() used to `.join(', ')` an array into a string
 *   before sending it to the install endpoint.
 * - ComponentConfigModal's multi-select field used to assume the value
 *   was always a string and called `.split(',')` on it directly, which
 *   crashed outright the moment the value was ALREADY a correctly-typed
 *   array (arrays have no .split()) -- confirmed live as the cause of a
 *   blank/gray screen opening the component config modal.
 *
 * Parsing defensively here (once, in one place) means every caller gets
 * the same, correct behavior regardless of which shape actually shows up.
 */
export function parseUpstreamAssetKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
