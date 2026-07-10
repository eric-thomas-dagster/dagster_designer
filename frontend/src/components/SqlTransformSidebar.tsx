import Editor from '@monaco-editor/react';
import { Terminal, Sparkles } from 'lucide-react';

interface SqlTransformSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
}

// Common if-exists modes across all warehouse-writing components. The
// community sql_transform ships with these; if a fork uses others,
// they'll still land in the raw value since it's a select-with-write.
const IF_EXISTS_OPTIONS = ['fail', 'replace', 'append'] as const;

/**
 * Specialized sidebar for SQL transformation components:
 *  * community `sql_transform` (warehouse CTAS via SQLAlchemy)
 *  * built-in `SqlTransformerComponent` (visual-builder SQL)
 *
 * Focus on the four fields that dominate the config: the SQL query,
 * the destination table, upstream asset keys (for the DAG), and the
 * if_exists mode. Everything else (partitions, freshness, retry) goes
 * through the Advanced modal.
 */
export function SqlTransformSidebar({ attributes, onChange, onOpenAdvanced }: SqlTransformSidebarProps) {
  const sql = (attributes.sql as string) ?? '';
  const destinationTable = (attributes.destination_table as string) ?? '';
  const ifExists = (attributes.if_exists as string) ?? 'fail';
  const upstreamKeys = (attributes.upstream_asset_keys as string) ?? '';
  const returnDataframe = !!attributes.return_dataframe;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Terminal className="w-4 h-4 text-primary" /> SQL Transform
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Run a SELECT against the warehouse and materialize the result as a table.
        </p>
      </div>

      {/* SQL editor — monaco with sql syntax. Big affordance because
          it's the field users spend the most time in. */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">SQL query</label>
          <span className="text-[10px] text-gray-400">
            Supports {'{{ var }}'} template vars — configure in Advanced
          </span>
        </div>
        <div className="border border-gray-200 rounded overflow-hidden">
          <Editor
            height="220px"
            defaultLanguage="sql"
            value={sql}
            onChange={(v) => onChange('sql', v ?? '')}
            theme="vs-light"
            options={{
              minimap: { enabled: false },
              lineNumbers: 'on',
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              tabSize: 2,
              renderLineHighlight: 'line',
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>
        <div className="mt-1 flex items-start gap-1 text-[11px] text-gray-500">
          <Sparkles className="w-3 h-3 text-gray-400 mt-0.5 flex-shrink-0" />
          <span>
            Reference upstream tables directly by name. Use <code className="bg-gray-100 px-1 rounded">{'{{ my_var }}'}</code> for
            template values (define under Advanced → template_vars).
          </span>
        </div>
      </section>

      {/* Destination & write mode. */}
      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
            Destination table
          </label>
          <input
            type="text"
            value={destinationTable}
            onChange={(e) => onChange('destination_table', e.target.value)}
            placeholder="schema.table_name"
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-[10px] text-gray-500 mt-0.5">Fully-qualified table the SELECT writes into.</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
            If table exists
          </label>
          <select
            value={ifExists}
            onChange={(e) => onChange('if_exists', e.target.value)}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            {IF_EXISTS_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <p className="text-[10px] text-gray-500 mt-0.5">
            {ifExists === 'fail' ? 'Error out if the target already exists.'
              : ifExists === 'replace' ? 'Drop and recreate the target.'
              : 'Insert new rows into the existing target.'}
          </p>
        </div>
      </section>

      {/* Upstream keys — declares graph deps so Dagster knows what to
          materialize first. Kept as a simple text since SQL isn't Python
          and we can't infer these from the query. */}
      <section>
        <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
          Upstream asset keys
        </label>
        <input
          type="text"
          value={upstreamKeys}
          onChange={(e) => onChange('upstream_asset_keys', e.target.value)}
          placeholder="orders, customers  (comma-separated)"
          className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-[10px] text-gray-500 mt-0.5">
          Which existing assets does this SELECT read from? Establishes the dependency edge in the graph.
        </p>
      </section>

      {/* Return dataframe toggle — controls whether the asset function
          returns the results as a DataFrame (memory) in addition to writing. */}
      <label className="flex items-start gap-2 cursor-pointer text-xs text-gray-700">
        <input
          type="checkbox"
          checked={returnDataframe}
          onChange={(e) => onChange('return_dataframe', e.target.checked)}
          className="w-3.5 h-3.5 mt-0.5"
        />
        <div>
          <div>Also return the result as a DataFrame</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            Enable when downstream Python transforms need the data in-process. Off is fine for pure warehouse pipelines.
          </div>
        </div>
      </label>

      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (template_vars, connection URL, retry, partition, freshness, …)
        </button>
      )}
    </div>
  );
}
