import { Wand2 } from 'lucide-react';
import type { TryResult } from '@/lib/extractionTry';
import { suggestValidation, type ValidationDraft } from '@/lib/extractionFreeze';

export interface WatchDraft {
  enabled: boolean;
  pattern: string;
  intervalSeconds: number;
}

const INPUT = 'px-2 py-1 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500';

/**
 * "Run unattended": what makes the extraction safe to leave running. Flag documents that need a person (missing required fields,
 * line items that don't add up), and optionally watch a folder so new files are picked up on their own. Suggestions come from the
 * sample runs, so this is where "worked on these samples" turns into rules for the thousandth document.
 */
export function UnattendedSection({
  fields,
  draft,
  onDraft,
  sampleResults,
  watch,
  onWatch,
  watchDir,
  processedDir,
}: {
  fields: string[];
  draft: ValidationDraft;
  onDraft: (d: ValidationDraft) => void;
  sampleResults: TryResult[];
  watch: WatchDraft;
  onWatch: (w: WatchDraft) => void;
  /** The local folder that would be watched, or null when the source can't be watched from here. */
  watchDir: string | null;
  processedDir: string;
}) {
  const set = (patch: Partial<ValidationDraft>) => onDraft({ ...draft, ...patch });
  const setReconcile = (patch: Partial<ValidationDraft['reconcile']>) => onDraft({ ...draft, reconcile: { ...draft.reconcile, ...patch } });
  const hasSamples = sampleResults.some((r) => r.ok);

  const applySuggestion = () => {
    const s = suggestValidation(sampleResults, fields);
    onDraft({ ...draft, enabled: true, requiredFields: s.requiredFields, reconcile: s.reconcile ?? draft.reconcile });
  };
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  return (
    <div className="border-t border-gray-100 pt-4 space-y-3">
      <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Run unattended <span className="text-gray-400 font-normal normal-case">(optional)</span></h3>

      <label className="flex items-start gap-2 text-xs text-gray-700">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="mt-0.5" />
        <span>
          Flag documents that need a person to look at them
          <span className="block text-[10px] text-gray-400">Adds a status and reasons to every row, and one warning check that fails when too few documents pass.</span>
        </span>
      </label>

      {draft.enabled && (
        <div className="space-y-3 pl-6">
          <button
            type="button"
            onClick={applySuggestion}
            disabled={!hasSamples}
            title={hasSamples ? undefined : 'Run on some samples first'}
            className="inline-flex items-center gap-1 text-xs text-violet-600 hover:text-violet-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Wand2 className="w-3.5 h-3.5" /> Suggest from the sample runs
          </button>

          <div>
            <div className="text-xs font-medium text-gray-700 mb-1">Must come back filled in</div>
            <div className="flex flex-wrap gap-1.5">
              {fields.map((f) => (
                <label key={f} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-mono cursor-pointer ${draft.requiredFields.includes(f) ? 'bg-violet-50 border-violet-200 text-violet-800' : 'bg-white border-gray-200 text-gray-500'}`}>
                  <input type="checkbox" className="w-3 h-3" checked={draft.requiredFields.includes(f)} onChange={() => set({ requiredFields: toggle(draft.requiredFields, f) })} />
                  {f}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={draft.reconcile.enabled} onChange={(e) => setReconcile({ enabled: e.target.checked })} />
              Line items must add up to the total
            </label>
            {draft.reconcile.enabled && (
              <div className="grid grid-cols-2 gap-2 pl-6">
                <label className="text-[11px] text-gray-500">Total field
                  <select value={draft.reconcile.totalField} onChange={(e) => setReconcile({ totalField: e.target.value })} className={`${INPUT} w-full mt-0.5 bg-white font-mono`}>
                    <option value="">Pick…</option>
                    {fields.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
                <label className="text-[11px] text-gray-500">Line items field
                  <select value={draft.reconcile.itemsField} onChange={(e) => setReconcile({ itemsField: e.target.value })} className={`${INPUT} w-full mt-0.5 bg-white font-mono`}>
                    <option value="">Pick…</option>
                    {fields.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
                <label className="text-[11px] text-gray-500">Amount key in each item
                  <input value={draft.reconcile.amountKey} onChange={(e) => setReconcile({ amountKey: e.target.value })} className={`${INPUT} w-full mt-0.5 font-mono`} />
                </label>
                <label className="text-[11px] text-gray-500">Allowed difference
                  <input type="number" min={0} step={0.01} value={draft.reconcile.tolerance} onChange={(e) => setReconcile({ tolerance: Math.max(0, Number(e.target.value) || 0) })} className={`${INPUT} w-full mt-0.5 font-mono`} />
                </label>
                <div className="col-span-2 text-[11px] text-gray-500">
                  Also add to the items' sum:{' '}
                  {fields.filter((f) => f !== draft.reconcile.totalField && f !== draft.reconcile.itemsField).map((f) => (
                    <label key={f} className="inline-flex items-center gap-1 mr-2 font-mono">
                      <input type="checkbox" className="w-3 h-3" checked={draft.reconcile.addFields.includes(f)} onChange={() => setReconcile({ addFields: toggle(draft.reconcile.addFields, f) })} />
                      {f}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-gray-700">
            The check passes when at least
            <input type="number" min={0} max={100} value={draft.minPassPercent} onChange={(e) => set({ minPassPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} className={`${INPUT} w-16 font-mono`} />
            % of documents are fine
          </label>
        </div>
      )}

      <div className="space-y-1.5">
        <label className={`flex items-start gap-2 text-xs ${watchDir ? 'text-gray-700' : 'text-gray-400'}`}>
          <input type="checkbox" disabled={!watchDir} checked={watch.enabled && !!watchDir} onChange={(e) => onWatch({ ...watch, enabled: e.target.checked })} className="mt-0.5" />
          <span>
            Pick up new files automatically
            <span className="block text-[10px] text-gray-400">
              {watchDir
                ? <>Watches <span className="font-mono">{watchDir}</span> and runs the extraction when files arrive. Processed files move to <span className="font-mono">{processedDir}</span> so nothing is read twice.</>
                : 'Only for a folder on this machine. For cloud storage, add a sensor or schedule from Automations.'}
            </span>
          </span>
        </label>
        {watch.enabled && watchDir && (
          <div className="grid grid-cols-2 gap-2 pl-6">
            <label className="text-[11px] text-gray-500">File name pattern (regex)
              <input value={watch.pattern} onChange={(e) => onWatch({ ...watch, pattern: e.target.value })} className={`${INPUT} w-full mt-0.5 font-mono`} />
            </label>
            <label className="text-[11px] text-gray-500">Check every (seconds)
              <input type="number" min={5} value={watch.intervalSeconds} onChange={(e) => onWatch({ ...watch, intervalSeconds: Math.max(5, Number(e.target.value) || 5) })} className={`${INPUT} w-full mt-0.5 font-mono`} />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
