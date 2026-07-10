import { JoinSidebar } from './JoinSidebar';

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
];

export function pickSpecializedSidebar(componentType: string | undefined | null): Sidebar | null {
  if (!componentType) return null;
  for (const { test, Sidebar } of MATCHERS) {
    if (test(componentType)) return Sidebar;
  }
  return null;
}
