import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Filter, Loader2, Plus, Trash2 } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddDbtSelectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  dbtRelativePath: string;
  onSaved?: () => void;
}

type MatchKind = 'fqn' | 'tag' | 'path' | 'package' | 'source' | 'config';

const MATCH_KINDS: Array<{ id: MatchKind; label: string; hint: string }> = [
  { id: 'fqn',     label: 'Model name',    hint: 'Match a specific model by name (or wildcard).' },
  { id: 'tag',     label: 'Tag',           hint: 'Match every model tagged with this value.' },
  { id: 'path',    label: 'Path',          hint: 'Match every model under a folder.' },
  { id: 'package', label: 'Package',       hint: 'Match models from a specific dbt package.' },
  { id: 'source',  label: 'Source',        hint: 'Match a source (loaded via `source(...)`).' },
  { id: 'config',  label: 'Config',        hint: 'Match by config (e.g. materialized: incremental).' },
];

interface Clause {
  method: MatchKind;
  value: string;
  include_ancestors: boolean;   // `+model`
  include_descendants: boolean; // `model+`
}

/**
 * Visually compose a dbt selector — one or more match clauses (fqn/tag
 * /path/etc.) with optional +ancestor / descendant+ toggles, joined
 * by `union` or `intersection`. Compiles to the selectors.yml
 * definition tree that dbt understands.
 */
export function AddDbtSelectorDialog({ open, onOpenChange, projectId, dbtRelativePath, onSaved }: AddDbtSelectorDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [operator, setOperator] = useState<'union' | 'intersection'>('union');
  const [clauses, setClauses] = useState<Clause[]>([
    { method: 'tag', value: '', include_ancestors: false, include_descendants: true },
  ]);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName(''); setDescription(''); setOperator('union');
    setClauses([{ method: 'tag', value: '', include_ancestors: false, include_descendants: true }]);
    setIsDefault(false);
  };

  const addClause = () => setClauses([...clauses, { method: 'tag', value: '', include_ancestors: false, include_descendants: false }]);
  const updateClause = (i: number, patch: Partial<Clause>) => setClauses(clauses.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeClause = (i: number) => setClauses(clauses.filter((_, j) => j !== i));

  // Compile to the definition tree dbt expects. Single clause is
  // wrapped in a bare {method, value, ...} object; multiple clauses
  // wrap in {union: [...]} or {intersection: [...]}.
  const compile = () => {
    const compiled = clauses
      .filter((c) => c.value.trim())
      .map((c) => {
        const entry: any = { method: c.method, value: c.value.trim() };
        if (c.include_ancestors) entry.parents = true;
        if (c.include_descendants) entry.children = true;
        return entry;
      });
    if (compiled.length === 0) return null;
    if (compiled.length === 1) return compiled[0];
    return { [operator]: compiled };
  };

  const definitionPreview = () => {
    const c = compile();
    if (!c) return '# add at least one clause…\n';
    // Small readable pseudo-yaml — the backend does the real yaml dump.
    return JSON.stringify(c, null, 2);
  };

  const submit = async () => {
    if (!name.trim()) { notify.error('Selector name is required.'); return; }
    const def = compile();
    if (!def) { notify.error('Add at least one clause with a value.'); return; }
    setSaving(true);
    try {
      await projectsApi.addDbtSelector(projectId, {
        dbt_relative_path: dbtRelativePath,
        name: name.trim(),
        description: description.trim() || undefined,
        definition: def,
        default: isDefault,
      });
      notify.success(`Saved selector "${name}" to selectors.yml`);
      onSaved?.();
      onOpenChange(false);
      reset();
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (e?.response?.status === 404) {
        notify.error('Endpoint not found — restart the backend so the new dbt endpoints load.');
      } else {
        notify.error(detail || e?.message || 'Failed to save selector.');
      }
    } finally { setSaving(false); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl w-[640px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Filter className="w-5 h-5 text-orange-500" />
              New selector
            </Dialog.Title>
            <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-4 overflow-y-auto flex-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="daily_snapshots"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Description (optional)</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this selector selects"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-gray-700">Match clauses</label>
                <div className="flex items-center gap-2">
                  {clauses.length > 1 && (
                    <div className="flex items-center gap-0.5 bg-gray-100 rounded p-0.5">
                      {(['union', 'intersection'] as const).map((op) => (
                        <button key={op} type="button" onClick={() => setOperator(op)}
                          className={`px-2 py-0.5 text-[11px] rounded ${operator === op ? 'bg-white shadow-sm font-medium text-gray-900' : 'text-gray-600'}`}>
                          {op}
                        </button>
                      ))}
                    </div>
                  )}
                  <button type="button" onClick={addClause} className="text-[11px] text-blue-600 hover:text-blue-800 inline-flex items-center gap-0.5">
                    <Plus className="w-3 h-3" /> add
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {clauses.map((c, i) => (
                  <div key={i} className="p-2 border border-gray-200 rounded bg-gray-50/40">
                    <div className="flex items-center gap-1">
                      <select value={c.method} onChange={(e) => updateClause(i, { method: e.target.value as MatchKind })}
                        className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded bg-white">
                        {MATCH_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                      </select>
                      <input value={c.value} onChange={(e) => updateClause(i, { value: e.target.value })}
                        placeholder={c.method === 'tag' ? 'daily' : c.method === 'path' ? 'models/staging' : c.method === 'fqn' ? 'orders' : 'value'}
                        className="px-1.5 py-1 text-xs font-mono border border-gray-300 rounded flex-1 min-w-0" />
                      <button type="button" onClick={() => removeClause(i)} disabled={clauses.length === 1}
                        className="p-1 text-gray-400 hover:text-rose-600 disabled:opacity-30">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="mt-1 pl-1 flex items-center gap-3 text-[11px] text-gray-600">
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" checked={c.include_ancestors}
                          onChange={(e) => updateClause(i, { include_ancestors: e.target.checked })} className="w-3 h-3" />
                        <span>+ancestors</span>
                      </label>
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input type="checkbox" checked={c.include_descendants}
                          onChange={(e) => updateClause(i, { include_descendants: e.target.checked })} className="w-3 h-3" />
                        <span>descendants+</span>
                      </label>
                      <span className="text-gray-400 font-mono ml-auto">
                        {c.include_ancestors ? '+' : ''}{c.method}:{c.value || '<value>'}{c.include_descendants ? '+' : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-500 mt-1">
                {clauses.length > 1
                  ? operator === 'union' ? 'Union — any clause matches.' : 'Intersection — all clauses must match.'
                  : 'One clause active.'}
              </p>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="w-3.5 h-3.5" />
              <span>Mark as default selector (`dbt build` uses it when no --select flag is passed)</span>
            </label>

            <div>
              <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Definition (yaml preview)</label>
              <pre className="text-[11px] font-mono bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto max-h-40">{definitionPreview()}</pre>
            </div>
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
            <button onClick={submit} disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Filter className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save selector'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
