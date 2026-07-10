import { JoinSidebar } from './JoinSidebar';
import { FilterSidebar } from './FilterSidebar';
import { AggregateSidebar } from './AggregateSidebar';
import { SqlTransformSidebar } from './SqlTransformSidebar';
import { GeoBoundingBoxSidebar } from './GeoBoundingBoxSidebar';

/**
 * Dispatcher for component-specific config panels. If a component_type
 * matches a specialized sidebar we know how to render, return its
 * component. Otherwise return null — the caller (PropertyPanel /
 * ComponentConfigModal) falls back to the schema-driven generic form.
 *
 * Add a new entry to `MATCHERS` to give a component a hand-tuned UX.
 * Keep the list small — the generic form handles 890+ community
 * components fine; hand-tune only the ones that clearly win with
 * bespoke layout (join, filter, aggregate, sql-transformer, sinks).
 */
type Sidebar = React.ComponentType<{
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
}>;

// Engine prefixes we accept in front of each transform kind. Written
// this way so a future `databricks_filter` / `snowflake_join` /
// `duckdb_summarize` community template automatically inherits the
// specialized sidebar with zero code change. Order doesn't matter —
// this is joined into one alternation.
const ENGINE_PREFIXES = [
  'warehouse',
  'dataframe',
  'databricks',
  'spark',
  'pyspark',
  'snowflake',
  'bigquery',
  'redshift',
  'duckdb',
  'clickhouse',
  'polars',
  'pandas',
  'motherduck',
  'trino',
  'presto',
  'athena',
];
const ENGINE_ALT = ENGINE_PREFIXES.join('|');
// Common class-name variants — CamelCase engine prefixes as they'd
// appear in a fully-qualified component_type ".DatabricksFilterComponent".
const ENGINE_CLASS_ALT = ENGINE_PREFIXES
  .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  .join('|');

function makeMatcher(kindPatterns: string[], classPatterns: string[]) {
  const idAlt = kindPatterns.join('|');
  const classAlt = classPatterns.join('|');
  // Only accept `.` (module boundary) or start-of-string before the
  // engine prefix. Rejects arbitrary `_word_filter` component ids
  // like `bounding_box_filter` that happen to end in "_filter" but
  // aren't the row-filter shape our FilterSidebar understands.
  const idRegex = new RegExp(
    `(?:^|\\.)(?:(?:${ENGINE_ALT})_)?(?:${idAlt})(?:$|\\.)`,
    'i',
  );
  const classRegex = new RegExp(
    `\\.(?:(?:${ENGINE_CLASS_ALT}))?(?:${classAlt})Component$`,
    'i',
  );
  return (t: string) => idRegex.test(t) || classRegex.test(t);
}

const MATCHERS: Array<{ test: (componentType: string) => boolean; Sidebar: Sidebar }> = [
  {
    // Geographic bounding box filter — gets a real map + draggable
    // rectangle instead of four raw number inputs. Only matches the
    // one component today; other geo-shaped things (spatial_join,
    // geo_buffer) have different config shapes and can get their own
    // dedicated sidebars later.
    test: (t) =>
      /(?:^|\.)bounding_box_filter(?:$|\.)/i.test(t) ||
      /\.BoundingBoxFilterComponent$/i.test(t),
    Sidebar: GeoBoundingBoxSidebar,
  },
  {
    // Any engine-prefixed join, plus specialty joins (cross / spatial / anti).
    // Keep the regex specific enough to exclude names that just contain
    // "join" in a different meaning ("joint_...", "join_asset_check").
    test: (t) => {
      const idRegex = new RegExp(
        `(?:^|\\.)(?:(?:${ENGINE_ALT}|cross|spatial|left|right|inner|outer|anti)_)?join(?:$|\\.)`,
        'i',
      );
      const classRegex = new RegExp(
        `\\.(?:${ENGINE_CLASS_ALT}|Cross|Spatial|Left|Right|Inner|Outer|Anti)?Join(?:Component)?$`,
        'i',
      );
      return idRegex.test(t) || classRegex.test(t);
    },
    Sidebar: JoinSidebar,
  },
  {
    // filter (pandas-query) + warehouse_filter (SQL predicate) + any
    // future <engine>_filter variant.
    test: makeMatcher(['filter'], ['Filter']),
    Sidebar: FilterSidebar,
  },
  {
    // summarize / aggregate / group_by across engines.
    test: makeMatcher(['summarize', 'aggregate', 'group_by'], ['Summarize', 'Aggregate']),
    Sidebar: AggregateSidebar,
  },
  {
    // Community sql_transform + built-in SqlTransformerComponent + any
    // engine-prefixed sql transform.
    test: makeMatcher(['sql_transform', 'sql_transformer'], ['SqlTransform', 'SqlTransformer']),
    Sidebar: SqlTransformSidebar,
  },
];

export function pickSpecializedSidebar(componentType: string | undefined | null): Sidebar | null {
  if (!componentType) return null;
  for (const { test, Sidebar } of MATCHERS) {
    if (test(componentType)) return Sidebar;
  }
  return null;
}
