import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Loader2 } from 'lucide-react';
import { aiApi } from '@/services/api';
import { describeServer, chatModels, pickDefaultModel } from '@/lib/detectedLocal';
import { notify } from './Notifications';
import { notifyAiProvidersChanged } from './SettingsDialog';

/**
 * "We found a model on this machine" -- one click to use it, so first-run setup doesn't start with typing a URL.
 * Renders nothing when no local model server is running.
 */
export function DetectedLocalModel() {
  const { data } = useQuery({ queryKey: ['ai-local-detect'], queryFn: () => aiApi.detectLocal(), staleTime: 30_000, retry: false });
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const servers = data?.servers ?? [];
  if (servers.length === 0) return null;

  const use = async (baseUrl: string, model: string) => {
    setSaving(baseUrl);
    try {
      await aiApi.setKeys({ local_base_url: baseUrl, local_model: model });
      notify.success(`Using ${model} from this machine.`);
      notifyAiProvidersChanged();
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || 'Could not save the local model.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-1.5">
      {servers.map((s) => {
        const info = describeServer(s);
        const models = chatModels(s.models);
        const selected = choice[s.base_url] ?? pickDefaultModel(s.models);
        return (
          <div key={s.base_url} className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
            <Cpu className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 text-xs text-emerald-900">
              <div>{info.text}</div>
              {info.usable && (
                <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                  <select
                    value={selected}
                    onChange={(e) => setChoice((c) => ({ ...c, [s.base_url]: e.target.value }))}
                    className="px-2 py-1 text-xs border border-emerald-300 rounded-md bg-white font-mono"
                  >
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <button
                    onClick={() => use(s.base_url, selected)}
                    disabled={!selected || saving !== null}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {saving === s.base_url && <Loader2 className="w-3 h-3 animate-spin" />}
                    Use it
                  </button>
                  <span className="text-[10px] text-emerald-700">Bigger models plan better; small ones are fine for chat and extraction.</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
