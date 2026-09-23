import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Rocket, Loader2 } from 'lucide-react';
import { projectsApi } from '@/services/api';
import { notify, confirmDialog } from './Notifications';

/**
 * Publish a plain LOCAL project straight to a Dagster+ Serverless
 * deployment, skipping git entirely. The Dagster+-connected version of
 * this (SandboxStatusPill's "Publish sandbox directly to Serverless")
 * already knows the org/token/deployment from the project record; a
 * local project has none of that, so this collects it inline instead —
 * one-shot, not persisted (this dialog forgets it as soon as it closes;
 * the *stored* GitHub PAT elsewhere in Settings is a different token
 * for a different purpose, this one's the Dagster+ API token).
 */
interface PublishServerlessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
}

export function PublishServerlessDialog({ open, onOpenChange, projectId, projectName }: PublishServerlessDialogProps) {
  const [organization, setOrganization] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [deployment, setDeployment] = useState('');
  const [locationName, setLocationName] = useState('');
  const [publishing, setPublishing] = useState(false);

  const canSubmit = organization.trim() && apiToken.trim() && deployment.trim() && !publishing;

  const handlePublish = async () => {
    if (!canSubmit) return;
    const ok = await confirmDialog(
      'Pushes this project straight to a Serverless deployment — no commit, no PR, no review, no CI. Anyone else on this deployment will see it immediately.',
      { title: 'Publish directly to Serverless?', destructive: true },
    );
    if (!ok) return;
    setPublishing(true);
    try {
      const r = await projectsApi.publishServerless(projectId, {
        organization: organization.trim(),
        api_token: apiToken.trim(),
        deployment: deployment.trim(),
        location_name: locationName.trim() || undefined,
      });
      notify.success(`Published to Serverless location "${r.location_name}" on ${r.deployment}.`);
      onOpenChange(false);
    } catch (e: any) {
      notify.error(`Publish failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-[480px] max-w-[95vw] flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <Dialog.Title className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Rocket className="w-5 h-5 text-amber-600" />
              Publish to Dagster+
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="p-2 hover:bg-gray-100 rounded-lg" aria-label="Close">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </Dialog.Close>
          </div>

          <div className="p-6 space-y-3">
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              Skips git entirely — no commit, no PR, no review. Discouraged for anything but a demo you're going to throw away.
              Nothing here is saved; you'll enter this again next time.
            </p>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Organization</label>
              <input
                type="text"
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                placeholder="your-org"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Deployment</label>
              <input
                type="text"
                value={deployment}
                onChange={(e) => setDeployment(e.target.value)}
                placeholder="prod"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Dagster+ API token</label>
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="dagster_cloud_api_token..."
                className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-[10px] text-gray-500 mt-0.5">From Dagster+ org settings → Tokens. Not saved anywhere.</p>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 block">Location name (optional)</label>
              <input
                type="text"
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
                placeholder={`designer-${projectName.toLowerCase().replace(/\s+/g, '-')}`}
                className="w-full px-2 py-1.5 text-sm font-mono border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="border-t border-gray-200 px-6 py-3 flex items-center justify-end gap-2 flex-shrink-0">
            <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">
              Cancel
            </button>
            <button
              onClick={handlePublish}
              disabled={!canSubmit}
              className="px-4 py-1.5 text-sm font-medium bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
              {publishing ? 'Publishing…' : 'Publish now'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
