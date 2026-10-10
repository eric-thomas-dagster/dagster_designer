import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Tags, Loader2, Plus, Trash2 } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';
import { useProjectStore } from '@/hooks/useProject';

interface PostProcessingRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface RuleRow {
  target: string;
  group_name: string;
  owners: string; // comma-separated, parsed on save
  tags: string;    // "key=value, key2=value2", parsed on save, same convention as Common fields
}

function parseTagsInput(s: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of s.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [k, ...rest] = trimmed.split('=');
    const key = k.trim();
    if (key) tags[key] = rest.join('=').trim();
  }
  return tags;
}

const EMPTY_ROW: RuleRow = { target: '', group_name: '', owners: '', tags: '' };

/**
 * Project-wide post_processing rules: `target` is a real Dagster
 * asset-selection expression (e.g. "tag:critical=true", "key:core/stg_*",
 * "*"), not a single literal asset key -- the one mechanism that can apply
 * group_name/owners/tags to MANY assets in a single rule. Confirmed
 * directly against a real Dagster load: one rule with `target:
 * "tag:critical=true"` applied to every tagged asset, left everything
 * else untouched.
 *
 * Distinct from the per-asset "Common fields" editors in
 * ComponentConfigModal/PropertyPanel, which only ever target one asset --
 * this is the power-user case those can't cover (e.g. "tag every staging
 * model with an owner in one rule" instead of editing N assets by hand).
 */
export function PostProcessingRulesDialog({ open, onOpenChange }: PostProcessingRulesDialogProps) {
  const { currentProject, loadProject } = useProjectStore();
  const [rows, setRows] = useState<RuleRow[]>([{ ...EMPTY_ROW }]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const existing = currentProject?.asset_post_processing_rules || [];
    setRows(
      existing.length > 0
        ? existing.map((r) => ({
            target: r.target,
            group_name: r.group_name || '',
            owners: (r.owners || []).join(', '),
            tags: Object.entries(r.tags || {}).map(([k, v]) => `${k}=${v}`).join(', '),
          }))
        : [{ ...EMPTY_ROW }]
    );
  }, [open, currentProject]);

  const updateRow = (i: number, patch: Partial<RuleRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows([...rows, { ...EMPTY_ROW }]);
  const removeRow = (i: number) => setRows(rows.filter((_, j) => j !== i));

  const save = async () => {
    if (!currentProject) return;
    setSaving(true);
    try {
      const rules = rows
        .filter((r) => r.target.trim())
        .map((r) => ({
          target: r.target.trim(),
          group_name: r.group_name.trim() || null,
          owners: r.owners.trim() ? r.owners.split(',').map((o) => o.trim()).filter(Boolean) : null,
          tags: r.tags.trim() ? parseTagsInput(r.tags) : null,
        }));
      const previousRules = currentProject.asset_post_processing_rules || [];
      await projectsApi.setPostProcessingRules(currentProject.id, rules);

      // A rule's `target` is a real Dagster selector expression (see the
      // class doc comment) -- unlike the single-asset "Common fields"
      // editors, a malformed one here isn't normalized/guarded server-side
      // and can break the whole project's load. Validate and restore the
      // prior rules list if so.
      const { validateProjectOrRollback } = await import('@/lib/validateProjectOrRollback');
      const result = await validateProjectOrRollback(currentProject.id, async () => {
        await projectsApi.setPostProcessingRules(currentProject.id, previousRules);
      });
      if (!result.ok) {
        await loadProject(currentProject.id);
        notify.error(`These rules would have broken the project, so they were undone:\n${result.error}`);
        return;
      }

      await loadProject(currentProject.id);
      notify.success(`Saved ${rules.length} post-processing rule(s).`);
      onOpenChange(false);
    } catch (e: any) {
      notify.error(`Failed to save rules: ${e?.response?.data?.detail ?? e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl w-[760px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Tags className="w-5 h-5 text-orange-500" />
              Post-processing rules
            </Dialog.Title>
            <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-3 overflow-y-auto flex-1">
            <div className="text-xs text-gray-600 bg-blue-50 border border-blue-200 rounded-md p-2">
              Apply group_name / owners / tags to every asset matching a selector, in one
              rule — e.g. <code className="bg-blue-100 px-1 rounded">tag:critical=true</code>,{' '}
              <code className="bg-blue-100 px-1 rounded">key:core/stg_*</code>, or{' '}
              <code className="bg-blue-100 px-1 rounded">*</code> for every asset. To edit a
              single asset instead, use its own Dependencies/Common fields section.
            </div>

            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="p-3 border border-gray-200 rounded-md bg-gray-50/40 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Target selector</label>
                      <input
                        type="text"
                        value={row.target}
                        onChange={(e) => updateRow(i, { target: e.target.value })}
                        placeholder='tag:critical=true, key:core/stg_*, or "*"'
                        className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      disabled={rows.length === 1}
                      className="p-1.5 mt-5 text-gray-400 hover:text-rose-600 disabled:opacity-30"
                      title="Remove rule"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Group name</label>
                      <input
                        type="text"
                        value={row.group_name}
                        onChange={(e) => updateRow(i, { group_name: e.target.value })}
                        placeholder="staging"
                        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Owners (comma-sep)</label>
                      <input
                        type="text"
                        value={row.owners}
                        onChange={(e) => updateRow(i, { owners: e.target.value })}
                        placeholder="team:analytics-eng"
                        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Tags (key=value, comma-sep)</label>
                      <input
                        type="text"
                        value={row.tags}
                        onChange={(e) => updateRow(i, { tags: e.target.value })}
                        placeholder="tier=prod"
                        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addRow}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 border border-blue-200 rounded-md hover:bg-blue-50"
            >
              <Plus className="w-3.5 h-3.5" />
              Add rule
            </button>
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tags className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save rules'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
