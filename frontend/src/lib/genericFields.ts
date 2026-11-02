/* Moved verbatim from ComponentConfigModal so the ingestion wizard can group the same cross-cutting fields. */

// Generic-field grouping: many catalog components independently declare
// the same handful of cross-cutting concerns (freshness policy, partition
// config, retry policy, metadata) as plain schema fields, which rendered
// as one long undifferentiated list -- confirmed directly against a real
// ingestion component's schema (freshness_max_lag_minutes/freshness_cron,
// partition_type/partition_start/partition_values/dynamic_partition_name/
// partition_dimensions, retry_policy_max_retries/retry_policy_delay_
// seconds/retry_policy_backoff, description/group_name/owners/asset_tags/
// kinds, all flat and unlabeled). Classifying by NAME PATTERN (not a
// per-component allowlist) means this groups correctly for every
// component that follows these common conventions, not just the one it
// was found on. Fields that don't match any pattern stay in the main,
// ungrouped area -- this only tidies the common, recurring concerns, not
// a component's own unique configuration.
export type GenericFieldGroupKey = 'metadata' | 'freshness' | 'partition' | 'retry' | 'preview' | 'dependencies';

export const GENERIC_FIELD_GROUPS: Array<{ key: GenericFieldGroupKey; label: string; test: (name: string) => boolean }> = [
  { key: 'freshness', label: 'Freshness policy', test: (n) => /^freshness_/.test(n) },
  { key: 'partition', label: 'Partitioning', test: (n) => /^partition_/.test(n) || n === 'dynamic_partition_name' },
  { key: 'retry', label: 'Retry policy', test: (n) => /^retry_policy_|^retry_/.test(n) },
  { key: 'preview', label: 'Preview', test: (n) => n === 'include_preview_metadata' || n === 'preview_rows' },
  {
    key: 'metadata',
    label: 'Metadata',
    test: (n) => ['description', 'group_name', 'owners', 'tags', 'asset_tags', 'kinds', 'column_lineage'].includes(n),
  },
  // `deps` only -- NOT upstream_asset_key(s)/left_asset_key/etc, which are
  // component-specific "main data source" fields with their own per-
  // component semantics, always left prominent in the main area. Only
  // reached when `deps` isn't already suppressed by commonFieldNames
  // (i.e. new/factory components, where Post-processing's own
  // Dependencies section isn't available yet) -- previously sat alone,
  // ungrouped, next to e.g. partition/retry fields that DO get a labeled
  // home.
  { key: 'dependencies', label: 'Dependencies', test: (n) => n === 'deps' },
];

export function classifyGenericField(fieldName: string): GenericFieldGroupKey | null {
  const lower = fieldName.toLowerCase();
  for (const group of GENERIC_FIELD_GROUPS) {
    if (group.test(lower)) return group.key;
  }
  return null;
}

// snake_case/SCREAMING_CASE -> "Title Case" for any field whose label isn't
// already special-cased (Data source, Destination resource) -- e.g.
// `group_name` -> "Group Name". Applied as the generic fallback instead of
// the raw field name verbatim, which is what `isUnifiedSource`/
// `isDestinationResourceKey`'s hand-written labels were already doing for
// just the two fields someone had gotten around to special-casing.
export function prettifyFieldName(name: string): string {
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

