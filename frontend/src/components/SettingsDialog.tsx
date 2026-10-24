import { useEffect, useRef, useState } from 'react';
import { X, KeyRound, ExternalLink, CheckCircle2, FolderCog, Github, Zap } from 'lucide-react';
import { aiApi, appSettingsApi, projectsApi, promotionApi, type AiProvidersStatus } from '@/services/api';
import { notify, confirmDialog } from './Notifications';
import { isTauri, getProjectsDir, setProjectsDir, pickDirectory, secretSet, secretDelete, secretsAvailable } from '@/services/tauri';
import { saveKeys, clearKey as clearKeyEverywhere, type KeyBody, type KeySaveDeps } from '@/lib/keySaving';
import { useProjectStore } from '@/hooks/useProject';
import { PromotionSettingsModal } from './PromotionSettingsModal';
import { DetectedLocalModel } from './DetectedLocalModel';

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
type SettingsTab = 'ai' | 'projects' | 'performance' | 'github';
// Each section of settings gets its own tab, so the dialog stays one screen tall however many sections it grows.
// Only the AI tab has a Save button (the others apply as you change them).
const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; desktopOnly?: boolean }> = [
  { id: 'ai', label: 'AI keys' },
  { id: 'projects', label: 'Projects folder', desktopOnly: true },
  { id: 'performance', label: 'Performance' },
  { id: 'github', label: 'GitHub' },
];

const PROVIDERS_CHANGED_EVENT = 'dagster-ai-providers-changed';

// Keys go into the OS keychain when the desktop app has one, and are saved the old way otherwise (see lib/keySaving.ts).
const keyDeps: KeySaveDeps<AiProvidersStatus> = {
  secretSet,
  secretDelete,
  setKeys: (body: KeyBody) => aiApi.setKeys(body as Parameters<typeof aiApi.setKeys>[0]),
};
/** Tell every open picker and banner that provider settings changed (a key saved, a local model chosen). */
export function notifyAiProvidersChanged(): void {
  window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
}
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
  const [anthropicWorkspaceId, setAnthropicWorkspaceId] = useState('');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(() => {
    try {
      const t = localStorage.getItem('designer:settings-tab') as SettingsTab | null;
      return t && SETTINGS_TABS.some((x) => x.id === t) ? t : 'ai';
    } catch {
      return 'ai';
    }
  });
  const chooseTab = (t: SettingsTab) => {
    setTab(t);
    try { localStorage.setItem('designer:settings-tab', t); } catch { /* remembering the tab is a nicety */ }
  };

  // Local model (Ollama, LM Studio, vLLM, ...). Seeded from the saved settings once they load, then edited locally.
  const [keychain, setKeychain] = useState<boolean | null>(null);
  useEffect(() => {
    if (isTauri) secretsAvailable().then(setKeychain);
  }, []);
  const [localUrl, setLocalUrl] = useState('');
  const [localModel, setLocalModel] = useState('');
  const [localKey, setLocalKey] = useState('');
  const [localPrefer, setLocalPrefer] = useState(false);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [localNote, setLocalNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const localSeeded = useRef(false);

  useEffect(() => {
    aiApi.providers().then(setStatus).catch(() => setStatus(null));
  }, []);
  // Provider settings can change from outside this form (a detected local model chosen with one click), so follow them --
  // otherwise Save would send the form's stale, empty local fields and wipe what was just saved.
  useEffect(() => {
    return onAiProvidersChanged(() => {
      aiApi.providers().then((s) => {
        setStatus(s);
        setLocalUrl(s.local_base_url || '');
        setLocalModel(s.local_model || '');
        setLocalPrefer(!!s.local_prefer);
      }).catch(() => {});
    });
  }, []);
  useEffect(() => {
    if (!status || localSeeded.current) return;
    localSeeded.current = true;
    setLocalUrl(status.local_base_url || '');
    setLocalModel(status.local_model || '');
    setLocalPrefer(!!status.local_prefer);
  }, [status]);

  const detectLocalModels = async () => {
    setDetecting(true);
    setLocalNote(null);
    try {
      const res = await aiApi.localModels(localUrl.trim() || undefined);
      setLocalModels(res.models);
      if (res.error) setLocalNote({ ok: false, text: res.error });
      else {
        setLocalNote({ ok: true, text: res.models.length ? `Connected — ${res.models.length} model${res.models.length === 1 ? '' : 's'} found.` : 'Connected, but the server lists no models yet.' });
        if (!localModel && res.models.length > 0) setLocalModel(res.models[0]);
      }
    } catch {
      setLocalNote({ ok: false, text: 'Could not check the server.' });
    } finally {
      setDetecting(false);
    }
  };

  const save = async () => {
    // Only send fields the user actually typed something into -- an empty
    // field means "leave this key alone", not "clear it". Clearing is a
    // deliberate separate action (the trash icon) so a blank field left
    // over from a previous visit can't accidentally wipe a working key.
    const body: Parameters<typeof aiApi.setKeys>[0] = {};
    if (openaiKey.trim()) body.openai_api_key = openaiKey.trim();
    if (anthropicKey.trim()) body.anthropic_api_key = anthropicKey.trim();
    if (anthropicWorkspaceId.trim()) body.anthropic_workspace_id = anthropicWorkspaceId.trim();
    // Local settings are plain values (not secrets), so they're sent when changed -- an emptied URL/model means "clear it".
    if (localUrl.trim() !== (status?.local_base_url || '')) body.local_base_url = localUrl.trim();
    if (localModel.trim() !== (status?.local_model || '')) body.local_model = localModel.trim();
    if (localKey.trim()) body.local_api_key = localKey.trim();
    if (localPrefer !== !!status?.local_prefer) body.local_prefer = localPrefer;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const next = await saveKeys(body as KeyBody, keyDeps);
      if (next) setStatus(next);
      setOpenaiKey('');
      setAnthropicKey('');
      setAnthropicWorkspaceId('');
      setLocalKey('');
      notify.success('Saved — ready to use right away, no restart needed.');
      window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || 'Failed to save API key.');
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async (which: 'openai' | 'anthropic' | 'anthropic_workspace') => {
    setSaving(true);
    try {
      const field = which === 'openai' ? 'openai_api_key' : which === 'anthropic' ? 'anthropic_api_key' : 'anthropic_workspace_id';
      const next = await clearKeyEverywhere(field, keyDeps);
      setStatus(next);
      const label = which === 'openai' ? 'OpenAI key' : which === 'anthropic' ? 'Anthropic key' : 'Anthropic workspace ID';
      notify.success(`${label} cleared.`);
      window.dispatchEvent(new Event(PROVIDERS_CHANGED_EVENT));
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || 'Failed to clear key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      {/* Fixed height (capped to the window): header, tabs and the Close/Save row never move between tabs; only the middle scrolls. */}
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg h-[min(34rem,90vh)] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 mb-1 flex-shrink-0">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Settings</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>
        <div className="flex gap-1 px-6 mt-3 border-b border-gray-200 flex-shrink-0" role="tablist">
          {SETTINGS_TABS.filter((t) => !t.desktopOnly || isTauri).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => chooseTab(t.id)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${
                tab === t.id ? 'border-primary text-primary font-medium' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {tab === 'ai' && (<>
        <p className="text-sm text-gray-500 mb-4">
          Used by the AI assistant across every project. Saved keys apply immediately — no restart needed.
          {isTauri && keychain === true && ' API keys are kept in your computer’s keychain, not in a file.'}
          {isTauri && keychain === false && ' No keychain was found on this machine, so API keys are saved in a file in the app’s data folder.'}
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

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-gray-700">
                Anthropic workspace ID <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              {status?.anthropic_workspace_id_configured && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Configured
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={anthropicWorkspaceId}
                onChange={(e) => setAnthropicWorkspaceId(e.target.value)}
                placeholder={status?.anthropic_workspace_id_configured ? '••••••••••••  (enter a new ID to replace)' : 'wrkspc_...'}
                disabled={saving}
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
              {status?.anthropic_workspace_id_configured && (
                <button
                  onClick={() => clearKey('anthropic_workspace')}
                  disabled={saving}
                  className="px-3 py-2 text-sm text-red-600 border border-gray-300 rounded-md hover:bg-red-50 disabled:opacity-50"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Only needed if your Anthropic key isn't scoped to a workspace — you'll see an error like
              "must include the anthropic-workspace-id header" if so. Find it in the Anthropic console under
              Settings → Workspaces.
            </p>
          </div>

          <div className="border-t border-gray-200 pt-4 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-700">
                Local model <span className="text-gray-400 font-normal">(Ollama, LM Studio, vLLM…)</span>
              </label>
              {status?.local_available && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Configured
                </span>
              )}
            </div>
            {!status?.local_available && <DetectedLocalModel />}
            <div className="flex gap-2">
              <input
                type="text"
                value={localUrl}
                onChange={(e) => setLocalUrl(e.target.value)}
                placeholder="http://localhost:11434"
                disabled={saving}
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 font-mono text-sm"
              />
              <button
                onClick={detectLocalModels}
                disabled={saving || detecting || !localUrl.trim()}
                className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                {detecting ? 'Checking…' : 'Detect models'}
              </button>
            </div>
            {localNote && <p className={`text-xs ${localNote.ok ? 'text-emerald-700' : 'text-amber-700'}`}>{localNote.text}</p>}
            <input
              type="text"
              list="local-model-options"
              value={localModel}
              onChange={(e) => setLocalModel(e.target.value)}
              placeholder="Default model, e.g. llama3.1:70b"
              disabled={saving}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 font-mono text-sm"
            />
            <datalist id="local-model-options">
              {localModels.map((m) => <option key={m} value={m} />)}
            </datalist>
            <input
              type="password"
              value={localKey}
              onChange={(e) => setLocalKey(e.target.value)}
              placeholder={status?.local_api_key_configured ? '••••••••  (enter a new key to replace)' : 'API key (optional — most local servers ignore it)'}
              disabled={saving}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 text-sm"
            />
            <label className="flex items-start gap-2 text-xs text-gray-700">
              <input type="checkbox" checked={localPrefer} onChange={(e) => setLocalPrefer(e.target.checked)} className="mt-0.5" />
              <span>Use the local model for Dagster AI chat even when a hosted key is also set</span>
            </label>
            <p className="text-xs text-gray-500">
              It then shows up in the model picker as “Local: &lt;model&gt;”. The planner sends a long prompt and needs strictly valid JSON, so
              use a large model with a big context window (roughly 70B-class, 16k+ tokens). Smaller models work for chat and extraction but
              often fail at planning. In Ollama, raise the context size (<span className="font-mono">num_ctx</span>) — its default silently truncates.
              Document extraction uses its own <span className="font-mono">API base env var</span> field.
            </p>
          </div>
        </div>

        </>)}

        {tab === 'projects' && isTauri && <ProjectsFolderSection />}
        {tab === 'performance' && <FastLoadingSection />}
        {tab === 'github' && <GitHubSection />}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50"
          >
            Close
          </button>
          {tab === 'ai' && <button
            onClick={save}
            disabled={saving || (!openaiKey.trim() && !anthropicKey.trim() && !anthropicWorkspaceId.trim())}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>}
        </div>
      </div>
    </div>
  );
}

/** Local-only speed-up: tells Designer's own `dg` subprocesses to skip building
 * the full component-library schema (~1,400 component types) on every
 * definitions load. Applied to Designer's local subprocess environment only --
 * nothing is written to project files -- so Dagster+ deployments still
 * advertise the whole library. */
function FastLoadingSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    appSettingsApi.get().then((s) => setEnabled(s.fast_local_loading)).catch(() => setEnabled(true));
  }, []);

  const toggle = async (next: boolean) => {
    setSaving(true);
    try {
      const s = await appSettingsApi.update({ fast_local_loading: next });
      setEnabled(s.fast_local_loading);
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Failed to update the setting.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2 mb-1">
        <Zap className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-gray-900">Fast local loading</h3>
      </div>
      <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={enabled ?? true}
          disabled={enabled === null || saving}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          Load projects faster on this machine
          <span className="block text-xs text-gray-500 mt-0.5">
            Skips building the full component-library catalog each time Designer loads a project's
            definitions (about half the time on small projects). Only affects Designer's local
            processes: Dagster+ deployments are unchanged and still list every component. Needs
            dagster-community-components 0.10.110 or newer; older projects are unaffected.
          </span>
        </span>
      </label>
    </div>
  );
}

/** Desktop-app only: where new projects get created (see src-tauri's
 * resolve_projects_dir). Defaults to ~/Documents/Dagster Designer -- a
 * plain, findable folder -- instead of the hidden app-data directory. */
function ProjectsFolderSection() {
  const [dir, setDir] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  // Set once a folder's been picked and there's at least one existing
  // project to ask about -- renders the move/delete/leave choice below.
  const [pendingDir, setPendingDir] = useState<string | null>(null);

  useEffect(() => {
    getProjectsDir().then(setDir);
  }, []);

  const applyChange = async (newDir: string) => {
    setChanging(true);
    try {
      await setProjectsDir(newDir);
      setDir(newDir);
      notify.success('Projects folder updated.');
      useProjectStore.getState().loadProjects();
    } catch (e: any) {
      notify.error(e?.message || 'Failed to change the projects folder.');
    } finally {
      setChanging(false);
      setPendingDir(null);
    }
  };

  const change = async () => {
    const picked = await pickDirectory('Choose a folder for new Dagster projects');
    if (!picked) return;
    let hasExisting = false;
    try {
      const { total } = await projectsApi.list();
      hasExisting = total > 0;
    } catch {
      // If we can't tell, err toward asking -- worst case an unnecessary click.
      hasExisting = true;
    }
    if (hasExisting) {
      setPendingDir(picked);
    } else {
      applyChange(picked);
    }
  };

  const leaveAsIs = () => pendingDir && applyChange(pendingDir);

  const move = async () => {
    if (!pendingDir) return;
    setChanging(true);
    try {
      const result = await projectsApi.migrateFolder(pendingDir, 'move');
      const skippedNote = result.skipped.length
        ? `, ${result.skipped.length} skipped (already existed there)`
        : '';
      notify.info(`Moved ${result.moved} project${result.moved === 1 ? '' : 's'}${skippedNote}.`);
      await applyChange(pendingDir);
    } catch (e: any) {
      notify.error(e?.message || 'Failed to move existing projects — folder not changed.');
      setChanging(false);
    }
  };

  const deleteExisting = async () => {
    if (!pendingDir) return;
    const ok = await confirmDialog(
      'This permanently deletes every project in the current folder. This cannot be undone.',
      { title: 'Delete existing projects?', destructive: true }
    );
    if (!ok) return;
    setChanging(true);
    try {
      const result = await projectsApi.migrateFolder(pendingDir, 'delete');
      notify.info(`Deleted ${result.deleted} project${result.deleted === 1 ? '' : 's'}.`);
      await applyChange(pendingDir);
    } catch (e: any) {
      notify.error(e?.message || 'Failed to delete existing projects — folder not changed.');
      setChanging(false);
    }
  };

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2 mb-1">
        <FolderCog className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-gray-900">Projects folder</h3>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Where new projects are created. Existing projects stay where they are when you change this.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={dir ?? 'Loading…'}
          readOnly
          className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 rounded-md bg-gray-50 text-gray-600"
        />
        <button
          onClick={change}
          disabled={changing || dir === null}
          className="px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-50"
        >
          {changing ? 'Applying…' : 'Change…'}
        </button>
      </div>

      {pendingDir && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Existing projects found</h3>
            <p className="text-sm text-gray-600 mb-4">
              You have projects in the current folder. What should happen to them when you switch to the new one?
            </p>
            <div className="space-y-2">
              <button
                onClick={move}
                disabled={changing}
                className="w-full text-left px-3 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
              >
                Move them to the new folder
              </button>
              <button
                onClick={leaveAsIs}
                disabled={changing}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-50"
              >
                Leave them where they are (won't show up until you switch back)
              </button>
              <button
                onClick={deleteExisting}
                disabled={changing}
                className="w-full text-left px-3 py-2 text-sm text-red-600 border border-gray-300 rounded-md hover:bg-red-50 disabled:opacity-50"
              >
                Delete them
              </button>
              <button
                onClick={() => setPendingDir(null)}
                disabled={changing}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** GitHub token + repo mappings live in their own established modal
 *  (PromotionSettingsModal, reachable from the Drafts drawer) — this
 *  isn't a duplicate of that form, just a discoverable summary + link
 *  into it, so "where do I configure GitHub" has an answer from the one
 *  place people already look for settings, without risking the
 *  existing (larger, working) form by merging it in wholesale. */
function GitHubSection() {
  const [tokenPresent, setTokenPresent] = useState<boolean | null>(null);
  const [mappingCount, setMappingCount] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = () => {
    promotionApi.getConfig()
      .then((c: any) => {
        setTokenPresent(!!c.github_token_present);
        setMappingCount((c.mappings || []).length);
      })
      .catch(() => { setTokenPresent(null); setMappingCount(0); });
  };
  useEffect(refresh, []);
  useEffect(() => { if (!modalOpen) refresh(); }, [modalOpen]);

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2 mb-1">
        <Github className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-gray-900">GitHub</h3>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Token and repo mappings used for pushing local projects and promoting Dagster+ drafts to a PR.
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-gray-600">
          {tokenPresent === null ? 'Loading…' : tokenPresent ? (
            <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> Token configured</span>
          ) : (
            <span className="text-amber-700">No token configured yet</span>
          )}
          {' · '}{mappingCount} repo mapping{mappingCount === 1 ? '' : 's'}
        </span>
        <button
          onClick={() => setModalOpen(true)}
          className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-100"
        >
          Configure…
        </button>
      </div>
      <PromotionSettingsModal open={modalOpen} onOpenChange={setModalOpen} />
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
