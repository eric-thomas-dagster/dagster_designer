import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Cloud, Loader2, CheckCircle2, XCircle, ExternalLink, Info, Eye, EyeOff } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify } from './Notifications';

interface ConnectDagsterPlusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: (project: { id: string; name: string }) => void;
}

/**
 * "Open a Dagster+ environment" — creates a project record backed by
 * a live Dagster+ deployment. The rest of the app reads from the
 * GraphQL API instead of local files when a project is flagged
 * is_dagster_plus.
 *
 * Users provide:
 *   • org (subdomain — e.g. `acme` or `acme.dagster.plus`)
 *   • deployment (usually `prod`)
 *   • token (a Dagster+ user token with read scope)
 *   • optional display name + location filter
 *
 * The dialog has a "Test connection" affordance so users get a
 * ping/pong before we persist anything.
 */
export function ConnectDagsterPlusDialog({ open, onOpenChange, onConnected }: ConnectDagsterPlusDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [org, setOrg] = useState('');
  const [deployment, setDeployment] = useState('');
  const [token, setToken] = useState('');
  const [location, setLocation] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; version?: string | null; detail?: string | null } | null>(null);

  const reset = () => {
    setName(''); setDescription(''); setOrg(''); setDeployment('prod'); setToken('');
    setLocation(''); setTesting(false); setConnecting(false); setTestResult(null);
    setShowToken(false);
  };

  const testConn = async () => {
    if (!org.trim() || !token.trim()) {
      notify.error('Enter an org and token before testing.');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await projectsApi.testDagsterPlusConnection({
        name: name.trim() || org.trim(),
        description: description.trim() || undefined,
        org: org.trim(),
        deployment: deployment.trim() || 'prod',
        token: token.trim(),
        location: location.trim() || undefined,
      });
      setTestResult(r);
    } catch (e: any) {
      setTestResult({ ok: false, detail: e?.response?.data?.detail || e?.message || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const connect = async () => {
    if (!org.trim() || !token.trim()) {
      notify.error('Enter an org and token.');
      return;
    }
    setConnecting(true);
    try {
      const proj = await projectsApi.connectDagsterPlus({
        name: name.trim() || `${org.trim()} (${deployment.trim() || 'prod'})`,
        description: description.trim() || undefined,
        org: org.trim(),
        deployment: deployment.trim() || 'prod',
        token: token.trim(),
        location: location.trim() || undefined,
      });
      notify.success(`Connected to ${proj.dagster_plus_org} · ${proj.dagster_plus_deployment}`);
      onConnected?.(proj);
      onOpenChange(false);
      reset();
    } catch (e: any) {
      notify.error(e?.response?.data?.detail || e?.message || 'Failed to connect.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl w-[640px] max-w-[96vw] max-h-[92vh] flex flex-col overflow-hidden z-50">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-b from-white to-gray-50/50">
            <div>
              <Dialog.Title className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center">
                  <Cloud className="w-4 h-4 text-white" />
                </div>
                Open a Dagster+ environment
              </Dialog.Title>
              <p className="text-xs text-gray-500 mt-0.5 ml-10">
                Point Dagster Designer at a live Dagster+ deployment. Lineage, monitors, and runs pull from the deployment's GraphQL API.
              </p>
            </div>
            <Dialog.Close className="p-1.5 hover:bg-gray-100 rounded text-gray-400 hover:text-gray-700">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <div className="p-5 overflow-y-auto flex-1 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Display name</label>
                <input
                  value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Acme Production"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="text-[10px] text-gray-500 mt-0.5">How this appears in your project list. Leave blank to use the org.</p>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Organization</label>
                <input
                  value={org} onChange={(e) => setOrg(e.target.value)}
                  placeholder="acme (or acme.dagster.plus)"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Deployment (optional)</label>
                <input
                  value={deployment} onChange={(e) => setDeployment(e.target.value)}
                  placeholder="leave blank for default"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <p className="text-[10px] text-gray-500 mt-0.5">Empty → uses the org's default deployment.</p>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">
                  User token{token && (
                    <span className="ml-1 normal-case tracking-normal text-gray-400">· {token.length} chars</span>
                  )}
                </label>
                <div className="relative">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={token} onChange={(e) => setToken(e.target.value)}
                    placeholder="user:hexstring..."
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full pl-3 pr-10 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-700"
                    title={showToken ? 'Hide token' : 'Show token'}
                    aria-label={showToken ? 'Hide token' : 'Show token'}
                  >
                    {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[10px] text-gray-500 mt-0.5 inline-flex items-center gap-1">
                  <Info className="w-3 h-3" />
                  Create one at&nbsp;
                  <a
                    href={`https://${(org || 'ORG').replace('.dagster.cloud', '').replace('.dagster.plus', '').split('/')[0]}.dagster.cloud/settings/tokens`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline inline-flex items-center gap-0.5"
                  >
                    Settings → Tokens
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                  &nbsp;— tokens look like <code className="bg-gray-100 px-1 rounded">user:hex</code>. Read scope is enough. Stored server-side only.
                </p>
              </div>
              <div className="col-span-2">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Description (optional)</label>
                <input
                  value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this deployment is for"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Location filter (optional)</label>
                <input
                  value={location} onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. my_code_location — leave blank for all"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            {testResult && (
              <div className={`p-3 rounded flex items-start gap-2 text-xs ${
                testResult.ok
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border border-rose-200 text-rose-800'
              }`}>
                {testResult.ok ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                <div>
                  {testResult.ok ? (
                    <>
                      <div className="font-semibold">Connected!</div>
                      <div className="mt-0.5">Dagster version <span className="font-mono">{testResult.version}</span>. Ready to save.</div>
                    </>
                  ) : (
                    <>
                      <div className="font-semibold">Couldn't connect</div>
                      <div className="mt-0.5">{testResult.detail}</div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-2">
            <button
              onClick={testConn}
              disabled={testing || !org.trim() || !token.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <div className="flex items-center gap-2">
              <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
              <button
                onClick={connect}
                disabled={connecting || !org.trim() || !token.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white rounded bg-gradient-to-br from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 disabled:opacity-50"
              >
                {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
                {connecting ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
