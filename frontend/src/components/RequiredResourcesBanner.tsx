import { useState } from 'react';
import { Loader2, PackagePlus, Check } from 'lucide-react';
import { API_BASE } from '@/services/api';
import { notify } from './Notifications';

/** A resource a Genie plan refers to (e.g. the context receipt store). Resources are installed from the Resources tab, never
 * as picks, so the plan lists them separately. `installed` is null when the backend couldn't tell. */
export interface RequiredResource {
  component_id: string;
  resource_key: string;
  reason: string;
  needed_by: string;
  installed: boolean | null;
}

// Sensible defaults per resource so one click gives a working setup; anything not listed is installed unconfigured and
// finished from the Resources tab.
const DEFAULT_CONFIG: Record<string, (resourceKey: string) => Record<string, unknown>> = {
  context_receipt_store: (resourceKey) => ({
    name: resourceKey,
    resource_key: resourceKey,
    database_path: './var/context-receipts.sqlite3',
  }),
};

export async function installRequiredResource(projectId: string, r: RequiredResource): Promise<void> {
  const installRes = await fetch(`${API_BASE}/templates/install-via-cli/${r.component_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, config: {}, template_only: true }),
  });
  const installBody = await installRes.json().catch(() => ({} as any));
  if (!installRes.ok) throw new Error(installBody.detail || `Failed to install ${r.component_id}`);
  const config = DEFAULT_CONFIG[r.component_id]?.(r.resource_key);
  if (!config) return;
  const configRes = await fetch(`${API_BASE}/templates/configure/${r.component_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, config }),
  });
  const configBody = await configRes.json().catch(() => ({} as any));
  if (!configRes.ok) throw new Error(configBody.detail || `Failed to configure ${r.component_id}`);
}

export function RequiredResourcesBanner({
  resources,
  projectId,
  onInstalled,
}: {
  resources: RequiredResource[] | undefined;
  projectId: string;
  onInstalled?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const pending = (resources || []).filter((r) => r.installed !== true);
  if (pending.length === 0) return null;

  const install = async (r: RequiredResource) => {
    const id = `${r.component_id}:${r.resource_key}`;
    setBusy(id);
    try {
      await installRequiredResource(projectId, r);
      setDone((prev) => new Set(prev).add(id));
      notify.success(`Installed ${r.component_id.replace(/_/g, ' ')} as "${r.resource_key}".`);
      onInstalled?.();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 space-y-1.5">
      <div className="text-xs font-medium text-violet-900">This plan also needs {pending.length === 1 ? 'a resource' : 'resources'}</div>
      {pending.map((r) => {
        const id = `${r.component_id}:${r.resource_key}`;
        const isDone = done.has(id);
        return (
          <div key={id} className="flex items-center justify-between gap-3 text-xs text-violet-800">
            <span className="min-w-0">
              <span className="font-mono">{r.component_id}</span> as <span className="font-mono">{r.resource_key}</span>
              {r.reason && <span className="text-violet-600"> — {r.needed_by} {r.reason}</span>}
            </span>
            <button
              type="button"
              disabled={isDone || busy === id}
              onClick={() => install(r)}
              className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-violet-300 bg-white hover:bg-violet-100 disabled:opacity-60"
            >
              {busy === id ? <Loader2 className="w-3 h-3 animate-spin" /> : isDone ? <Check className="w-3 h-3" /> : <PackagePlus className="w-3 h-3" />}
              {isDone ? 'Installed' : 'Install'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
