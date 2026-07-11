import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Sparkles, Loader2, Plus, Check } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface GenerateMonitorsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onGenerated?: () => void;
}

type Proposal = Awaited<ReturnType<typeof projectsApi.generateMonitors>>['proposals'][number];

/**
 * "Generate monitors with AI" — pick an asset, Claude proposes a
 * starter pack of enhanced-check monitors. User reviews each proposal
 * (with Claude's reasoning + editable params) and hits Create all to
 * hand each accepted one to POST /monitors.
 *
 * Design goals:
 *  • Fast to try — asset picker autocompletes from the current project
 *  • Transparent — every proposal shows Claude's "why", the params
 *    yaml, and can be individually toggled off before creation
 *  • Idempotent-ish — names default to Claude's snake_case suggestion;
 *    the backend rejects duplicates so re-runs don't clobber
 */
export function GenerateMonitorsDialog({ open, onOpenChange, projectId, onGenerated }: GenerateMonitorsDialogProps) {
  const [step, setStep] = useState<'target' | 'review'>('target');
  const [asset, setAsset] = useState('');
  const [availableAssets, setAvailableAssets] = useState<string[]>([]);
  const [focus, setFocus] = useState<string>('');
  const [maxProposals, setMaxProposals] = useState<number>(5);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    projectsApi.listMonitors(projectId).then((r) => {
      if (cancelled) return;
      const s = new Set<string>();
      for (const m of r.monitors) for (const t of m.target_asset_keys) s.add(t);
      setAvailableAssets(Array.from(s).sort());
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, projectId]);

  const reset = () => {
    setStep('target'); setAsset(''); setFocus(''); setMaxProposals(5);
    setProposals([]); setAccepted(new Set()); setError(null);
  };

  const generate = async () => {
    if (!asset.trim()) { notify.error('Pick an asset to protect.'); return; }
    setLoading(true); setError(null);
    try {
      const r = await projectsApi.generateMonitors(projectId, {
        asset_key: asset.trim(),
        max_proposals: maxProposals,
        focus: focus.trim() || null,
      });
      setProposals(r.proposals);
      setAccepted(new Set(r.proposals.map((_, i) => i))); // default: accept all
      setStep('review');
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      if (typeof detail === 'string' && (detail.includes('API key') || detail.includes('ANTHROPIC') || detail.includes('OPENAI'))) {
        setError('Set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY on the backend and restart.');
      } else if (e?.response?.status === 404) {
        setError('Endpoint not found — restart the backend so the new /monitors/generate endpoint loads.');
      } else {
        setError(detail || e?.message || 'Generation failed.');
      }
    } finally { setLoading(false); }
  };

  const createAll = async () => {
    if (accepted.size === 0) { notify.error('Accept at least one proposal.'); return; }
    setCreating(true);
    let ok = 0, fail = 0;
    for (const i of accepted) {
      const p = proposals[i];
      try {
        await projectsApi.addMonitor(projectId, {
          implementation: 'enhanced_check',
          name: p.name,
          target_asset_key: asset,
          check_kind: p.check_kind,
          description: p.description,
          severity: (p.severity as any) || 'error',
          column: p.column || undefined,
          params_json: p.params,
          schedule_cron: p.schedule_cron || undefined,
          run_on_materialization: p.run_on_materialization ?? true,
        });
        ok++;
      } catch (e: any) {
        console.error('addMonitor failed for', p.name, e);
        fail++;
      }
    }
    setCreating(false);
    if (ok > 0) notify.success(`Created ${ok} monitor${ok === 1 ? '' : 's'}`);
    if (fail > 0) notify.error(`${fail} proposal${fail === 1 ? '' : 's'} failed — check console.`);
    if (ok > 0) {
      onGenerated?.();
      onOpenChange(false);
      reset();
    }
  };

  const toggle = (i: number) => {
    const next = new Set(accepted);
    if (next.has(i)) next.delete(i); else next.add(i);
    setAccepted(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl w-[900px] max-w-[96vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-b from-white to-gray-50/50">
            <div>
              <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                Generate monitors with AI
              </Dialog.Title>
              <p className="text-xs text-gray-500 mt-0.5 ml-10">
                Pick an asset — Claude proposes a starter pack of enhanced-check monitors based on its schema + lineage.
              </p>
            </div>
            <Dialog.Close className="p-1.5 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-700">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <div className="p-5 overflow-y-auto flex-1 space-y-4">
            {step === 'target' && (
              <>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Asset to protect</label>
                  <input
                    list="gen-assets"
                    value={asset}
                    onChange={(e) => setAsset(e.target.value)}
                    placeholder="e.g. jaffle_shop/customers"
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded"
                  />
                  <datalist id="gen-assets">
                    {availableAssets.map((a) => <option key={a} value={a} />)}
                  </datalist>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Focus (optional)</label>
                    <input
                      value={focus}
                      onChange={(e) => setFocus(e.target.value)}
                      placeholder="e.g. 'freshness', 'volume', 'null rates'"
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded"
                    />
                    <p className="text-[10px] text-gray-500 mt-0.5">Nudge Claude toward a category. Leave blank for a balanced starter pack.</p>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">How many?</label>
                    <input
                      type="number"
                      value={maxProposals}
                      min={1}
                      max={10}
                      onChange={(e) => setMaxProposals(Number(e.target.value))}
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded"
                    />
                    <p className="text-[10px] text-gray-500 mt-0.5">Cap on proposals. 5 is a good starting point.</p>
                  </div>
                </div>
                {error && (
                  <div className="p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800">{error}</div>
                )}
              </>
            )}

            {step === 'review' && (
              <>
                <div className="p-2.5 bg-indigo-50 border border-indigo-200 rounded flex items-center gap-2 text-xs">
                  <Sparkles className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="text-indigo-900 font-medium">
                      Claude proposed {proposals.length} monitor{proposals.length === 1 ? '' : 's'} for
                      <span className="font-mono ml-1">{asset}</span>
                    </div>
                    <div className="text-[11px] text-indigo-700 mt-0.5">
                      Uncheck any you don't want. Params + name are pre-filled — tweak them on the monitor detail page after create.
                    </div>
                  </div>
                  <button
                    onClick={() => setStep('target')}
                    className="text-[11px] text-indigo-700 hover:text-indigo-900 underline decoration-dotted flex-shrink-0"
                  >
                    change asset
                  </button>
                </div>

                {proposals.length === 0 ? (
                  <div className="p-6 text-center text-xs text-gray-500 italic">
                    Claude didn't return any proposals. Try adding a focus hint or picking a different asset.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {proposals.map((p, i) => (
                      <li
                        key={i}
                        onClick={() => toggle(i)}
                        className={`border rounded-lg p-3 cursor-pointer transition ${
                          accepted.has(i)
                            ? 'border-indigo-300 bg-indigo-50/50 ring-1 ring-indigo-100'
                            : 'border-gray-200 bg-gray-50/30 opacity-60'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5 ${
                            accepted.has(i) ? 'bg-indigo-600' : 'bg-gray-300'
                          }`}>
                            {accepted.has(i) && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2 flex-wrap">
                              <span className="font-mono text-sm font-semibold text-gray-900">{p.name}</span>
                              <span className="px-1.5 py-0.5 text-[10px] rounded bg-violet-50 border border-violet-200 text-violet-700 font-mono">
                                {p.check_kind}
                              </span>
                              {p.column && (
                                <span className="text-[11px] text-gray-500">on <span className="font-mono text-gray-700">{p.column}</span></span>
                              )}
                              {p.severity && (
                                <span className={`text-[10px] font-medium ${p.severity === 'error' ? 'text-rose-700' : p.severity === 'warn' ? 'text-amber-700' : 'text-gray-500'}`}>
                                  · {p.severity}
                                </span>
                              )}
                            </div>
                            {p.description && (
                              <p className="text-xs text-gray-700 mt-1">{p.description}</p>
                            )}
                            {p.reasoning && (
                              <p className="text-[11px] text-indigo-700 mt-1 italic">
                                <Sparkles className="w-3 h-3 inline mr-0.5" />
                                {p.reasoning}
                              </p>
                            )}
                            {Object.keys(p.params || {}).length > 0 && (
                              <pre className="text-[10px] font-mono text-gray-500 bg-white border border-gray-100 rounded p-2 mt-2 overflow-auto max-h-24">
                                {JSON.stringify(p.params, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {error && (
                  <div className="p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800">{error}</div>
                )}
              </>
            )}
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-2">
            {step === 'review' && (
              <button
                onClick={() => setStep('target')}
                className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
              >
                Back
              </button>
            )}
            <div className="flex items-center gap-2 ml-auto">
              <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
              {step === 'target' ? (
                <button
                  onClick={generate}
                  disabled={loading || !asset.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {loading ? 'Asking Claude…' : 'Generate'}
                </button>
              ) : (
                <button
                  onClick={createAll}
                  disabled={creating || accepted.size === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {creating ? 'Creating…' : `Create ${accepted.size} monitor${accepted.size === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
