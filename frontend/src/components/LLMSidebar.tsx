import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Sparkles, Zap, Eye } from 'lucide-react';
import { assetsApi } from '@/services/api';
import { useProjectStore } from '@/hooks/useProject';

interface LLMSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
  /** component_type from the graph node — used to pick model presets
   *  and title. Same key that ended up in defs.yaml. */
  componentType?: string;
}

/**
 * Specialized sidebar for LLM-invoking components (anthropic_llm,
 * openai_llm, gemini_llm, groq_llm, huggingface_chat_completion,
 * etc). All share the same shape: pick a model, write a system prompt
 * + a user-prompt template with {column} placeholders, choose the
 * input/output columns, tune sampling knobs.
 *
 * The wow moment: a live "Rendered prompt" panel that takes the first
 * row of the upstream and substitutes into the template, so users see
 * EXACTLY what will be sent to the model before they run anything.
 */

interface Provider {
  id: string;
  label: string;
  models: string[];
  match: (componentType: string) => boolean;
  docsUrl?: string;
}

const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-5-20250929',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ],
    match: (t) => /anthropic|claude/i.test(t),
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      'gpt-5', 'gpt-5-mini',
      'gpt-4o', 'gpt-4o-mini',
      'gpt-4-turbo',
      'o3-mini',
    ],
    match: (t) => /openai|gpt-|gpt_/i.test(t),
    docsUrl: 'https://platform.openai.com/docs/models',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
    ],
    match: (t) => /gemini|google/i.test(t),
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
  },
  {
    id: 'groq',
    label: 'Groq',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'deepseek-r1-distill-llama-70b',
    ],
    match: (t) => /groq/i.test(t),
    docsUrl: 'https://console.groq.com/docs/models',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'mistralai/Mistral-Nemo-Instruct-2407',
    ],
    match: (t) => /huggingface|hf_/i.test(t),
    docsUrl: 'https://huggingface.co/models?pipeline_tag=text-generation',
  },
];

function detectProvider(componentType: string): Provider {
  return PROVIDERS.find((p) => p.match(componentType)) ?? PROVIDERS[0];
}

export function LLMSidebar({ attributes, onChange, onOpenAdvanced, componentType }: LLMSidebarProps) {
  const provider = useMemo(() => detectProvider(componentType || ''), [componentType]);
  const { currentProject } = useProjectStore();

  const [previewRows, setPreviewRows] = useState<Array<Record<string, any>>>([]);
  const [schemas, setSchemas] = useState<Record<string, { columns: string[]; dtypes: Record<string, string> }>>({});

  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;
    assetsApi.knownSchemas(currentProject.id).then((s) => {
      if (!cancelled) setSchemas(s || {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id]);

  const upstreamKey = (attributes.upstream_asset_key as string)
    || (attributes.upstream_asset_keys as string)?.split(',')[0]?.trim()
    || '';
  const columns = schemas[upstreamKey]?.columns ?? [];

  // Preview upstream so the "rendered prompt" panel has a real row to
  // substitute into. Only fetch when the upstream is known.
  useEffect(() => {
    if (!currentProject || !upstreamKey) return;
    let cancelled = false;
    assetsApi.previewData(currentProject.id, upstreamKey, { sampleLimit: 50 }).then((r) => {
      if (!cancelled && r?.success && r?.data) setPreviewRows(r.data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentProject?.id, upstreamKey]);

  const [previewRowIdx, setPreviewRowIdx] = useState(0);
  const sampleRow = previewRows[previewRowIdx] ?? {};

  const model = (attributes.model as string) ?? '';
  const systemPrompt = (attributes.system_prompt as string) ?? '';
  const userPromptTemplate = (attributes.user_prompt_template as string) ?? '';
  const inputColumn = (attributes.input_column as string) ?? '';
  const outputColumn = (attributes.output_column as string) ?? '';
  const temperature = numeric(attributes.temperature, 0.7);
  const maxTokens = numeric(attributes.max_tokens, 1024);
  const topP = numeric(attributes.top_p, 1.0);
  const stream = !!attributes.stream;

  // Which columns does the user prompt reference?
  const referencedCols = useMemo(() => {
    const set = new Set<string>();
    for (const m of userPromptTemplate.matchAll(/\{([^{}]+)\}/g)) {
      set.add(m[1].trim());
    }
    return Array.from(set);
  }, [userPromptTemplate]);

  const missingCols = useMemo(() => {
    if (columns.length === 0) return [];
    return referencedCols.filter((c) => !columns.includes(c));
  }, [referencedCols, columns]);

  const renderedPrompt = useMemo(() => {
    let out = userPromptTemplate;
    for (const [k, v] of Object.entries(sampleRow)) {
      const val = v === null || v === undefined ? '' : String(v);
      out = out.split(`{${k}}`).join(val);
    }
    return out;
  }, [userPromptTemplate, sampleRow]);

  const ApiKeyField = () => (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">API key</label>
      <input
        type="text"
        value={(attributes.api_key as string) ?? ''}
        onChange={(e) => onChange('api_key', e.target.value)}
        placeholder={'${' + provider.id.toUpperCase() + '_API_KEY}'}
        className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <p className="text-[10px] text-gray-500 mt-0.5">
        Use <code className="bg-gray-100 px-1 rounded">${'{'}...{'}'}</code> to reference an env var — never hardcode a key here.
      </p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" />
          {provider.label} — LLM enrichment
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Send each row of the upstream data through {provider.label}, land the response as a new column.
        </p>
      </div>

      {/* Model picker */}
      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Model</label>
          <input
            list={`models-${provider.id}`}
            value={model}
            onChange={(e) => onChange('model', e.target.value)}
            placeholder={provider.models[0]}
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <datalist id={`models-${provider.id}`}>
            {provider.models.map((m) => <option key={m} value={m} />)}
          </datalist>
          {provider.docsUrl && (
            <a
              href={provider.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-blue-600 hover:underline mt-0.5 inline-block"
            >
              browse {provider.label} models ↗
            </a>
          )}
        </div>
        <ApiKeyField />
      </section>

      {/* Prompts — the meat of the config */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">System prompt</label>
          <span className="text-[10px] text-gray-400">sets context & behavior</span>
        </div>
        <div className="border border-gray-200 rounded overflow-hidden">
          <Editor
            height="90px"
            defaultLanguage="markdown"
            value={systemPrompt}
            onChange={(v) => onChange('system_prompt', v ?? '')}
            theme="vs-light"
            options={{
              minimap: { enabled: false },
              lineNumbers: 'off',
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 6, bottom: 6 },
            }}
          />
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
            User prompt template
          </label>
          <span className="text-[10px] text-gray-400">use {'{'}column_name{'}'} placeholders</span>
        </div>
        <div className="border border-gray-200 rounded overflow-hidden">
          <Editor
            height="140px"
            defaultLanguage="markdown"
            value={userPromptTemplate}
            onChange={(v) => onChange('user_prompt_template', v ?? '')}
            theme="vs-light"
            options={{
              minimap: { enabled: false },
              lineNumbers: 'off',
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 6, bottom: 6 },
            }}
          />
        </div>
        {/* Column-reference summary */}
        {referencedCols.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
            {referencedCols.map((c) => {
              const isMissing = columns.length > 0 && !columns.includes(c);
              return (
                <span
                  key={c}
                  className={`px-1.5 py-0.5 rounded font-mono border ${
                    isMissing
                      ? 'bg-rose-50 border-rose-200 text-rose-700'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  }`}
                  title={isMissing ? 'This column is NOT in the upstream — will render as blank at runtime' : 'Found in upstream'}
                >
                  {isMissing ? '⚠' : '✓'} {'{'}
                  {c}
                  {'}'}
                </span>
              );
            })}
          </div>
        )}
        {missingCols.length > 0 && (
          <p className="mt-1 text-[10px] text-rose-700">
            {missingCols.length} placeholder{missingCols.length === 1 ? '' : 's'} reference columns not in the upstream — will render as blank at runtime.
          </p>
        )}
      </section>

      {/* Column pickers */}
      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Input column</label>
          {columns.length > 0 ? (
            <select
              value={inputColumn}
              onChange={(e) => onChange('input_column', e.target.value)}
              className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">— pick column —</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input
              value={inputColumn}
              onChange={(e) => onChange('input_column', e.target.value)}
              placeholder="input_text"
              className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Output column</label>
          <input
            value={outputColumn}
            onChange={(e) => onChange('output_column', e.target.value)}
            placeholder="response"
            className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </section>

      {/* Sampling knobs */}
      <section>
        <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2 block">Sampling</label>
        <div className="space-y-2">
          <SliderRow label="Temperature" value={temperature} min={0} max={2} step={0.05} hint="0 = deterministic; higher = more creative" onChange={(v) => onChange('temperature', v)} />
          <SliderRow label="Top P" value={topP} min={0} max={1} step={0.05} hint="Nucleus sampling" onChange={(v) => onChange('top_p', v)} />
          <div>
            <div className="flex items-center justify-between text-[11px] text-gray-700">
              <span>Max tokens</span>
              <input
                type="number"
                min={1}
                value={maxTokens}
                onChange={(e) => onChange('max_tokens', Number(e.target.value))}
                className="w-20 px-1.5 py-0.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={stream}
              onChange={(e) => onChange('stream', e.target.checked)}
              className="w-3.5 h-3.5"
            />
            Stream tokens as they arrive
          </label>
        </div>
      </section>

      {/* Rendered prompt preview — the wow moment. Substitutes the
          template against a real row from the upstream. */}
      {(systemPrompt || userPromptTemplate) && (
        <section className="border border-gray-200 rounded-md bg-gray-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-200 bg-white flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-primary" />
              Rendered prompt preview
            </span>
            {previewRows.length > 1 && (
              <div className="flex items-center gap-1 text-[11px] text-gray-500">
                <span>row</span>
                <button
                  type="button"
                  onClick={() => setPreviewRowIdx((i) => Math.max(0, i - 1))}
                  className="px-1.5 py-0.5 border border-gray-200 rounded hover:bg-gray-100"
                >
                  ‹
                </button>
                <span className="tabular-nums font-mono">
                  {previewRowIdx + 1}/{previewRows.length}
                </span>
                <button
                  type="button"
                  onClick={() => setPreviewRowIdx((i) => Math.min(previewRows.length - 1, i + 1))}
                  className="px-1.5 py-0.5 border border-gray-200 rounded hover:bg-gray-100"
                >
                  ›
                </button>
              </div>
            )}
          </div>
          <div className="p-3 space-y-2 text-xs">
            {systemPrompt && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">system</div>
                <pre className="whitespace-pre-wrap font-mono text-gray-700 bg-white border border-gray-200 rounded p-2 max-h-24 overflow-y-auto">
                  {systemPrompt}
                </pre>
              </div>
            )}
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">
                user{previewRows.length === 0 ? ' (template — preview upstream to substitute)' : ' — row substituted'}
              </div>
              <pre className="whitespace-pre-wrap font-mono text-gray-900 bg-white border border-gray-200 rounded p-2 max-h-40 overflow-y-auto">
                {previewRows.length > 0 ? renderedPrompt : userPromptTemplate || <span className="text-gray-400 italic">(no template yet)</span>}
              </pre>
            </div>
          </div>
        </section>
      )}
      {upstreamKey && previewRows.length === 0 && (
        <div className="p-2 rounded-md bg-amber-50 border border-amber-200 text-[11px] text-amber-800 flex items-start gap-1.5">
          <Zap className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>
            Preview <span className="font-mono">{upstreamKey}</span> once to see the prompt substituted with a real row.
          </span>
        </div>
      )}

      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (tools, caching, rate limits, retries, batch size, …)
        </button>
      )}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-gray-700">
        <span>{label}</span>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-16 px-1.5 py-0.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
      {hint && <p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function numeric(v: any, fallback: number): number {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}
