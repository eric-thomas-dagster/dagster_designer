import { JoinSidebar } from './JoinSidebar';
import { FilterSidebar } from './FilterSidebar';
import { AggregateSidebar } from './AggregateSidebar';
import { SqlTransformSidebar } from './SqlTransformSidebar';

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

const MATCHERS: Array<{ test: (componentType: string) => boolean; Sidebar: Sidebar }> = [
  {
    // Every DataFrame / warehouse / spatial / cross join maps here.
    // Keep the regex specific enough to exclude names that just contain
    // "join" in a different meaning ("joint_...", "join_asset_check").
    test: (t) =>
      /(?:^|[._])(?:dataframe|warehouse|spatial|cross|left|right|inner|outer|anti)_?join(?:$|[._])/i.test(t) ||
      /\.(?:Dataframe|Warehouse|Spatial|Cross|Left|Right|Inner|Outer|Anti)?Join(?:Component)?$/i.test(t),
    Sidebar: JoinSidebar,
  },
  {
    // filter (community pandas-query variant) + warehouse_filter (SQL
    // predicate). Also matches bare `.FilterComponent` types.
    test: (t) =>
      /(?:^|[._])(?:warehouse_)?filter(?:$|[._])/i.test(t) ||
      /\.(?:Warehouse)?FilterComponent$/i.test(t),
    Sidebar: FilterSidebar,
  },
  {
    // summarize + warehouse_summarize. Also SummarizeComponent /
    // aggregate names for user forks.
    test: (t) =>
      /(?:^|[._])(?:warehouse_)?(?:summarize|aggregate|group_by)(?:$|[._])/i.test(t) ||
      /\.(?:Warehouse)?(?:Summarize|Aggregate)Component$/i.test(t),
    Sidebar: AggregateSidebar,
  },
  {
    // Community sql_transform + our built-in SqlTransformerComponent.
    test: (t) =>
      /(?:^|[._])sql_transform(?:er)?(?:$|[._])/i.test(t) ||
      /\.SqlTransform(?:er)?Component$/i.test(t),
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
