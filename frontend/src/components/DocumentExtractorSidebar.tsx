import { useEffect, useMemo, useState } from 'react';
import { FileText, Plus, X, Sparkles } from 'lucide-react';
import { assetsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

interface DocumentExtractorSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
  componentType?: string;
}

/**
 * Specialized sidebar for LLM-powered document extraction components.
 * Covers everything shaped like:
 *   input_column (text | file path | url) → LLM → structured fields
 *
 *   * contract_extractor / bank_statement_extractor /
 *     expense_report_extractor / gong_call_summary_asset — all share
 *     the same input_column / input_type / output_fields shape
 *   * document_summarizer — summary_type + max_length (different)
 *   * entity_extractor — entity_types + method (different)
 *
 * We ship a domain preset per template + a generic "custom" mode
 * where users type their own field names. Every template writes back
 * to the same `output_fields` array (list of column names).
 */

interface Preset {
  id: string;
  label: string;
  emoji: string;
  matches: (componentType: string) => boolean;
  fields: string[];
  hint: string;
}

const PRESETS: Preset[] = [
  {
    id: 'contract',
    label: 'Contract',
    emoji: '📄',
    matches: (t) => /contract/i.test(t),
    fields: ['contract_type', 'parties', 'effective_date', 'expiration_date', 'governing_law', 'payment_terms', 'termination_clause', 'liability_cap'],
    hint: 'Legal contract data — parties, dates, key clauses.',
  },
  {
    id: 'bank_statement',
    label: 'Bank statement',
    emoji: '🏦',
    matches: (t) => /bank_statement|statement/i.test(t),
    fields: ['account_number', 'account_holder', 'statement_period', 'opening_balance', 'closing_balance', 'total_deposits', 'total_withdrawals', 'transactions'],
    hint: 'Bank statements → balances + transaction summary.',
  },
  {
    id: 'expense_report',
    label: 'Expense report',
    emoji: '🧾',
    matches: (t) => /expense/i.test(t),
    fields: ['employee_name', 'submitted_date', 'total_amount', 'currency', 'business_purpose', 'line_items'],
    hint: 'Expense reports — who, when, how much, what for.',
  },
  {
    id: 'summary',
    label: 'Summary',
    emoji: '📝',
    matches: (t) => /summariz|summary/i.test(t),
    fields: ['summary', 'key_points', 'action_items'],
    hint: 'Concise summary + bullet points + action items.',
  },
  {
    id: 'entities',
    label: 'Named entities',
    emoji: '🏷️',
    matches: (t) => /entity|entities/i.test(t),
    fields: ['people', 'organizations', 'locations', 'dates', 'monetary_values'],
    hint: 'Extract named entities from unstructured text.',
  },
];

function detectPreset(componentType: string): Preset | null {
  return PRESETS.find((p) => p.matches(componentType)) ?? null;
}

export function DocumentExtractorSidebar({
  attributes,
  onChange,
  onOpenAdvanced,
  componentType,
}: DocumentExtractorSidebarProps) {
  const preset = useMemo(() => detectPreset(componentType || ''), [componentType]);
  const { currentProject } = useProjectStore();

  const [schemas, setSchemas] = useState<Record<string, { columns: string[]; dtypes: Record<string, string> }>>({});
  const [previewRows, setPreviewRows] = useState<Array<Record<string, any>>>([]);

  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    assetsApi.knownSchemas(currentProject.id).then((s) => {
      if (!cancelled) setSchemas(s || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  const upstreamKey = (attributes.upstream_asset_key as string) || '';
  const columns = schemas[upstreamKey]?.columns ?? [];

  useEffect(() => {
    if (!currentProject || !upstreamKey) return;
    let cancelled = false;
    assetsApi.previewData(currentProject.id, upstreamKey, { sampleLimit: 20 }).then((r) => {
      if (!cancelled && r?.success && r?.data) setPreviewRows(r.data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id, upstreamKey]);

  const inputColumn = (attributes.input_column as string) ?? '';
  const inputType = (attributes.input_type as string) ?? 'text';
  const model = (attributes.model as string) ?? '';
  const apiKeyEnvVar = (attributes.api_key_env_var as string) ?? (attributes.api_key as string) ?? '';
  const outputFields: string[] = Array.isArray(attributes.output_fields)
    ? attributes.output_fields
    : [];
  const batchSize = numeric(attributes.batch_size, 5);

  // Preview snippet — first row of the input column, truncated.
  const sampleInput = previewRows[0]?.[inputColumn];
  const sampleInputPreview = typeof sampleInput === 'string'
    ? sampleInput.slice(0, 400) + (sampleInput.length > 400 ? '…' : '')
    : sampleInput != null
      ? String(sampleInput)
      : '';

  const addField = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (outputFields.includes(trimmed)) return;
    onChange('output_fields', [...outputFields, trimmed]);
  };
  const removeField = (i: number) =>
    onChange('output_fields', outputFields.filter((_, idx) => idx !== i));
  const applyPreset = () => {
    if (!preset) return;
    onChange('output_fields', preset.fields);
  };

  const [newField, setNewField] = useState('');

  const missingSelectedInputCol = inputColumn && columns.length > 0 && !columns.includes(inputColumn);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-primary" />
          {preset ? `${preset.emoji} ${preset.label} extractor` : 'Document extractor'}
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {preset?.hint ?? 'Send each document through the LLM and land structured fields as new columns.'}
        </p>
      </div>

      {/* Input column + input type */}
      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Input column</label>
          {columns.length > 0 ? (
            <select
              value={inputColumn}
              onChange={(e) => onChange('input_column', e.target.value)}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">— pick column —</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input
              value={inputColumn}
              onChange={(e) => onChange('input_column', e.target.value)}
              placeholder="text"
              className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          {missingSelectedInputCol && (
            <p className="text-[10px] text-rose-700 mt-0.5">
              Column not in upstream — check spelling.
            </p>
          )}
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Input type</label>
          <select
            value={inputType}
            onChange={(e) => onChange('input_type', e.target.value)}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value="text">text (already extracted)</option>
            <option value="file">file (path to PDF / image)</option>
            <option value="url">url</option>
          </select>
        </div>
      </section>

      {/* Model + credentials */}
      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Model</label>
          <input
            value={model}
            onChange={(e) => onChange('model', e.target.value)}
            list="doc-extractor-models"
            placeholder="gpt-4o-mini"
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <datalist id="doc-extractor-models">
            <option value="gpt-4o-mini" />
            <option value="gpt-4o" />
            <option value="claude-3-5-sonnet-20241022" />
            <option value="claude-3-5-haiku-20241022" />
            <option value="gemini-2.5-flash" />
          </datalist>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">API key env var</label>
          <input
            value={apiKeyEnvVar}
            onChange={(e) => {
              // Different templates use `api_key_env_var` vs `api_key` — keep
              // writing to whichever key already exists on this instance.
              const key = 'api_key' in attributes && !('api_key_env_var' in attributes) ? 'api_key' : 'api_key_env_var';
              onChange(key, e.target.value);
            }}
            placeholder="OPENAI_API_KEY"
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </section>

      {/* Fields to extract — the meat of the config */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Fields to extract</label>
          {preset && outputFields.length === 0 && (
            <button
              type="button"
              onClick={applyPreset}
              className="text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 text-primary hover:bg-primary/5 rounded"
            >
              <Sparkles className="w-3 h-3" />
              Use {preset.label.toLowerCase()} preset
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1 mb-2">
          {outputFields.map((f, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-primary/10 border border-primary/30 rounded text-primary font-mono"
            >
              {f}
              <button
                type="button"
                onClick={() => removeField(i)}
                className="hover:text-primary/70"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
          {outputFields.length === 0 && (
            <span className="text-[11px] text-gray-500 italic">No fields yet — the model won't know what to extract.</span>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            addField(newField);
            setNewField('');
          }}
          className="flex items-center gap-1"
        >
          <input
            value={newField}
            onChange={(e) => setNewField(e.target.value)}
            placeholder="field name (e.g. invoice_number)"
            className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={!newField.trim()}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/5 rounded disabled:opacity-40"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </form>

        {preset && outputFields.length > 0 && !arraysEqual(outputFields, preset.fields) && (
          <button
            type="button"
            onClick={applyPreset}
            className="mt-1 text-[10px] text-gray-500 hover:text-gray-700"
          >
            Reset to {preset.label.toLowerCase()} preset defaults ({preset.fields.length} fields)
          </button>
        )}
      </section>

      {/* Sample input preview — makes the "what will the model see"
          question tangible. Shows the first row's input_column value. */}
      {inputColumn && sampleInputPreview && (
        <section className="border border-gray-200 rounded-md bg-gray-50 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-gray-200 bg-white">
            <span className="text-[11px] font-semibold text-gray-700 uppercase tracking-wider">
              Sample input (row 1)
            </span>
          </div>
          <pre className="p-3 text-[11px] font-mono text-gray-700 whitespace-pre-wrap max-h-40 overflow-y-auto">
            {sampleInputPreview}
          </pre>
          <div className="px-3 py-1.5 border-t border-gray-100 bg-gray-100 text-[10px] text-gray-600">
            The model will read this and return {outputFields.length} field{outputFields.length === 1 ? '' : 's'}:{' '}
            <span className="font-mono">
              {outputFields.slice(0, 5).join(', ')}
              {outputFields.length > 5 && ` +${outputFields.length - 5}`}
            </span>
          </div>
        </section>
      )}

      {/* Batch size — perf knob */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-gray-700 mb-0.5">
          <span>Batch size</span>
          <input
            type="number"
            min={1}
            max={100}
            value={batchSize}
            onChange={(e) => onChange('batch_size', Number(e.target.value))}
            className="w-16 px-1.5 py-0.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <input
          type="range"
          min={1}
          max={20}
          value={batchSize}
          onChange={(e) => onChange('batch_size', Number(e.target.value))}
          className="w-full accent-primary"
        />
        <p className="text-[10px] text-gray-400 mt-0.5">
          Rows processed in parallel. Higher = faster + more concurrent API load.
        </p>
      </div>

      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (partition, freshness, tags, retry, custom prompts, …)
        </button>
      )}
    </div>
  );
}

function numeric(v: any, fallback: number): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
