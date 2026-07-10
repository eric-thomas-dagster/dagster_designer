import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { DiffEditor } from '@monaco-editor/react';
import { X, GitCommit, Loader2 } from 'lucide-react';
import { projectsApi } from '@/services/api';

interface SqlDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  dbtRelativePath: string;
  relativeSqlPath: string;
  title?: string;
}

/**
 * Side-by-side SQL diff — working copy vs HEAD-committed version.
 * Uses Monaco's built-in DiffEditor for actual gutter-marked diffs
 * (no eyeballing). Refreshes on every open so the diff reflects the
 * latest on-disk state.
 */
export function SqlDiffDialog({ open, onOpenChange, projectId, dbtRelativePath, relativeSqlPath, title }: SqlDiffDialogProps) {
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof projectsApi.getDbtModelDiff>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    projectsApi.getDbtModelDiff(projectId, dbtRelativePath, relativeSqlPath).then((r) => {
      if (cancelled) return;
      setDiff(r);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(e?.response?.data?.detail || e?.message || String(e));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, projectId, dbtRelativePath, relativeSqlPath]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[95vw] h-[85vh] max-w-[1200px] flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <GitCommit className="w-5 h-5 text-primary" />
                SQL diff · {title || relativeSqlPath}
              </Dialog.Title>
              {diff && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {diff.is_dirty ? (
                    <span className="text-amber-700">Uncommitted changes vs HEAD ({diff.committed_sha ?? '—'})</span>
                  ) : (
                    <span className="text-emerald-700">Working copy matches HEAD ({diff.committed_sha ?? '—'})</span>
                  )}
                </p>
              )}
            </div>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Close">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex-1 p-3 min-h-0">
            {loading && (
              <div className="h-full flex items-center justify-center text-sm text-gray-500 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading diff…
              </div>
            )}
            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-800">{error}</div>
            )}
            {diff && !loading && !error && (
              <DiffEditor
                original={diff.committed}
                modified={diff.current}
                language="sql"
                theme="vs-light"
                options={{
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  readOnly: true,
                  originalEditable: false,
                }}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
