import { useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { Bot, Plus, X, Server, Sparkles } from 'lucide-react';

interface AgentSidebarProps {
  attributes: Record<string, any>;
  onChange: (name: string, next: any) => void;
  onOpenAdvanced?: () => void;
  componentType?: string;
}

/**
 * Specialized sidebar for MCP-tool-using LLM agents:
 *  * anthropic_agent
 *  * gemini_agent
 *  * (future: openai_agent, groq_agent)
 *
 * Shape is LLM + tool loop: task prompt, system prompt, model, tool
 * budget (max_iterations), and an MCP server list — each entry a
 * {name, url, auth_env_var} triple. The agent picks tools from these
 * MCP servers at each iteration until it decides the task is done.
 */

interface Provider {
  id: string;
  label: string;
  models: string[];
  match: (t: string) => boolean;
  hasThinkingBudget?: boolean;
}
const PROVIDERS: Provider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022'],
    match: (t) => /anthropic|claude/i.test(t),
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    match: (t) => /gemini|google/i.test(t),
    hasThinkingBudget: true,
  },
];
function detectProvider(t: string): Provider {
  return PROVIDERS.find((p) => p.match(t)) ?? PROVIDERS[0];
}

interface McpServer {
  name?: string;
  url?: string;
  auth_env_var?: string;
  transport?: string;
}

// Best-effort normalization — the schema declares mcp_servers as array
// but individual configs across templates use slightly different key
// names. Keep any extra keys under `extras` so we round-trip cleanly.
function normalizeServers(v: any): McpServer[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => (s && typeof s === 'object' ? { ...s } : {}));
}

// Well-known MCP servers users commonly wire up. Presets speed up demos.
const PRESETS: { label: string; server: McpServer }[] = [
  { label: 'GitHub', server: { name: 'github', url: 'https://api.githubcopilot.com/mcp/', auth_env_var: 'GITHUB_TOKEN' } },
  { label: 'Slack', server: { name: 'slack', url: 'https://slack.com/mcp', auth_env_var: 'SLACK_BOT_TOKEN' } },
  { label: 'Filesystem', server: { name: 'fs', url: 'stdio://mcp-server-filesystem', transport: 'stdio' } },
  { label: 'Postgres', server: { name: 'postgres', url: 'stdio://mcp-server-postgres', transport: 'stdio', auth_env_var: 'DATABASE_URL' } },
  { label: 'Sentry', server: { name: 'sentry', url: 'https://sentry.io/api/0/mcp/', auth_env_var: 'SENTRY_AUTH_TOKEN' } },
];

export function AgentSidebar({ attributes, onChange, onOpenAdvanced, componentType }: AgentSidebarProps) {
  const provider = useMemo(() => detectProvider(componentType || ''), [componentType]);

  const model = (attributes.model as string) ?? '';
  const prompt = (attributes.prompt as string) ?? '';
  const systemPrompt = (attributes.system_prompt as string) ?? '';
  const apiKeyEnvVar = (attributes.api_key_env_var as string) ?? '';
  const temperature = numeric(attributes.temperature, 1.0);
  const maxTokens = numeric(attributes.max_tokens ?? attributes.max_output_tokens, 4096);
  const maxIterations = numeric(attributes.max_iterations, 10);
  const thinkingBudget = numeric(attributes.thinking_budget, 0);
  const servers = normalizeServers(attributes.mcp_servers);

  const setServers = (next: McpServer[]) => onChange('mcp_servers', next);
  const addServer = (preset?: McpServer) =>
    setServers([...servers, preset ?? { name: '', url: '', auth_env_var: '' }]);
  const removeServer = (i: number) => setServers(servers.filter((_, idx) => idx !== i));
  const updateServer = (i: number, patch: Partial<McpServer>) =>
    setServers(servers.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <Bot className="w-4 h-4 text-primary" />
          {provider.label} agent
        </h3>
        <p className="text-[11px] text-gray-500 mt-0.5">
          Run a single-turn or looping LLM task with MCP tool access. The agent decides which tools to invoke, up to the iteration budget.
        </p>
      </div>

      {/* Model + credentials */}
      <section className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Model</label>
          <input
            list={`agent-models-${provider.id}`}
            value={model}
            onChange={(e) => onChange('model', e.target.value)}
            placeholder={provider.models[0]}
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <datalist id={`agent-models-${provider.id}`}>
            {provider.models.map((m) => <option key={m} value={m} />)}
          </datalist>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">API key env var</label>
          <input
            value={apiKeyEnvVar}
            onChange={(e) => onChange('api_key_env_var', e.target.value)}
            placeholder={provider.id === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GOOGLE_API_KEY'}
            className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </section>

      {/* System prompt */}
      <section>
        <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1 block">
          System prompt
        </label>
        <div className="border border-gray-200 rounded overflow-hidden">
          <Editor
            height="80px"
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

      {/* Task / user prompt */}
      <section>
        <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1 block">
          Task
        </label>
        <div className="border border-gray-200 rounded overflow-hidden">
          <Editor
            height="120px"
            defaultLanguage="markdown"
            value={prompt}
            onChange={(v) => onChange('prompt', v ?? '')}
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
        <p className="text-[10px] text-gray-500 mt-1">
          What the agent should accomplish. It may call tools from the MCP servers below up to <strong>{maxIterations}</strong> times before settling on a final answer.
        </p>
      </section>

      {/* MCP servers — the differentiator vs LLMSidebar */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
            MCP tool servers
          </label>
          <span className="text-[10px] text-gray-400">{servers.length} attached</span>
        </div>

        {/* Preset chips */}
        <div className="flex flex-wrap gap-1 mb-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => addServer(p.server)}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-gray-200 text-gray-700 hover:border-primary/40 hover:bg-primary/5"
            >
              <Sparkles className="w-3 h-3 text-primary/60" />
              + {p.label}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {servers.length === 0 && (
            <div className="p-3 rounded border border-dashed border-gray-300 text-[11px] text-gray-500 text-center">
              No MCP servers yet — pick a preset above or add a custom one below.<br />
              The agent runs LLM-only if no tools are attached.
            </div>
          )}
          {servers.map((s, i) => (
            <div key={i} className="p-2 rounded border border-gray-200 bg-gray-50 space-y-1.5">
              <div className="flex items-center gap-2">
                <Server className="w-3.5 h-3.5 text-gray-500" />
                <input
                  value={s.name ?? ''}
                  onChange={(e) => updateServer(i, { name: e.target.value })}
                  placeholder="server name"
                  className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => removeServer(i)}
                  className="p-1 text-gray-400 hover:text-gray-700"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <input
                value={s.url ?? ''}
                onChange={(e) => updateServer(i, { url: e.target.value })}
                placeholder="https://... or stdio://..."
                className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={s.auth_env_var ?? ''}
                  onChange={(e) => updateServer(i, { auth_env_var: e.target.value })}
                  placeholder="auth env var (optional)"
                  className="w-full px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <select
                  value={s.transport ?? ''}
                  onChange={(e) => updateServer(i, { transport: e.target.value || undefined })}
                  className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="">auto transport</option>
                  <option value="http">http</option>
                  <option value="sse">sse</option>
                  <option value="stdio">stdio</option>
                </select>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => addServer()}
          className="mt-2 inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/5 rounded"
        >
          <Plus className="w-3 h-3" /> Add custom MCP server
        </button>
      </section>

      {/* Iteration + sampling knobs */}
      <section className="space-y-2">
        <SliderRow
          label="Tool-use iteration budget"
          value={maxIterations}
          min={1}
          max={30}
          step={1}
          hint="How many tool → response loops the agent gets before it must answer."
          onChange={(v) => onChange('max_iterations', v)}
        />
        <SliderRow
          label="Temperature"
          value={temperature}
          min={0}
          max={2}
          step={0.05}
          hint="0 = deterministic decisions; higher = more exploratory."
          onChange={(v) => onChange('temperature', v)}
        />
        <div className="flex items-center justify-between text-[11px] text-gray-700">
          <span>Max output tokens</span>
          <input
            type="number"
            min={1}
            value={maxTokens}
            onChange={(e) => {
              const n = Number(e.target.value);
              // Gemini uses max_output_tokens, Anthropic uses max_tokens
              onChange(provider.id === 'gemini' ? 'max_output_tokens' : 'max_tokens', n);
            }}
            className="w-20 px-1.5 py-0.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {provider.hasThinkingBudget && (
          <SliderRow
            label="Thinking budget"
            value={thinkingBudget}
            min={0}
            max={65536}
            step={1024}
            hint="Gemini 2.5+ only. Tokens the model can spend on internal reasoning before responding. 0 = off."
            onChange={(v) => onChange('thinking_budget', v)}
          />
        )}
      </section>

      {onOpenAdvanced && (
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="w-full text-left text-xs px-3 py-2 border border-dashed border-gray-300 rounded-md text-gray-600 hover:bg-gray-50"
        >
          Advanced fields → (base_url, deps, tags, freshness, …)
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
          className="w-20 px-1.5 py-0.5 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
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
