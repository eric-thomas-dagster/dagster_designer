import { JoinSidebar } from './JoinSidebar';
import { FilterSidebar } from './FilterSidebar';
import { AggregateSidebar } from './AggregateSidebar';
import { SqlTransformSidebar } from './SqlTransformSidebar';
import { GeoBoundingBoxSidebar } from './GeoBoundingBoxSidebar';
import { LLMSidebar } from './LLMSidebar';
import { AgentSidebar } from './AgentSidebar';
import { DocumentExtractorSidebar } from './DocumentExtractorSidebar';

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
  /** Full component_type passed through so provider-aware sidebars
   *  (e.g. LLMSidebar picking Anthropic vs OpenAI vs Gemini) can
   *  adapt without a separate registration entry per provider. */
  componentType?: string;
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
    // Per-row LLM enrichment — anthropic_llm, openai_llm, gemini_llm,
    // groq_llm, huggingface_chat_completion. All share the same shape
    // (model + system + user_prompt_template + input/output columns +
    // sampling knobs) so one sidebar covers them. The sidebar itself
    // detects which provider based on component_type and swaps the
    // model list + docs link accordingly.
    test: (t) => {
      const id = /(?:^|\.)([a-z_]+_llm|[a-z_]*chat_completion)(?:$|\.)/i.test(t);
      const cls = /\.(?:Anthropic|Openai|OpenAI|Gemini|Groq|Huggingface|HuggingFace)?(?:LLM|ChatCompletion)Component$/i.test(t);
      return id || cls;
    },
    Sidebar: LLMSidebar,
  },
  {
    // MCP-tool LLM agents — anthropic_agent, gemini_agent, openai_agent
    // etc. Shape = LLM + task + system + max_iterations + mcp_servers.
    // catalog_agent uses a different shape (planner/executor) so it
    // stays on the generic form for now.
    test: (t) => {
      if (/catalog_agent/i.test(t)) return false;
      const id = /(?:^|\.)(?:[a-z_]+_)?agent(?:$|\.)/i.test(t);
      const cls = /\.(?:Anthropic|Openai|OpenAI|Gemini|Groq)AgentComponent$/i.test(t);
      return id || cls;
    },
    Sidebar: AgentSidebar,
  },
  {
    // LLM-powered document extractors + summarizers. Cover the common
    // shape (input_column + LLM + output_fields[]) across five+
    // templates. Each preset seeds sensible fields.
    test: (t) => {
      const id = /(?:^|\.)(?:contract_extractor|bank_statement_extractor|expense_report_extractor|document_summarizer|entity_extractor|gong_call_summary_asset)(?:$|\.)/i.test(t);
      const cls = /\.(?:Contract|BankStatement|ExpenseReport|Document|Entity)?(?:Extractor|Summarizer|Summary)Component$/i.test(t);
      return id || cls;
    },
    Sidebar: DocumentExtractorSidebar,
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
