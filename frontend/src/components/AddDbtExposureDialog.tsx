import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Share2, Loader2, Plus } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddDbtExposureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  dbtRelativePath: string;
  onSaved?: () => void;
}

const TYPES = ['dashboard', 'notebook', 'analysis', 'ml', 'application'] as const;
const MATURITIES = ['low', 'medium', 'high'] as const;

/**
 * Compose a dbt exposure — a declared downstream consumer of the
 * project's models (dashboard, ML model, notebook, etc.). Users pick a
 * type, add an owner, and check off the upstream models this exposure
 * depends on so the manifest sees the edges.
 */
export function AddDbtExposureDialog({ open, onOpenChange, projectId, dbtRelativePath, onSaved }: AddDbtExposureDialogProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<typeof TYPES[number]>('dashboard');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [url, setUrl] = useState('');
  const [maturity, setMaturity] = useState<typeof MATURITIES[number] | ''>('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [availableModels, setAvailableModels] = useState<Array<{ unique_id: string; name: string; resource_type: string }>>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !dbtRelativePath) return;
    let cancelled = false;
    projectsApi.listDbtModels(projectId, dbtRelativePath).then((r) => {
      if (!cancelled) {
        setAvailableModels(r.models.map((m) => ({ unique_id: m.unique_id, name: m.name, resource_type: m.resource_type })));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, projectId, dbtRelativePath]);

  const reset = () => {
    setName(''); setType('dashboard'); setLabel(''); setDescription(''); setOwnerName(''); setOwnerEmail('');
    setUrl(''); setMaturity(''); setDependsOn([]); setModelSearch('');
  };

  const toggle = (uid: string) => {
    setDependsOn((cur) => cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid]);
  };

  const submit = async () => {
    if (!name.trim()) { notify.error('Exposure name is required.'); return; }
    setSaving(true);
    try {
      await projectsApi.addDbtExposure(projectId, {
        dbt_relative_path: dbtRelativePath,
        name: name.trim(),
        type,
        label: label.trim() || undefined,
        description: description.trim() || undefined,
        owner_name: ownerName.trim() || undefined,
        owner_email: ownerEmail.trim() || undefined,
        url: url.trim() || undefined,
        maturity: maturity || undefined,
        depends_on: dependsOn,
      });
      notify.success(`Saved exposure "${name}" to models/exposures.yml`);
      onSaved?.();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 404) {
        notify.error('Endpoint not found — restart the backend so the new dbt endpoints load.');
      } else {
        notify.error(detail || e?.message || 'Failed to save exposure.');
      }
    } finally { setSaving(false); }
  };

  const filtered = availableModels.filter((m) => {
    if (!modelSearch.trim()) return true;
    const q = modelSearch.trim().toLowerCase();
    return m.name.toLowerCase().includes(q) || m.unique_id.toLowerCase().includes(q);
  });

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl w-[680px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Share2 className="w-5 h-5 text-orange-500" />
              New exposure
            </Dialog.Title>
            <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto flex-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="weekly_revenue_dashboard"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Type</label>
                <select value={type} onChange={(e) => setType(e.target.value as any)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded bg-white">
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Label (optional)</label>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Weekly Revenue"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Maturity (optional)</label>
                <select value={maturity} onChange={(e) => setMaturity(e.target.value as any)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded bg-white">
                  <option value="">— none —</option>
                  {MATURITIES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Owner name</label>
                <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Data Team"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Owner email</label>
                <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="data@example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">URL (optional)</label>
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mode.com/reports/12345"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                  placeholder="What this exposure represents + why it matters"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded" />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-gray-700">Depends on ({dependsOn.length})</label>
                <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search models…"
                  className="px-2 py-1 text-xs border border-gray-300 rounded" />
              </div>
              <div className="border border-gray-200 rounded max-h-56 overflow-y-auto bg-white">
                {filtered.length === 0 ? (
                  <div className="p-3 text-xs text-gray-500 italic">No matches.</div>
                ) : (
                  filtered.map((m) => (
                    <label key={m.unique_id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-0">
                      <input type="checkbox" checked={dependsOn.includes(m.unique_id)} onChange={() => toggle(m.unique_id)} className="w-3 h-3" />
                      <span className="font-mono text-gray-900">{m.name}</span>
                      <span className="text-[10px] text-gray-500">· {m.resource_type}</span>
                    </label>
                  ))
                )}
              </div>
              {dependsOn.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {dependsOn.map((uid) => (
                    <span key={uid} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-blue-50 border border-blue-200 text-blue-700 font-mono">
                      {uid.replace(/^(model|source|seed)\./, '')}
                      <button type="button" onClick={() => toggle(uid)} className="hover:text-rose-600">×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button onClick={submit} disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save exposure'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
