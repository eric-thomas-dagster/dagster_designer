import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Loader2, Trash2, Plus, KeyRound, GitBranch, CheckCircle2, AlertTriangle, Wand2, Search } from 'lucide-react';
import { promotionApi, type PromotionConfig, type RepoMapping } from '@/services/api';
import { notify } from './Notifications';

/**
 * PromotionSettingsModal — where the user configures the GitHub token
 * and the (org, location) → repo mappings that gate BOTH the local
 * preview flow (needs `repo` scope to clone) and the promote flow
 * (needs `repo` scope to push + open a PR). Same PAT, same mappings,
 * two entry points.
 *
 * Everything the demo needs is here: paste a PAT, verify at least one
 * mapping exists for your target loc, close, hit Local or Promote.
 * No env vars, no config files to edit by hand.
 */
interface PromotionSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PromotionSettingsModal({ open, onOpenChange }: PromotionSettingsModalProps) {
  const [config, setConfig] = useState<PromotionConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [rows, setRows] = useState<RepoMapping[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Awaited<ReturnType<typeof promotionApi.testToken>> | null>(null);

  // Per-row transient state for the defs_subdir helper: which row's
  // candidate list is open, and each row's most recent path-validation
  // result. Keyed by row index so mappings stay independent.
  const [detectingRow, setDetectingRow] = useState<number | null>(null);
  const [candidatesByRow, setCandidatesByRow] = useState<Record<number, Awaited<ReturnType<typeof promotionApi.resolveDefsSubdir>> | null>>({});
  const [validationByRow, setValidationByRow] = useState<Record<number, Awaited<ReturnType<typeof promotionApi.validateDefsSubdir>> | null>>({});
  const [validatingRow, setValidatingRow] = useState<number | null>(null);

  const handleDetectDefsSubdir = async (idx: number) => {
    const row = rows[idx];
    if (!row.owner_repo || !row.default_branch) return;
    setDetectingRow(idx);
    try {
      const res = await promotionApi.resolveDefsSubdir({
        owner_repo: row.owner_repo.trim(),
        ref: row.default_branch.trim() || 'main',
        location_name: row.location.trim(),
      });
      setCandidatesByRow((prev) => ({ ...prev, [idx]: res }));
    } catch (e: any) {
      notify.error(`Detect failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setDetectingRow(null);
    }
  };

  const handleValidateDefsSubdir = async (idx: number) => {
    const row = rows[idx];
    if (!row.owner_repo || !row.default_branch || !row.defs_subdir) {
      setValidationByRow((prev) => ({ ...prev, [idx]: null }));
      return;
    }
    setValidatingRow(idx);
    try {
      const res = await promotionApi.validateDefsSubdir({
        owner_repo: row.owner_repo.trim(),
        ref: row.default_branch.trim() || 'main',
        defs_subdir: row.defs_subdir.trim(),
      });
      setValidationByRow((prev) => ({ ...prev, [idx]: res }));
    } catch {
      setValidationByRow((prev) => ({ ...prev, [idx]: null }));
    } finally {
      setValidatingRow(null);
    }
  };

  const pickCandidate = (idx: number, path: string) => {
    handleUpdateRow(idx, { defs_subdir: path });
    setCandidatesByRow((prev) => ({ ...prev, [idx]: null }));
    // Auto-validate the freshly-picked path.
    setTimeout(() => handleValidateDefsSubdir(idx), 0);
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    promotionApi.getConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        // Seed rows from user mappings; if empty fall back to defaults
        // so the user has something to edit rather than a blank slate.
        setRows(c.mappings.length > 0 ? c.mappings : c.defaults);
        setTokenInput('');
      })
      .catch(() => { /* leave form empty */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);

  const handleAddRow = () => {
    setRows([...rows, {
      org: '',
      location: '',
      owner_repo: '',
      default_branch: 'main',
      defs_subdir: '',
    }]);
  };

  const handleUpdateRow = (idx: number, patch: Partial<RepoMapping>) => {
    setRows(rows.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const handleDeleteRow = (idx: number) => {
    setRows(rows.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Cleanup: drop rows missing a required field.
      const clean = rows.filter((r) => r.org && r.location && r.owner_repo && r.defs_subdir);
      const c = await promotionApi.saveConfig({
        github_token: tokenInput,
        mappings: clean,
      });
      setConfig(c);
      setTokenInput('');
      notify.success('GitHub integration saved');
      onOpenChange(false);
    } catch (e: any) {
      notify.error(`Save failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClearToken = () => {
    if (!confirm('Clear the saved GitHub token?')) return;
    setTokenInput('__CLEAR__');
    setTestResult(null);
  };

  // Test with the pasted token if present, otherwise the saved one.
  // Include current mapping repos so fine-grained PATs (empty scopes
  // on /user) can be verified per-repo.
  const handleTestToken = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const owner_repos = Array.from(new Set(
        rows.map((r) => r.owner_repo?.trim()).filter((v): v is string => !!v)
      ));
      const candidate = tokenInput && tokenInput !== '__CLEAR__' ? tokenInput : '';
      const res = await promotionApi.testToken({ github_token: candidate, owner_repos });
      setTestResult(res);
    } catch (e: any) {
      setTestResult({
        valid: false,
        message: e?.response?.data?.detail || e?.message || String(e),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[820px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white shadow-2xl border border-gray-200 flex flex-col max-h-[92vh]">
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 flex-shrink-0">
            <Dialog.Title className="text-base font-semibold text-gray-900">
              GitHub integration
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-gray-500 hover:bg-gray-100">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>
          <div className="px-5 py-4 space-y-6 overflow-auto">
            <Dialog.Description className="text-xs text-gray-500">
              Configure the GitHub PAT + repo bindings Designer uses for git-backed flows:
              cloning the target repo to boot a <strong>local preview</strong> against a draft, and
              opening a PR when you <strong>promote</strong> a draft. Same token, same mappings —
              set once, both flows work.
              Settings persist in <code>~/.dagster-designer/config/promotion.json</code>.
            </Dialog.Description>

            {loading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                {/* Token */}
                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <KeyRound className="w-4 h-4 text-gray-700" />
                    <h3 className="text-sm font-semibold text-gray-900">GitHub token</h3>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    Personal Access Token with <code>repo</code> scope. Create one at{' '}
                    <a
                      className="text-blue-600 hover:underline"
                      href="https://github.com/settings/tokens?type=beta"
                      target="_blank"
                      rel="noreferrer"
                    >
                      github.com/settings/tokens
                    </a>.
                  </p>
                  {config?.github_token_present && !tokenInput && (
                    <div className="text-xs mb-2 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800">
                        ✓ token saved
                      </span>
                      <span className="text-gray-500 font-mono">{config.github_token_preview}</span>
                      <button
                        onClick={handleClearToken}
                        className="ml-2 text-red-600 hover:underline"
                      >
                        clear
                      </button>
                    </div>
                  )}
                  <div className="flex items-stretch gap-2">
                    <input
                      type="password"
                      value={tokenInput === '__CLEAR__' ? '' : tokenInput}
                      onChange={(e) => { setTokenInput(e.target.value); setTestResult(null); }}
                      placeholder={config?.github_token_present ? 'Leave blank to keep saved token, or paste a new one' : 'ghp_… or github_pat_…'}
                      className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={handleTestToken}
                      disabled={testing || (!tokenInput && !config?.github_token_present) || tokenInput === '__CLEAR__'}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Verify the token authenticates + has write access to your configured repos"
                    >
                      {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                      Test
                    </button>
                  </div>
                  {tokenInput === '__CLEAR__' && (
                    <p className="mt-1 text-[11px] text-red-700">Token will be cleared on save.</p>
                  )}
                  {testResult && (
                    <div
                      className={`mt-2 rounded border text-xs ${
                        testResult.valid && testResult.ok_for_promote
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                          : testResult.valid
                            ? 'bg-amber-50 border-amber-200 text-amber-900'
                            : 'bg-red-50 border-red-200 text-red-900'
                      }`}
                    >
                      <div className="flex items-start gap-2 px-3 py-2">
                        {testResult.valid && testResult.ok_for_promote ? (
                          <CheckCircle2 className="w-3.5 h-3.5 mt-[1px] shrink-0 text-emerald-600" />
                        ) : (
                          <AlertTriangle className={`w-3.5 h-3.5 mt-[1px] shrink-0 ${testResult.valid ? 'text-amber-600' : 'text-red-600'}`} />
                        )}
                        <div className="space-y-1 min-w-0">
                          {testResult.valid && testResult.login && (
                            <p><strong>Authenticated as {testResult.login}</strong>{testResult.name ? ` (${testResult.name})` : ''}</p>
                          )}
                          <p>{testResult.message}</p>
                          {testResult.scopes && testResult.scopes.length > 0 && (
                            <p className="text-[11px] opacity-80">
                              Scopes: <code>{testResult.scopes.join(', ')}</code>
                            </p>
                          )}
                          {testResult.repos && testResult.repos.length > 0 && (
                            <ul className="text-[11px] space-y-0.5 pt-0.5">
                              {testResult.repos.map((r) => (
                                <li key={r.owner_repo} className="flex items-center gap-1.5">
                                  {r.ok && r.can_push ? (
                                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                  ) : (
                                    <AlertTriangle className="w-3 h-3 text-amber-600" />
                                  )}
                                  <code className="font-mono">{r.owner_repo}</code>
                                  {r.ok && r.can_push && <span className="opacity-70">— read + push OK</span>}
                                  {r.ok && !r.can_push && <span className="opacity-70">— read only ({r.reason})</span>}
                                  {!r.ok && <span className="opacity-70">— {r.reason}</span>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </section>

                {/* Mappings */}
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <GitBranch className="w-4 h-4 text-gray-700" />
                      <h3 className="text-sm font-semibold text-gray-900">Repo mappings</h3>
                    </div>
                    <button
                      onClick={handleAddRow}
                      className="inline-flex items-center gap-1 text-xs text-indigo-700 hover:bg-indigo-50 px-2 py-1 rounded"
                    >
                      <Plus className="w-3 h-3" /> Add mapping
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">
                    One row per <code>(Dagster+ org, code location)</code> pair. Promote lands
                    the draft's <code>defs.yaml</code> under <code>defs_subdir</code> of the target
                    repo on a fresh branch off <code>default_branch</code>.
                  </p>
                  {rows.length === 0 ? (
                    <div className="text-xs text-gray-500 p-3 border border-dashed border-gray-300 rounded text-center">
                      No mappings yet. Add one to enable Promote.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {rows.map((row, idx) => (
                        <div key={idx} className="border border-gray-200 rounded p-3 bg-gray-50/50">
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <LabeledInput label="Dagster+ org" value={row.org} onChange={(v) => handleUpdateRow(idx, { org: v })} placeholder="hooli" />
                            <LabeledInput label="Code location" value={row.location} onChange={(v) => handleUpdateRow(idx, { location: v })} placeholder="data-eng-pipeline" />
                          </div>
                          <LabeledInput label="Target repo (owner/name)" value={row.owner_repo} onChange={(v) => handleUpdateRow(idx, { owner_repo: v })} placeholder="dagster-io/hooli-data-eng-pipelines" mono />
                          <div className="grid grid-cols-2 gap-2 mt-2">
                            <LabeledInput label="Base branch" value={row.default_branch} onChange={(v) => handleUpdateRow(idx, { default_branch: v })} placeholder="main" mono />
                            <div className="space-y-1">
                              <div className="flex items-center justify-between gap-2">
                                <label className="block text-[11px] font-medium text-gray-700">Defs subdir</label>
                                <button
                                  type="button"
                                  onClick={() => handleDetectDefsSubdir(idx)}
                                  disabled={detectingRow === idx || !row.owner_repo || !row.default_branch}
                                  className="inline-flex items-center gap-1 text-[10px] text-indigo-700 hover:bg-indigo-50 px-1.5 py-0.5 rounded disabled:opacity-50"
                                  title="Scan the target repo and suggest paths"
                                >
                                  {detectingRow === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                                  Detect
                                </button>
                              </div>
                              <div className="flex items-stretch gap-1">
                                <input
                                  value={row.defs_subdir}
                                  onChange={(e) => {
                                    handleUpdateRow(idx, { defs_subdir: e.target.value });
                                    setValidationByRow((prev) => ({ ...prev, [idx]: null }));
                                  }}
                                  onBlur={() => handleValidateDefsSubdir(idx)}
                                  placeholder="hooli-data-eng/src/hooli_data_eng/defs"
                                  className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded font-mono"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleValidateDefsSubdir(idx)}
                                  disabled={validatingRow === idx || !row.owner_repo || !row.defs_subdir}
                                  className="inline-flex items-center px-2 text-[10px] text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                                  title="Confirm this path exists on the base branch"
                                >
                                  {validatingRow === idx ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Check'}
                                </button>
                              </div>
                              {validationByRow[idx] && (
                                <p className={`text-[10.5px] flex items-start gap-1 ${
                                  validationByRow[idx]!.exists === true && validationByRow[idx]!.is_dir
                                    ? 'text-emerald-800'
                                    : validationByRow[idx]!.exists === false
                                      ? 'text-red-800'
                                      : 'text-amber-800'
                                }`}>
                                  {validationByRow[idx]!.exists === true && validationByRow[idx]!.is_dir ? (
                                    <CheckCircle2 className="w-3 h-3 mt-[1px] shrink-0" />
                                  ) : (
                                    <AlertTriangle className="w-3 h-3 mt-[1px] shrink-0" />
                                  )}
                                  <span>{validationByRow[idx]!.message}</span>
                                </p>
                              )}
                              {candidatesByRow[idx] && (
                                <div className="mt-1 border border-indigo-200 bg-indigo-50/60 rounded p-2 space-y-1">
                                  <p className="text-[10.5px] text-indigo-900">{candidatesByRow[idx]!.message}</p>
                                  {candidatesByRow[idx]!.candidates.length === 0 ? (
                                    <p className="text-[10.5px] text-gray-600 italic">No candidates found. Enter a path manually.</p>
                                  ) : (
                                    <ul className="space-y-0.5">
                                      {candidatesByRow[idx]!.candidates.map((c) => (
                                        <li key={c.path}>
                                          <button
                                            type="button"
                                            onClick={() => pickCandidate(idx, c.path)}
                                            className="w-full text-left text-[10.5px] px-1.5 py-1 rounded hover:bg-white border border-transparent hover:border-indigo-300"
                                          >
                                            <div className="font-mono text-indigo-900">{c.path}</div>
                                            <div className="text-[10px] text-gray-600">{c.reason}</div>
                                          </button>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => setCandidatesByRow((prev) => ({ ...prev, [idx]: null }))}
                                    className="text-[10px] text-gray-500 hover:text-gray-800 underline"
                                  >
                                    close
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                          <PreviewEnvEditor
                            value={row.preview_env ?? {}}
                            onChange={(next) => handleUpdateRow(idx, { preview_env: next })}
                          />
                          <div className="flex justify-end mt-2">
                            <button
                              onClick={() => handleDeleteRow(idx)}
                              className="inline-flex items-center gap-1 text-[11px] text-red-600 hover:bg-red-50 px-2 py-1 rounded"
                            >
                              <Trash2 className="w-3 h-3" /> Remove
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 flex-shrink-0">
            <button
              onClick={() => onOpenChange(false)}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save settings
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


interface LabeledInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}

function LabeledInput({ label, value, onChange, placeholder, mono }: LabeledInputProps) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-gray-600 mb-0.5">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}


interface PreviewEnvEditorProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

/**
 * PreviewEnvEditor — key/value grid for the `preview_env` field on a
 * RepoMapping. These env vars get injected into `dagster dev` when the
 * loc is previewed on the laptop. Non-prod values only; missing values
 * mean components using `dg.EnvVar` fail loudly (the safe outcome).
 */
function PreviewEnvEditor({ value, onChange }: PreviewEnvEditorProps) {
  const [expanded, setExpanded] = useState<boolean>(Object.keys(value).length > 0);
  const entries = Object.entries(value);

  const updateKey = (oldKey: string, newKey: string) => {
    if (newKey === oldKey) return;
    const next = { ...value };
    if (newKey.trim()) {
      next[newKey] = next[oldKey];
    }
    delete next[oldKey];
    onChange(next);
  };
  const updateVal = (key: string, v: string) => {
    onChange({ ...value, [key]: v });
  };
  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const add = () => {
    // Unique-ish placeholder key so multiple new rows don't collide.
    let n = 1;
    let k = 'NEW_VAR';
    while (k in value) { n += 1; k = `NEW_VAR_${n}`; }
    onChange({ ...value, [k]: '' });
    setExpanded(true);
  };

  return (
    <div className="mt-3 pt-3 border-t border-gray-200">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="text-[11px] font-medium text-gray-700 hover:text-gray-900 flex items-center gap-1"
      >
        <span>{expanded ? '▾' : '▸'}</span>
        Preview env vars ({entries.length})
      </button>
      {expanded && (
        <div className="mt-2 space-y-1">
          {entries.length === 0 ? (
            <p className="text-[10px] text-gray-500 leading-snug">
              No overrides yet. Add non-prod values for anything a component looks up via <code>dg.EnvVar</code> —
              e.g. <code>SNOWFLAKE_ACCOUNT</code>, <code>DATABASE_URL</code>, <code>S3_BUCKET</code>. Preview refuses
              to boot if a required var is missing, so under-configured is safer than half-configured.
            </p>
          ) : (
            entries.map(([k, v], i) => (
              <div key={i} className="flex gap-1">
                <input
                  type="text"
                  value={k}
                  onChange={(e) => updateKey(k, e.target.value)}
                  placeholder="VAR_NAME"
                  className="w-1/3 px-2 py-1 text-[11px] font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <input
                  type="text"
                  value={v}
                  onChange={(e) => updateVal(k, e.target.value)}
                  placeholder="value"
                  className="flex-1 px-2 py-1 text-[11px] font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={() => remove(k)}
                  className="px-1.5 text-red-600 hover:bg-red-50 rounded"
                  title="Remove"
                >×</button>
              </div>
            ))
          )}
          <button
            onClick={add}
            className="mt-1 text-[10px] text-indigo-700 hover:bg-indigo-50 px-2 py-0.5 rounded"
          >
            + Add env var
          </button>
        </div>
      )}
    </div>
  );
}
