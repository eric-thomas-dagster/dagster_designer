import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, GitBranch, FileCode, Loader2 } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface AddDbtProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onAdded?: (relativePath: string) => void;
}

type Mode = 'clone' | 'scaffold';

/**
 * Dialog for adding a new dbt project to the current Dagster project.
 * Two modes:
 *   • Clone from git — for existing dbt repos (public or private-with-PAT)
 *   • Scaffold new — writes a starter dbt_project.yml + my_first_model.sql
 *     so users see something in the graph immediately
 */
export function AddDbtProjectDialog({ open, onOpenChange, projectId, onAdded }: AddDbtProjectDialogProps) {
  const [mode, setMode] = useState<Mode>('clone');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [subpath, setSubpath] = useState('');
  const [adapter, setAdapter] = useState<'duckdb' | 'snowflake' | 'bigquery' | 'postgres' | 'redshift'>('duckdb');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setMode('clone');
    setName('');
    setGitUrl('');
    setGitBranch('');
    setGitToken('');
    setSubpath('');
    setAdapter('duckdb');
    setSubmitting(false);
  };

  // Auto-fill the folder name from the git URL's repo slug when the
  // user pastes a URL and hasn't typed a name yet — one less field.
  const onGitUrlChange = (v: string) => {
    setGitUrl(v);
    if (!name) {
      const m = v.match(/\/([^\/]+?)(?:\.git)?$/);
      if (m) setName(m[1]);
    }
  };

  const submit = async () => {
    if (!name.trim()) {
      notify.error('Project name is required.');
      return;
    }
    if (mode === 'clone' && !gitUrl.trim()) {
      notify.error('Git URL is required for clone mode.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await projectsApi.addDbtProject(projectId, {
        mode,
        name: name.trim(),
        git_url: mode === 'clone' ? gitUrl.trim() : undefined,
        git_token: mode === 'clone' && gitToken.trim() ? gitToken.trim() : undefined,
        git_branch: mode === 'clone' && gitBranch.trim() ? gitBranch.trim() : undefined,
        subpath: mode === 'clone' && subpath.trim() ? subpath.trim() : undefined,
        adapter: mode === 'scaffold' ? adapter : undefined,
      });
      notify.success(r.message || `Added ${r.relative_path}`);
      onAdded?.(r.relative_path);
      onOpenChange(false);
      reset();
    } catch (e: any) {
      const status = e?.response?.status;
      const detail = e?.response?.data?.detail;
      if (status === 404 && (!detail || /not found/i.test(detail))) {
        notify.error("Endpoint not found — restart the backend so the new dbt-project endpoints load.");
      } else {
        notify.error(detail || e?.message || 'Failed to add dbt project.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-2xl w-[560px] max-w-[95vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
              <FileCode className="w-5 h-5 text-orange-500" />
              Add dbt project
            </Dialog.Title>
            <Dialog.Close className="p-1 hover:bg-gray-100 rounded">
              <X className="w-4 h-4 text-gray-500" />
            </Dialog.Close>
          </div>

          {/* Mode toggle */}
          <div className="px-5 pt-4 flex items-center gap-1 bg-gray-50 border-b border-gray-100">
            {(['clone', 'scaffold'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                  mode === m
                    ? 'text-blue-600 border-blue-600'
                    : 'text-gray-600 border-transparent hover:text-gray-900'
                }`}
              >
                {m === 'clone' ? <GitBranch className="w-4 h-4" /> : <FileCode className="w-4 h-4" />}
                {m === 'clone' ? 'Clone from git' : 'Scaffold new'}
              </button>
            ))}
          </div>

          <div className="p-5 space-y-4 overflow-y-auto flex-1">
            {mode === 'clone' && (
              <>
                <Field label="Git URL" hint="HTTPS or git@ URL — for private repos, add a PAT below.">
                  <input
                    value={gitUrl}
                    onChange={(e) => onGitUrlChange(e.target.value)}
                    placeholder="https://github.com/dbt-labs/jaffle_shop.git"
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
                <Field label="Folder name" hint="Where to place the clone under the Dagster project.">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="jaffle_shop"
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Branch (optional)">
                    <input
                      value={gitBranch}
                      onChange={(e) => setGitBranch(e.target.value)}
                      placeholder="main"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </Field>
                  <Field label="Subpath (optional)" hint="If dbt_project.yml is nested.">
                    <input
                      value={subpath}
                      onChange={(e) => setSubpath(e.target.value)}
                      placeholder="dbt/"
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </Field>
                </div>
                <Field label="Personal access token (optional)" hint="For private GitHub repos — kept in-memory, not persisted.">
                  <input
                    type="password"
                    value={gitToken}
                    onChange={(e) => setGitToken(e.target.value)}
                    placeholder="ghp_..."
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
              </>
            )}

            {mode === 'scaffold' && (
              <>
                <Field label="Project name" hint="Used for the folder + dbt_project.yml's `name:` field.">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="my_dbt"
                    className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </Field>
                <Field label="Adapter" hint="Which warehouse to target. Only affects a README hint — actual connection lives in ~/.dbt/profiles.yml.">
                  <select
                    value={adapter}
                    onChange={(e) => setAdapter(e.target.value as any)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="duckdb">DuckDB (local, no setup)</option>
                    <option value="snowflake">Snowflake</option>
                    <option value="bigquery">BigQuery</option>
                    <option value="postgres">Postgres</option>
                    <option value="redshift">Redshift</option>
                  </select>
                </Field>
                <div className="p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
                  We'll write a starter <code className="bg-white px-1 rounded">dbt_project.yml</code> plus a
                  <code className="bg-white px-1 rounded">models/example/my_first_model.sql</code> so the project
                  is runnable right away. Configure your warehouse connection in <code className="bg-white px-1 rounded">~/.dbt/profiles.yml</code> before running <code>dbt build</code>.
                </div>
              </>
            )}
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button
              onClick={() => onOpenChange(false)}
              className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : mode === 'clone' ? <GitBranch className="w-4 h-4" /> : <FileCode className="w-4 h-4" />}
              {submitting ? (mode === 'clone' ? 'Cloning…' : 'Scaffolding…') : mode === 'clone' ? 'Clone project' : 'Scaffold project'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
