import { useEffect, useState } from 'react';
import { Database, ChevronDown, Sparkles } from 'lucide-react';

interface DbtProjectSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
}

// Compact label + tooltip (via title=) rather than the generic form's
// full paragraph descriptions -- this sidebar's whole point is fitting
// a dbt project's genuinely useful day-to-day fields (plus the opt-in
// enrichments a real dbt project usually wants at least one of) into a
// glanceable panel instead of the ~39-field flat list the schema-driven
// generic form renders (project/select/exclude/cli_args and every
// enrichment toggle EnrichedDbtProjectComponent adds, alongside dbt
// Cloud/slim-CI fields that don't apply to a plain Core project at
// all). Everything not shown here is still reachable via "Advanced".
const ENRICHMENT_TOGGLES: Array<{ key: string; label: string; hint: string }> = [
  { key: 'derive_freshness_policies', label: 'Freshness policies', hint: "Auto-attach a real FreshnessPolicy to sources (sources.freshness) and models with dbt 1.9+ config.freshness.build_after." },
  { key: 'emit_contract_checks', label: 'Contract checks', hint: 'For models with config.contract.enforced=true, emit per-column AssetCheckSpecs so contract violations show as failing checks.' },
  { key: 'emit_exposures_as_assets', label: 'Exposures as assets', hint: 'Emit each dbt exposure as an observable AssetSpec with real deps on its upstream models -- downstream lineage for "if this breaks, what dashboards are affected?"' },
  { key: 'emit_source_assets', label: 'Sources as assets', hint: 'Emit each dbt source as a first-class observable asset node instead of only an upstream dep of models.' },
  { key: 'emit_semantic_layer_as_assets', label: 'Semantic layer as assets', hint: 'Emit dbt semantic_models + metrics as observable AssetSpecs.' },
  { key: 'enable_materialization_kinds', label: 'Materialization kinds', hint: "Add each model's dbt materialized value (table/view/incremental/...) as a Dagster kind for distinct icons." },
  { key: 'include_doc_blocks', label: 'Doc blocks', hint: 'Resolve {{ doc() }} references and embed the block contents as metadata.' },
  { key: 'include_meta', label: 'Full meta', hint: 'Attach the full node.meta dict (minus the dagster subkey) as JSON metadata.' },
  { key: 'include_metrics', label: 'Metrics (metadata)', hint: 'Attach dbt metric definitions as JSON metadata on each referenced model.' },
  { key: 'include_semantic_models', label: 'Semantic models (metadata)', hint: 'Attach dbt semantic-model definitions as JSON metadata on each referenced model.' },
  { key: 'include_source_freshness', label: 'Source freshness (metadata)', hint: 'Attach source freshness thresholds + loaded_at_field + loader as metadata.' },
  { key: 'include_contracts', label: 'Contracts (metadata)', hint: 'Attach contract-enforced flag + column constraints as metadata.' },
  { key: 'include_exposures', label: 'Exposures (metadata)', hint: 'Attach downstream-exposure list as JSON metadata on each model asset.' },
];

export function DbtProjectSidebar({ attributes, onChange, onOpenAdvanced }: DbtProjectSidebarProps) {
  const [enrichmentsOpen, setEnrichmentsOpen] = useState(false);
  const project = (attributes.project as string) ?? '';
  const select = (attributes.select as string) ?? '';
  const exclude = (attributes.exclude as string) ?? '';
  // cli_args is a list[str | dict] -- the common case is a flat list of
  // plain strings ("build", "run", "--select", ...), edited here as a
  // simple comma-separated string like SqlTransformSidebar's
  // upstream_asset_keys. A dict entry (the rarer templated-arg shape)
  // falls back to the Advanced modal rather than this text input.
  const cliArgsIsSimple = !Array.isArray(attributes.cli_args) || attributes.cli_args.every((a: any) => typeof a === 'string');
  const [cliArgsText, setCliArgsText] = useState(() =>
    Array.isArray(attributes.cli_args) ? attributes.cli_args.join(', ') : '',
  );
  // PropertyPanel doesn't remount this sidebar when the user selects a
  // different dbt-project node in sequence (same Sidebar component,
  // new attributes prop) -- re-sync local text state when the incoming
  // cli_args actually changes. Compares PARSED arrays, not raw strings
  // -- same reasoning as SqlTransformSidebar's upstreamKeysText: a
  // trailing ", " while typing a second arg parses to the same array as
  // before it, so comparing raw strings would immediately strip it.
  useEffect(() => {
    const incoming = Array.isArray(attributes.cli_args) ? attributes.cli_args : [];
    const current = cliArgsText.split(',').map((s) => s.trim()).filter(Boolean);
    if (JSON.stringify(incoming) !== JSON.stringify(current)) {
      setCliArgsText(incoming.join(', '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attributes.cli_args]);
  const dbtDocsUrl = (attributes.dbt_docs_url as string) ?? '';

  const enabledEnrichmentCount = ENRICHMENT_TOGGLES.filter((t) => !!attributes[t.key]).length;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Database className="w-4 h-4 text-primary" /> dbt Project
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Points at a real dbt project and runs it as Dagster assets.
        </p>
      </div>

      <section>
        <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
          Project path
        </label>
        <input
          type="text"
          value={project}
          onChange={(e) => onChange('project', e.target.value)}
          placeholder="{{ project_root }}/path/to/dbt_project"
          className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="mt-1 text-[10px] text-gray-500">
          Use <code className="bg-gray-100 px-1 rounded">{'{{ project_root }}'}</code> for a path relative to the Dagster project root.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
            Select
          </label>
          <input
            type="text"
            value={select}
            onChange={(e) => onChange('select', e.target.value)}
            placeholder="tag:daily"
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
            Exclude
          </label>
          <input
            type="text"
            value={exclude}
            onChange={(e) => onChange('exclude', e.target.value)}
            placeholder="package:shared_core"
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </section>

      <section>
        <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
          CLI args
        </label>
        {cliArgsIsSimple ? (
          <input
            type="text"
            value={cliArgsText}
            onChange={(e) => {
              setCliArgsText(e.target.value);
              onChange(
                'cli_args',
                e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              );
            }}
            placeholder="build  (comma-separated, defaults to build)"
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <p className="text-[11px] text-gray-500 italic">
            Templated CLI args in use -- edit via Advanced.
          </p>
        )}
      </section>

      <section className="border border-gray-200 rounded-md">
        <button
          type="button"
          onClick={() => setEnrichmentsOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 rounded-md"
        >
          <Sparkles className="w-3.5 h-3.5 text-gray-400" />
          Enrichments
          {enabledEnrichmentCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-medium">
              {enabledEnrichmentCount} on
            </span>
          )}
          <ChevronDown className={`w-3 h-3 opacity-60 ml-auto transition-transform ${enrichmentsOpen ? 'rotate-180' : ''}`} />
        </button>
        {enrichmentsOpen && (
          <div className="px-3 pb-3 pt-1 space-y-3">
            <p className="text-[10px] text-gray-500">
              All opt-in -- defaults preserve plain dbt behavior. Hover a label for what it does.
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {ENRICHMENT_TOGGLES.map(({ key, label, hint }) => (
                <label key={key} className="flex items-center gap-1.5 text-[11px] text-gray-700 cursor-pointer" title={hint}>
                  <input
                    type="checkbox"
                    checked={!!attributes[key]}
                    onChange={(e) => onChange(key, e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  {label}
                </label>
              ))}
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-600 uppercase tracking-wider mb-1">
                dbt Docs URL
              </label>
              <input
                type="text"
                value={dbtDocsUrl}
                onChange={(e) => onChange('dbt_docs_url', e.target.value)}
                placeholder="https://dbt-docs.internal.mycompany.com"
                className="w-full px-2 py-1 text-[11px] font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        )}
      </section>

      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (translation, dbt Cloud mode, slim CI/defer, asset_overrides, manifest_path, …)
        </button>
      )}
    </div>
  );
}
