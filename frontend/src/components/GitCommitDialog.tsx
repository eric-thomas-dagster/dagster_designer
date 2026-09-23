import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, GitCommit, Loader2, GitBranch, ArrowUp, ArrowDown } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';
import { Notice } from './Notice';

interface GitCommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Optional subpath — targets a nested repo (e.g. a cloned dbt
   *  project inside the project root). Defaults to the project root. */
  subpath?: string;
  /** Sensible default commit message to pre-fill. */
  defaultMessage?: string;
  /** Pre-fills the "create GitHub repo" name when there's no repo yet.
   *  Sanitized into a slug; the user can still edit it. */
  defaultRepoName?: string;
}

const slugify = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'dagster-project';

export function GitCommitDialog({ open, onOpenChange, projectId, subpath, defaultMessage, defaultRepoName }: GitCommitDialogProps) {
  const [status, setStatus] = useState<{
    is_git_repo: boolean;
    branch: string | null;
    ahead: number;
    behind: number;
    modified: string[];
    untracked: string[];
    staged: string[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(defaultMessage || '');
  const [token, setToken] = useState('');
  const [pushToRemote, setPushToRemote] = useState(true);
  // 'direct' = push straight to whatever's checked out (usually main) —
  // fine when you have write access and don't need review. 'pr' = branch
  // off, push the branch, open a PR against the branch you started on.
  // Also what plays nicely with Dagster's own GitHub Actions CI template,
  // which runs on PRs (branch deployment checks etc.) — a direct push to
  // main skips all of that.
  const [pushMode, setPushMode] = useState<'direct' | 'pr'>('direct');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [creatingRemote, setCreatingRemote] = useState(false);

  const refreshStatus = () => {
    setLoading(true);
    return projectsApi.projectGitStatus(projectId, subpath).then((r) => {
      setStatus(r);
      // Pre-select every dirty file so the common case (commit everything)
      // is one click. Users deselect anything they want to leave behind.
      setSelectedFiles(new Set([...r.modified, ...r.untracked, ...r.staged]));
      setLoading(false);
      return r;
    });
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    refreshStatus().catch((e) => {
      if (cancelled) return;
      notify.error(`git status failed: ${e?.message ?? e}`);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, subpath]);

  useEffect(() => { setMessage(defaultMessage || ''); }, [defaultMessage, open]);
  useEffect(() => { setRepoName(slugify(defaultRepoName || '')); }, [defaultRepoName, open]);

  const handleCreateRemote = async () => {
    if (!repoName.trim()) return;
    setCreatingRemote(true);
    try {
      const r = await projectsApi.projectGitCreateRemote(projectId, {
        subpath: subpath || null,
        repo_name: repoName.trim(),
        private: repoPrivate,
        token: token.trim() || null,
      });
      notify.success(r.created ? `Created ${r.html_url} and set it as origin.` : `Connected existing ${r.html_url} as origin.`);
      await refreshStatus();
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || String(e);
      notify.error(`Couldn't create GitHub repo: ${msg}`);
      setLoading(false);
    } finally {
      setCreatingRemote(false);
    }
  };

  const toggle = (f: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  const handleCommit = async () => {
    if (!status?.is_git_repo || selectedFiles.size === 0 || !message.trim()) return;
    const openPr = pushToRemote && pushMode === 'pr';
    setSaving(true);
    try {
      const r = await projectsApi.projectGitCommitPush(projectId, {
        subpath: subpath || null,
        files: Array.from(selectedFiles),
        message,
        token: token.trim() || null,
        push: pushToRemote,
        open_pr: openPr,
      });
      if (r.pr_url) {
        notify.success(`Committed ${r.committed_sha} and opened a PR from ${r.branch}.`);
        window.open(r.pr_url, '_blank', 'noopener,noreferrer');
      } else if (r.pushed) {
        notify.success(`Committed ${r.committed_sha} and pushed to ${r.branch ?? 'origin'}.`);
      } else {
        notify.success(`Committed ${r.committed_sha} locally.`);
      }
      onOpenChange(false);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || String(e);
      notify.error(`Commit failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const totalChanges = status ? status.modified.length + status.untracked.length + status.staged.length : 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[640px] max-w-[95vw] max-h-[85vh] flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div>
              <Dialog.Title className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <GitCommit className="w-5 h-5 text-primary" />
                Commit changes
              </Dialog.Title>
              <p className="text-sm text-gray-500 mt-0.5">
                {subpath ? <>Repo at <code className="bg-gray-100 px-1 rounded">{subpath}</code></> : 'Project root repo'}
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Close">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="w-4 h-4 animate-spin" />
                Reading git status…
              </div>
            )}
            {!loading && status?.is_git_repo === false && (
              <div className="space-y-3">
                <Notice>This directory isn't a git repository yet — create a GitHub repo to push to, or connect one below.</Notice>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">GitHub repo name</label>
                  <input
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="my-dagster-project"
                    className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={repoPrivate}
                    onChange={(e) => setRepoPrivate(e.target.checked)}
                    className="w-4 h-4"
                  />
                  Private repository
                </label>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">GitHub token</label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="ghp_… — leave blank to use the configured token"
                    className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <button
                  onClick={handleCreateRemote}
                  disabled={creatingRemote || !repoName.trim()}
                  className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                >
                  {creatingRemote ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitBranch className="w-3.5 h-3.5" />}
                  {creatingRemote ? 'Creating…' : 'Initialize & create GitHub repo'}
                </button>
              </div>
            )}
            {!loading && status?.is_git_repo && (
              <>
                {/* Branch + ahead/behind indicator */}
                <div className="flex items-center gap-3 text-sm">
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded">
                    <GitBranch className="w-3.5 h-3.5 text-gray-500" />
                    <span className="font-mono">{status.branch ?? '(detached)'}</span>
                  </div>
                  {status.ahead > 0 && (
                    <span className="inline-flex items-center gap-1 text-emerald-700 text-xs">
                      <ArrowUp className="w-3 h-3" /> {status.ahead} ahead
                    </span>
                  )}
                  {status.behind > 0 && (
                    <span className="inline-flex items-center gap-1 text-amber-700 text-xs">
                      <ArrowDown className="w-3 h-3" /> {status.behind} behind
                    </span>
                  )}
                  <span className="ml-auto text-xs text-gray-500">{totalChanges} changed file{totalChanges === 1 ? '' : 's'}</span>
                </div>

                {/* File selector */}
                {totalChanges === 0 ? (
                  <div className="p-3 bg-gray-50 border border-gray-200 rounded text-sm text-gray-600">
                    Nothing to commit — working tree is clean.
                  </div>
                ) : (
                  <div className="border border-gray-200 rounded max-h-56 overflow-y-auto">
                    <FileSection label="Staged" files={status.staged} selected={selectedFiles} onToggle={toggle} tone="text-emerald-700" />
                    <FileSection label="Modified" files={status.modified} selected={selectedFiles} onToggle={toggle} tone="text-blue-700" />
                    <FileSection label="Untracked" files={status.untracked} selected={selectedFiles} onToggle={toggle} tone="text-gray-600" />
                  </div>
                )}

                {/* Commit message */}
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Commit message</label>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={3}
                    placeholder="Add stg_orders model"
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Push toggle + mode + token */}
                <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={pushToRemote}
                    onChange={(e) => setPushToRemote(e.target.checked)}
                    className="w-4 h-4"
                  />
                  Push to <code className="bg-gray-100 px-1 rounded">origin</code> after committing
                </label>

                {pushToRemote && (
                  <div className="pl-6 space-y-2">
                    <div className="flex flex-col gap-1.5">
                      <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-700">
                        <input
                          type="radio"
                          checked={pushMode === 'direct'}
                          onChange={() => setPushMode('direct')}
                          className="w-4 h-4 mt-0.5"
                        />
                        <span>
                          Push directly to <code className="bg-gray-100 px-1 rounded">{status.branch ?? 'the current branch'}</code>
                          <span className="block text-xs text-gray-500">No review step — use when you have write access and this is safe to land as-is.</span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-700">
                        <input
                          type="radio"
                          checked={pushMode === 'pr'}
                          onChange={() => setPushMode('pr')}
                          className="w-4 h-4 mt-0.5"
                        />
                        <span>
                          Open a pull request
                          <span className="block text-xs text-gray-500">
                            Branches off {status.branch ?? 'the current branch'}, pushes there, and opens a PR — runs any
                            GitHub Actions CI the repo has configured before it lands.
                          </span>
                        </span>
                      </label>
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">
                        GitHub token (needed for private repos{pushMode === 'pr' ? ' and opening the PR' : ''})
                      </label>
                      <input
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="ghp_… — leave blank to use the configured token"
                        className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <p className="text-[10px] text-gray-500 mt-0.5">
                        Not persisted anywhere — used once for this push and dropped.
                      </p>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="border-t border-gray-200 px-6 py-3 flex items-center justify-end gap-2 flex-shrink-0">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">
              Cancel
            </button>
            <button
              onClick={handleCommit}
              disabled={saving || !status?.is_git_repo || selectedFiles.size === 0 || !message.trim() || totalChanges === 0}
              className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GitCommit className="w-3.5 h-3.5" />}
              {saving
                ? (pushMode === 'pr' && pushToRemote ? 'Opening PR…' : 'Committing…')
                : pushToRemote
                  ? (pushMode === 'pr' ? 'Commit & open PR' : 'Commit & push')
                  : 'Commit'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FileSection({
  label,
  files,
  selected,
  onToggle,
  tone,
}: {
  label: string;
  files: string[];
  selected: Set<string>;
  onToggle: (f: string) => void;
  tone: string;
}) {
  if (files.length === 0) return null;
  return (
    <div>
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-50 border-b border-gray-100">
        {label} ({files.length})
      </div>
      {files.map((f) => (
        <label key={f} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 border-b border-gray-50 last:border-0 cursor-pointer text-sm">
          <input
            type="checkbox"
            checked={selected.has(f)}
            onChange={() => onToggle(f)}
            className="w-3.5 h-3.5"
          />
          <span className={`font-mono text-xs truncate ${tone}`} title={f}>{f}</span>
        </label>
      ))}
    </div>
  );
}
