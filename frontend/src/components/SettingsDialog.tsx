import { useEffect, useState } from 'react';
import { X, KeyRound, ExternalLink, CheckCircle2 } from 'lucide-react';
import { aiApi, type AiProvidersStatus } from '@/services/api';
import { notify } from './Notifications';

// Lightweight module-level pub-sub, same pattern as Notifications.tsx's
// toast/confirm queues -- avoids threading "is settings open" state through
// every component that might want to open it (the native Preferences menu
// item, the "needs an API key" banner, ...).
type Listener = (open: boolean) => void;
let isOpen = false;
let listeners: Listener[] = [];

function emit() {
  listeners.forEach((l) => l(isOpen));
}

export function openSettings() {
  isOpen = true;
  emit();
}

function closeSettingsInternal() {
  isOpen = false;
  emit();
}

// Fired after a successful key save so any open "needs an API key" banner
// can refetch provider status without a full reload.
const PROVIDERS_CHANGED_EVENT = 'dagster-ai-providers-changed';
export function onAiProvidersChanged(handler: () => void): () => void {
  window.addEventListener(PROVIDERS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(PROVIDERS_CHANGED_EVENT, handler);
}

/** Renders the Settings modal. Mount once near the app root. */
export function SettingsHost() {
  const [open, setOpen] = useState(isOpen);
  useEffect(() => {
    listeners.push(setOpen);
    return () => { listeners = listeners.filter((l) => l !== setOpen); };
  }, []);

  if (!open) return null;
  return <SettingsDialog onClose={closeSettingsInternal} />;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AiProvidersStatus | null>(null);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    aiApi.providers().then(setStatus).catch(() => setStatus(null));
  }, []);

  const save = async () => {
    // Only send fields the user actually typed something into -- an empty
    // field means "leave this key alone", not "clear it". Clearing is a
    // deliberate separate action (the trash icon) so a blank field left
    // over from a previous visit can't accidentally wipe a working key.
    const body: { openai_api_key?: string; anthropic_api_key?: string } = {};
    if (openaiKey.trim()) body.openai_api_key = openaiKey.trim();
    if (anthropicKey.trim()) body.anthropic_api_key = anthropicKey.trim();
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const next = await aiApi.setKeys(body);
      setStatus(next);
      setOpenaiKey('');
      setAnthropicKey('');
      notify.success('API key saved — ready to use right away, no restart needed.');
      window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || 'Failed to save API key.');
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async (which: 'openai' | 'anthropic') => {
    setSaving(true);
    try {
      const body = which === 'openai' ? { openai_api_key: '' } : { anthropic_api_key: '' };
      const next = await aiApi.setKeys(body);
      setStatus(next);
      notify.success(`${which === 'openai' ? 'OpenAI' : 'Anthropic'} key cleared.`);
      window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || 'Failed to clear key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Dagster AI Settings</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Used by the AI assistant across every project. Saved keys apply immediately — no restart needed.
        </p>

        <div className="space-y-4">
          <ProviderField
            label="OpenAI"
            configured={status?.openai_available ?? false}
            value={openaiKey}
            onChange={setOpenaiKey}
            onClear={() => clearKey('openai')}
            placeholder="sk-..."
            getKeyUrl="https://platform.openai.com/api-keys"
            disabled={saving}
          />
          <ProviderField
            label="Anthropic"
            configured={status?.anthropic_available ?? false}
            value={anthropicKey}
            onChange={setAnthropicKey}
            onClear={() => clearKey('anthropic')}
            placeholder="sk-ant-..."
            getKeyUrl="https://console.anthropic.com/settings/keys"
            disabled={saving}
          />
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50"
          >
            Close
          </button>
          <button
            onClick={save}
            disabled={saving || (!openaiKey.trim() && !anthropicKey.trim())}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderField({
  label, configured, value, onChange, onClear, placeholder, getKeyUrl, disabled,
}: {
  label: string;
  configured: boolean;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  placeholder: string;
  getKeyUrl: string;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-gray-700">{label} API key</label>
        {configured && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
            <CheckCircle2 className="w-3.5 h-3.5" /> Configured
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={configured ? '••••••••••••  (enter a new key to replace)' : placeholder}
          disabled={disabled}
          className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        {configured && (
          <button
            onClick={onClear}
            disabled={disabled}
            className="px-3 py-2 text-sm text-red-600 border border-gray-300 rounded-md hover:bg-red-50 disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
      <a
        href={getKeyUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
      >
        Get {label} key <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}
