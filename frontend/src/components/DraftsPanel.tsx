import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, FileEdit, Trash2, Loader2, Layers, ExternalLink, GitPullRequest, Settings, Play, Cloud, RefreshCw, Radio, Square } from 'lucide-react';
import { draftsApi, previewApi, promotionApi, SANDBOX_LOCATION_NAME, type Draft } from '@/services/api';
import { notify } from './Notifications';
import { PromotionSettingsModal } from './PromotionSettingsModal';
import { usePreviews } from '@/hooks/usePreviews';
import { useRemotePreviews } from '@/hooks/useRemotePreviews';

/**
 * DraftsPanel — a side drawer listing all component drafts authored
 * against this project. Each row shows the target location + component
 * type + a preview of the YAML attributes.
 *
 * M2a: read + delete + (view attributes). Editing + promoting come in
 * later milestones.
 */
interface DraftsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  refreshKey?: number;                // bump to force reload
  /** Fired when the drawer mutates the drafts list (delete, promote).
   *  Lets the App header bump its badge count without polling. */
  onDraftsChanged?: () => void;
}

export function DraftsPanel({ open, onOpenChange, projectId, refreshKey, onDraftsChanged }: DraftsPanelProps) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { forDraft: previewForDraft, refresh: refreshPreviews } = usePreviews(open ? projectId : null);
  const {
    previews: remotePreviews,
    forDraft: remotePreviewForDraft,
    refresh: refreshRemotePreviews,
  } = useRemotePreviews(open ? projectId : null);
  const [bootingKey, setBootingKey] = useState<string | null>(null);
  const [bootingRemoteKey, setBootingRemoteKey] = useState<string | null>(null);
  const [syncingKey, setSyncingKey] = useState<string | null>(null);
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);

  // Live PR state per promoted draft. GitHub can move a PR to
  // closed / merged / deleted without Designer knowing, so the local
  // `status='promoted'` flag on the draft becomes stale. We refresh on
  // open + when the user hits Refresh, then let the row-render swap
  // "Open PR" ↔ "Re-promote" based on the actual state.
  type PRStateInfo = Awaited<ReturnType<typeof promotionApi.prStatus>>['statuses'][string];
  const [prStatuses, setPrStatuses] = useState<Record<string, PRStateInfo>>({});
  const [refreshingPr, setRefreshingPr] = useState(false);

  const refreshPrStatuses = async () => {
    setRefreshingPr(true);
    try {
      const r = await promotionApi.prStatus(projectId);
      setPrStatuses(r.statuses || {});
    } catch (e) {
      // Non-fatal — leave the last known state visible.
      console.warn('[drafts] pr-status refresh failed:', e);
    } finally {
      setRefreshingPr(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    draftsApi.list(projectId)
      .then((r) => {
        if (!alive) return;
        // Guard: only pending-PR items belong here. Sandbox authorings
        // are real files, not drafts — the modal never writes them here,
        // but this filter protects against stale rows just in case.
        setDrafts(r.drafts.filter((d) => d.location_name !== SANDBOX_LOCATION_NAME));
        // Kick off a live-state refresh for promoted drafts. Best-effort.
        refreshPrStatuses();
      })
      .catch((e) => { if (alive) setError(e?.message || String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, projectId, refreshKey]);

  const handleDelete = async (draftId: string) => {
    try {
      await draftsApi.remove(projectId, draftId);
      setDrafts((d) => d.filter((x) => x.id !== draftId));
      onDraftsChanged?.();
      notify.success('Draft deleted');
    } catch (e: any) {
      notify.error(`Failed to delete: ${e?.message || String(e)}`);
    }
  };

  const handlePromote = async (draftId: string) => {
    setPromotingId(draftId);
    try {
      const r = await draftsApi.promote(projectId, draftId);
      // Mark row as promoted in-place so the UI updates without a refetch.
      setDrafts((d) => d.map((x) => (
        x.id === draftId ? { ...x, status: 'promoted', promoted_pr_url: r.pr_url } : x
      )));
      // Show a compound message: PR link + expected BD + state cleanup status.
      const bits = [`PR opened at ${r.pr_url}`];
      if (r.expected_bd_name) {
        bits.push(`Dagster+ will create branch deployment "${r.expected_bd_name}" once the PR is pushed — that's where your merged component will run.`);
      }
      if (r.cleared_state?.cleared) {
        bits.push(`Preview state cleared from ${r.cleared_state.deployment} — the PR branch is now the single source of truth.`);
      } else if (r.cleared_state && !r.cleared_state.cleared) {
        bits.push(`⚠ Could not clear preview state (${r.cleared_state.reason || 'unknown'}). Delete manually to avoid duplicate-definition errors on merge.`);
      }
      if (r.rewrote_type) {
        bits.push(`Rewrote defs.yaml type from ${r.rewrote_type.from} → ${r.rewrote_type.to} (state-registry form vs. Python import path).`);
      }
      // Design-doc §7 pre-promote environment check. Only surface when
      // there are actual gaps — a clean match is silent so we don't
      // clutter the toast on the happy path.
      if (r.resource_check?.checked && (r.resource_check.missing?.length ?? 0) > 0) {
        const gaps = r.resource_check.missing!.map((m) => m.service).join(', ');
        bits.push(
          `⚠ Environment check: target location doesn't appear to have resource${r.resource_check.missing!.length === 1 ? '' : 's'} for [${gaps}]. ` +
          `The PR will still open, but the location may fail to load until the required resource(s) are configured on the deployment.`,
        );
      }
      // Community-component installer bootstrap. Only visible when the
      // promoted component was in the catalog and we added/updated the
      // installer's defs.yaml. Signals to the user that CI on the PR
      // will download the component's source at refresh-state time.
      if ((r.installer_files?.length ?? 0) > 0) {
        bits.push(
          `Community installer updated (${r.installer_files!.length} file). On merge + refresh-state, the deployment will download the component's source automatically.`,
        );
      }
      notify.success(bits.join(' · '));
      window.open(r.pr_url, '_blank');
      // Kick a live-state refresh so the button flips to "Open PR" (or
      // whatever the actual GitHub state is) without needing a redraw.
      refreshPrStatuses();
      onDraftsChanged?.();
    } catch (e: any) {
      const detail: string = e?.response?.data?.detail || e?.message || String(e);
      // Auto-open the settings modal when the failure is specifically
      // a missing GitHub token — cheaper than making the user hunt for
      // the gear icon.
      if (/GitHub token/i.test(detail) || /no token/i.test(detail)) {
        notify.error('Promote needs a GitHub PAT to open the PR. Opening GitHub integration…');
        setSettingsOpen(true);
      } else {
        notify.error(`Promote failed: ${detail}`);
      }
    } finally {
      setPromotingId(null);
    }
  };

  const handlePreview = async (d: Draft) => {
    if (!d.deployment_name) return;
    const key = `${d.deployment_name}::${d.location_name}`;
    setBootingKey(key);
    const showTokenGate = (detail: string) => {
      notify.error('Local preview needs a GitHub PAT to clone your repo. Opening GitHub integration…');
      setSettingsOpen(true);
      console.warn('[preview] token gate:', detail);
    };
    try {
      const state = await previewApi.boot(projectId, d.deployment_name, d.location_name);
      if (state.status === 'ready' && state.webserver_url) {
        notify.success(`Preview ready — opening ${state.webserver_url}`);
        window.open(state.webserver_url, '_blank');
      } else if (state.error) {
        // Local preview clones the target repo — same GitHub PAT
        // dependency as promote. Mirror the "auto-open settings" fallback
        // so the user gets nudged instead of hitting a dead-end toast.
        if (/GitHub token/i.test(state.error) || /no token/i.test(state.error)) {
          showTokenGate(state.error);
        } else {
          notify.error(`Preview failed: ${state.error}`);
        }
      } else {
        notify.info(`Preview status: ${state.status}`);
      }
      refreshPreviews();
    } catch (e: any) {
      const detail: string = e?.response?.data?.detail || e?.message || String(e);
      if (/GitHub token/i.test(detail) || /no token/i.test(detail)) {
        showTokenGate(detail);
      } else {
        notify.error(`Preview failed: ${detail}`);
      }
    } finally {
      setBootingKey(null);
    }
  };

  // Format installer-driven side effects (added / already-present /
  // no-installer / error) as toast lines. Called from both Sync and
  // Cloud handlers so users see when a community component was
  // installed on the target via the installer state-mutation path
  // rather than by their draft directly.
  const _addInstallerToastLines = (
    actions: Array<{ action: string; catalog_id: string; message: string }> | undefined,
    bits: string[],
  ) => {
    for (const a of (actions ?? [])) {
      if (a.action === 'added') {
        bits.push(`✨ Installed '${a.catalog_id}' on the BD via community_component_installer — no PR needed.`);
      } else if (a.action === 'no-installer') {
        bits.push(`⚠ '${a.catalog_id}' isn't loaded on the target and no community_component_installer is present. Promote first to install it, or add the installer via a PR.`);
      } else if (a.action === 'error') {
        bits.push(`⚠ Installer update for '${a.catalog_id}' failed: ${a.message}`);
      }
      // action === 'already-present' → stay silent (nothing changed).
    }
  };

  const handleRemotePreview = async (d: Draft) => {
    if (!d.deployment_name) return;
    const key = `${d.deployment_name}::${d.location_name}`;
    setBootingRemoteKey(key);
    // Pre-warmed via draft-save fire-and-forget when the target is a
    // long-lived deployment, so this often completes in ~1s. Branch
    // targets use the fast path (also ~1s). Slow path only when the
    // pre-warm hasn't finished + target is long-lived.
    notify.info('Booting Dagster+ preview…');
    try {
      const state = await previewApi.bootRemote(projectId, d.deployment_name, d.location_name);
      const bits = [`Preview ready — opening ${state.bd_name.slice(0, 12)}… (${state.drafts_applied.length} draft(s) applied)`];
      _addInstallerToastLines(state.installer_actions, bits);
      notify.success(bits.join(' · '));
      window.open(state.webserver_url, '_blank');
      refreshRemotePreviews();
    } catch (e: any) {
      notify.error(`Remote preview failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setBootingRemoteKey(null);
    }
  };

  const handleSyncRemote = async (d: Draft) => {
    if (!d.deployment_name) return;
    const key = `${d.deployment_name}::${d.location_name}`;
    setSyncingKey(key);
    try {
      const state = await previewApi.syncRemote(projectId, d.deployment_name, d.location_name);
      const bits = [`Synced ${state.drafts_applied.length} draft(s) to ${state.bd_name.slice(0, 12)}…`];
      _addInstallerToastLines(state.installer_actions, bits);
      notify.success(bits.join(' · '));
      refreshRemotePreviews();
    } catch (e: any) {
      notify.error(`Sync failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setSyncingKey(null);
    }
  };

  const handleStopRemote = async (baseDep: string, loc: string) => {
    const key = `${baseDep}::${loc}`;
    setStoppingKey(key);
    try {
      await previewApi.teardownRemote(projectId, baseDep, loc);
      notify.success('Preview stopped.');
      refreshRemotePreviews();
    } catch (e: any) {
      notify.error(`Stop failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setStoppingKey(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content className="fixed right-0 top-0 z-50 h-full w-[520px] max-w-[95vw] bg-white shadow-2xl border-l border-gray-200 flex flex-col">
          <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
            <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <Layers className="w-4 h-4" /> Drafts
            </Dialog.Title>
            <div className="flex items-center gap-1">
              <button
                onClick={refreshPrStatuses}
                disabled={refreshingPr || drafts.filter((d) => d.status === 'promoted').length === 0}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 border border-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Refresh PR live state (open / closed / merged) from GitHub"
              >
                {refreshingPr ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                <span>PRs</span>
              </button>
              <button
                onClick={() => setSettingsOpen(true)}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 border border-gray-200"
                title="GitHub integration — PAT + repo mappings for local preview + promote"
              >
                <Settings className="w-3.5 h-3.5" />
                <span>GitHub</span>
              </button>
              <Dialog.Close className="rounded p-1 text-gray-500 hover:bg-gray-100">
                <X className="w-4 h-4" />
              </Dialog.Close>
            </div>
          </div>
          <Dialog.Description className="px-5 py-2 text-xs text-gray-500 border-b border-gray-100">
            Component instances authored in Designer, pending PR promotion. Nothing here has hit the target code location.
          </Dialog.Description>
          {remotePreviews.length > 0 && (
            <div className="px-4 py-2 border-b border-gray-100 bg-sky-50/60">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Radio className="w-3 h-3 text-sky-700 animate-pulse" />
                <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-800">
                  Active preview{remotePreviews.length === 1 ? '' : 's'} ({remotePreviews.length})
                </span>
              </div>
              <ul className="space-y-1">
                {remotePreviews.map((p) => {
                  const key = `${p.base_deployment}::${p.location_name}`;
                  const stopping = stoppingKey === key;
                  return (
                    <li key={key} className="flex items-center gap-1.5 text-[11px]">
                      <a
                        href={p.webserver_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-1 min-w-0 truncate text-sky-900 hover:underline"
                        title={`${p.base_deployment} / ${p.location_name}`}
                      >
                        <span className="font-medium">{p.base_deployment.slice(0, 12)}…</span>
                        <span className="text-sky-700"> / {p.location_name}</span>
                        {' '}
                        <span className="text-sky-600">({p.draft_count} draft{p.draft_count === 1 ? '' : 's'})</span>
                        {p.fresh_bd_created === false && (
                          <span className="ml-1 text-[10px] px-1 py-0 rounded bg-white border border-sky-300 text-sky-800">
                            attached
                          </span>
                        )}
                      </a>
                      <button
                        onClick={() => handleStopRemote(p.base_deployment, p.location_name)}
                        disabled={stopping}
                        className="p-0.5 rounded hover:bg-sky-100 text-sky-800 disabled:opacity-50"
                        title={p.fresh_bd_created ? 'Stop preview (deletes the BD Designer created)' : 'Detach preview (leaves BD state on the target BD)'}
                      >
                        {stopping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-6 flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading drafts…
              </div>
            ) : error ? (
              <div className="p-6 text-sm text-red-700">{error}</div>
            ) : drafts.length === 0 ? (
              <div className="p-6 text-sm text-gray-500">
                <FileEdit className="w-6 h-6 mb-2 opacity-40" />
                No drafts yet. Use <span className="font-medium">+ Add component</span> in the header to author one.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {drafts.map((d) => {
                  const expanded = expandedId === d.id;
                  const locLabel = d.location_name === SANDBOX_LOCATION_NAME ? 'Sandbox' : d.location_name;
                  return (
                    <li key={d.id} className="px-4 py-3 hover:bg-gray-50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 truncate">{d.component_id}</div>
                          <div className="text-[11px] text-gray-500 truncate">{d.component_type}</div>
                          <div className="mt-1 flex items-center gap-2 text-[11px]">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                              {locLabel}
                            </span>
                            {d.status === 'promoted' && d.promoted_pr_url && (() => {
                              const st = prStatuses[d.id]?.state;
                              const label = st === 'merged' ? 'Merged'
                                : st === 'closed' ? 'PR closed'
                                : st === 'deleted' ? 'PR deleted'
                                : 'Promoted';
                              const tone = st === 'merged' ? 'text-emerald-700'
                                : st === 'closed' || st === 'deleted' ? 'text-red-700'
                                : 'text-emerald-700';
                              return (
                                <a
                                  href={d.promoted_pr_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className={`inline-flex items-center gap-0.5 hover:underline ${tone}`}
                                  title={prStatuses[d.id]?.message}
                                >
                                  {label} <ExternalLink className="w-3 h-3" />
                                </a>
                              );
                            })()}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {(() => {
                            const preview = previewForDraft(d.deployment_name, d.location_name);
                            const key = `${d.deployment_name}::${d.location_name}`;
                            const booting = bootingKey === key;
                            if (preview?.status === 'ready' && preview.webserver_url) {
                              return (
                                <a
                                  href={preview.webserver_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 hover:bg-emerald-100"
                                  title={`Laptop preview running on port ${preview.port}`}
                                >
                                  Local ↗
                                </a>
                              );
                            }
                            const inFlight = booting || (preview && !['ready','error','idle'].includes(preview.status));
                            return (
                              <button
                                onClick={() => handlePreview(d)}
                                disabled={!!inFlight || !d.deployment_name}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60 disabled:cursor-not-allowed"
                                title="Boot a laptop `dagster dev` against a cloned worktree of the target repo"
                              >
                                {inFlight ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Play className="w-3 h-3" />
                                )}
                                {inFlight ? (preview?.status ?? '…') : 'Local'}
                              </button>
                            );
                          })()}
                          {(() => {
                            const key = `${d.deployment_name}::${d.location_name}`;
                            const booting = bootingRemoteKey === key;
                            const syncing = syncingKey === key;
                            const remote = remotePreviewForDraft(d.deployment_name, d.location_name);
                            // Once a preview is live, show a green "Open" link
                            // + explicit Sync button (Astronomer-style — no more
                            // implicit re-apply on every button click).
                            if (remote) {
                              return (
                                <>
                                  <a
                                    href={remote.webserver_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 hover:bg-emerald-100"
                                    title={`Cloud preview running (${remote.bd_name.slice(0, 12)}…)`}
                                  >
                                    <Cloud className="w-3 h-3" /> Open ↗
                                  </a>
                                  <button
                                    onClick={() => handleSyncRemote(d)}
                                    disabled={syncing}
                                    className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-60 disabled:cursor-not-allowed"
                                    title="Re-apply the current draft set to the running preview"
                                  >
                                    {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                    {syncing ? 'Syncing…' : 'Sync'}
                                  </button>
                                </>
                              );
                            }
                            return (
                              <button
                                onClick={() => handleRemotePreview(d)}
                                disabled={booting || !d.deployment_name}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-60 disabled:cursor-not-allowed"
                                title="Provision a Dagster+ preview (reuses base image, applies drafts via state)"
                              >
                                {booting ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Cloud className="w-3 h-3" />
                                )}
                                {booting ? 'Booting…' : 'Cloud'}
                              </button>
                            );
                          })()}
                          {(() => {
                            const promoted = d.status === 'promoted' && d.promoted_pr_url;
                            const st = promoted ? prStatuses[d.id]?.state : undefined;
                            // Open PR: link out. Merged: link out with green
                            // check tone. Closed / deleted: nudge user to
                            // re-promote (opens a fresh PR against the same
                            // target with a fresh branch name).
                            if (promoted && st === 'open') {
                              return (
                                <a
                                  href={d.promoted_pr_url!}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 hover:bg-emerald-100"
                                  title={prStatuses[d.id]?.message}
                                >
                                  Open PR <ExternalLink className="w-3 h-3" />
                                </a>
                              );
                            }
                            if (promoted && st === 'merged') {
                              return (
                                <a
                                  href={d.promoted_pr_url!}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                                  title={prStatuses[d.id]?.message}
                                >
                                  Merged <ExternalLink className="w-3 h-3" />
                                </a>
                              );
                            }
                            if (promoted && (st === 'closed' || st === 'deleted')) {
                              return (
                                <button
                                  onClick={() => handlePromote(d.id)}
                                  disabled={promotingId === d.id}
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60 disabled:cursor-not-allowed"
                                  title={`${prStatuses[d.id]?.message ?? ''} Click to open a fresh PR.`}
                                >
                                  {promotingId === d.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <GitPullRequest className="w-3 h-3" />
                                  )}
                                  {promotingId === d.id ? 'Promoting…' : 'Re-promote'}
                                </button>
                              );
                            }
                            if (promoted) {
                              // Promoted locally but no live state yet — the
                              // status poll hasn't returned. Fall back to
                              // the old link so we're never worse than before.
                              return (
                                <a
                                  href={d.promoted_pr_url!}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 hover:bg-emerald-100"
                                >
                                  Open PR <ExternalLink className="w-3 h-3" />
                                </a>
                              );
                            }
                            return (
                              <button
                                onClick={() => handlePromote(d.id)}
                                disabled={promotingId === d.id}
                                className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed"
                                title="Open a PR against the target repo"
                              >
                                {promotingId === d.id ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <GitPullRequest className="w-3 h-3" />
                                )}
                                {promotingId === d.id ? 'Promoting…' : 'Promote'}
                              </button>
                            );
                          })()}
                          <button
                            onClick={() => setExpandedId(expanded ? null : d.id)}
                            className="text-[11px] px-2 py-1 rounded hover:bg-gray-200 text-gray-600"
                          >
                            {expanded ? 'Hide YAML' : 'View YAML'}
                          </button>
                          <button
                            onClick={() => handleDelete(d.id)}
                            className="text-[11px] p-1 rounded hover:bg-red-50 text-red-600"
                            title="Delete draft"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      {expanded && (
                        <pre className="mt-2 max-h-72 overflow-auto bg-gray-50 border border-gray-200 rounded p-2 text-[11px] leading-snug font-mono whitespace-pre-wrap">
                          {d.attributes}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <PromotionSettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Dialog.Root>
  );
}
