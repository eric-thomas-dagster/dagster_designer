import { useEffect, useRef, useState } from 'react';
import { Boxes, Loader2, AlertTriangle, CheckCircle2, ChevronDown, GitPullRequestArrow, Rocket } from 'lucide-react';
import {
  designerLocApi,
  authoredApi,
  draftsApi,
  type AuthoredDeployment,
  type AuthoredLocation,
  type DesignerLocStatus,
} from '@/services/api';
import { notify } from './Notifications';

/**
 * SandboxStatusPill — a small header indicator for the Designer-managed
 * code location subprocess on Dagster+ projects.
 *
 * The subprocess is a peer data source (not a mode), so this pill is
 * purely informational: it tells the user whether the sandbox is
 * ready to accept authored components (M2). Clicking expands a
 * popover with boot detail for debugging.
 *
 * `status` is owned by the caller (a single lifted useDesignerLoc, see
 * App.tsx) rather than polled here directly -- this component used to
 * call the hook itself, but a second, more prominent indicator
 * (App.tsx's loading overlay) needs the same status too, and two
 * independent hook instances would each poll /status and call /ensure
 * on their own.
 */
interface SandboxStatusPillProps {
  projectId: string | null;
  isDagsterPlus: boolean;
  status: DesignerLocStatus | null;
  /** Fired after a sandbox component is successfully turned into a
   *  Draft against a real target — caller opens the Drafts panel so
   *  the user lands somewhere that shows what just happened. */
  onPromoted?: () => void;
}

export function SandboxStatusPill({ projectId, isDagsterPlus, status, onPromoted }: SandboxStatusPillProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // "Promote to PR" — turns a sandbox-authored component instance into
  // a Draft against a REAL (deployment, location). The sandbox itself
  // has no target repo; this is the bridge. Lazily loaded only when the
  // promote section is opened, not on every pill render.
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [components, setComponents] = useState<{ component_id: string; component_type: string; attributes_yaml: string }[] | null>(null);
  const [selectedComponentId, setSelectedComponentId] = useState('');
  const [deployments, setDeployments] = useState<AuthoredDeployment[] | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState('');
  const [locations, setLocations] = useState<AuthoredLocation[] | null>(null);
  const [selectedLocation, setSelectedLocation] = useState('');
  const [promoting, setPromoting] = useState(false);

  useEffect(() => {
    if (!promoteOpen || !projectId) return;
    designerLocApi.listComponents(projectId).then((r) => setComponents(r.components)).catch(() => setComponents([]));
    authoredApi.deployments(projectId).then((r) => setDeployments(r.deployments)).catch(() => setDeployments([]));
  }, [promoteOpen, projectId]);

  useEffect(() => {
    if (!projectId || !selectedDeployment) { setLocations(null); setSelectedLocation(''); return; }
    setSelectedLocation('');
    authoredApi.locations(projectId, selectedDeployment)
      .then((r) => setLocations(r.locations.filter((l) => l.source !== 'sandbox')))
      .catch(() => setLocations([]));
  }, [projectId, selectedDeployment]);

  // "Publish directly" — skips git+PR entirely and pushes the sandbox's
  // current code straight to a Dagster+ Serverless deployment. Kept
  // visually secondary (own collapsed section, muted styling) since
  // it's deliberately the discouraged path: no review, no history, easy
  // to overwrite a real location by picking the wrong name. Good for a
  // demo you're about to throw away, not for anything that should last.
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishLocationName, setPublishLocationName] = useState('');
  const [publishing, setPublishing] = useState(false);

  const handlePublishServerless = async () => {
    if (!projectId) return;
    setPublishing(true);
    try {
      const r = await designerLocApi.publishServerless(projectId, publishLocationName.trim() || undefined);
      notify.success(`Published to Serverless location "${r.location_name}" on ${r.deployment}.`);
      setPublishOpen(false);
    } catch (e: any) {
      notify.error(`Publish failed: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setPublishing(false);
    }
  };

  const handlePromote = async () => {
    if (!projectId || !selectedComponentId || !selectedDeployment || !selectedLocation) return;
    const comp = components?.find((c) => c.component_id === selectedComponentId);
    if (!comp) return;
    setPromoting(true);
    try {
      await draftsApi.create(projectId, {
        location_name: selectedLocation,
        deployment_name: selectedDeployment,
        component_type: comp.component_type,
        attributes: comp.attributes_yaml,
        component_id: comp.component_id,
      });
      notify.success(`Draft created against ${selectedLocation} — open the Drafts panel to review + promote.`);
      setPromoteOpen(false);
      setSelectedComponentId('');
      setSelectedDeployment('');
      setSelectedLocation('');
      setOpen(false);
      onPromoted?.();
    } catch (e: any) {
      notify.error(`Couldn't create draft: ${e?.response?.data?.detail || e?.message || String(e)}`);
    } finally {
      setPromoting(false);
    }
  };

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!isDagsterPlus || !projectId) return null;

  const s = status?.status ?? 'missing';
  const tone = pillTone(s);
  const icon = pillIcon(s);
  const label = pillLabel(s);

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${tone}`}
        title="Designer sandbox — a laptop-hosted Dagster subprocess for safely authoring components"
      >
        {icon}
        <span>Sandbox: {label}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-[420px] bg-white border border-gray-200 rounded-md shadow-lg p-3 text-xs">
          <div className="font-semibold text-gray-900 mb-1">Designer sandbox</div>
          <p className="text-gray-600 mb-2">
            A laptop-hosted Dagster subprocess that scaffolds alongside your
            Dagster+ project. Author new components here — they merge into
            the graph as a peer data source. Nothing hits your cloud
            deployment.
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mb-2">
            <span className="text-gray-500">Status</span>
            <span className="font-mono">{s}</span>
            {status?.port && (
              <>
                <span className="text-gray-500">Port</span>
                <span className="font-mono">{status.port}</span>
              </>
            )}
            {status?.pid && (
              <>
                <span className="text-gray-500">PID</span>
                <span className="font-mono">{status.pid}</span>
              </>
            )}
            <span className="text-gray-500">Scaffolded</span>
            <span className="font-mono">{status?.scaffolded ? 'yes' : 'no'}</span>
            <span className="text-gray-500">Installed</span>
            <span className="font-mono">{status?.installed ? 'yes' : 'no'}</span>
          </div>
          {status?.error && (
            <div className="mt-2 rounded bg-red-50 border border-red-200 text-red-700 p-2">
              <div className="font-semibold text-[11px] mb-0.5">Error</div>
              <div className="whitespace-pre-wrap break-words">{status.error}</div>
            </div>
          )}
          {s === 'ready' && (
            <div className="mt-2 pt-2 border-t border-gray-200">
              <button
                onClick={() => setPromoteOpen((v) => !v)}
                className="w-full flex items-center gap-1.5 text-[11px] font-medium text-gray-700 hover:text-gray-900"
              >
                <GitPullRequestArrow className="w-3.5 h-3.5" />
                Promote a component to PR
                <ChevronDown className={`w-3 h-3 opacity-60 ml-auto transition-transform ${promoteOpen ? 'rotate-180' : ''}`} />
              </button>
              {promoteOpen && (
                <div className="mt-2 space-y-2">
                  <p className="text-gray-500">
                    Sandbox components aren't tied to a repo. Pick one, pick where it should
                    land, and Designer opens a PR — bootstrapping the community-component
                    installer into that repo first if it's not there yet.
                  </p>
                  {components === null ? (
                    <div className="flex items-center gap-1.5 text-gray-500"><Loader2 className="w-3 h-3 animate-spin" /> Loading components…</div>
                  ) : components.length === 0 ? (
                    <p className="text-gray-500 italic">No components authored in the sandbox yet.</p>
                  ) : (
                    <>
                      <select
                        value={selectedComponentId}
                        onChange={(e) => setSelectedComponentId(e.target.value)}
                        className="w-full px-2 py-1 text-[11px] border border-gray-300 rounded"
                      >
                        <option value="">Select a component…</option>
                        {components.map((c) => (
                          <option key={c.component_id} value={c.component_id}>{c.component_id}</option>
                        ))}
                      </select>
                      <select
                        value={selectedDeployment}
                        onChange={(e) => setSelectedDeployment(e.target.value)}
                        className="w-full px-2 py-1 text-[11px] border border-gray-300 rounded"
                        disabled={!deployments}
                      >
                        <option value="">{deployments ? 'Select a deployment…' : 'Loading deployments…'}</option>
                        {(deployments ?? []).map((d) => (
                          <option key={d.name} value={d.name}>{d.display_name}{d.type === 'BRANCH' ? ' (branch)' : ''}</option>
                        ))}
                      </select>
                      <select
                        value={selectedLocation}
                        onChange={(e) => setSelectedLocation(e.target.value)}
                        className="w-full px-2 py-1 text-[11px] border border-gray-300 rounded"
                        disabled={!selectedDeployment}
                      >
                        <option value="">{!selectedDeployment ? 'Pick a deployment first…' : locations ? 'Select a code location…' : 'Loading locations…'}</option>
                        {(locations ?? []).map((l) => (
                          <option key={l.name} value={l.name}>{l.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={handlePromote}
                        disabled={promoting || !selectedComponentId || !selectedDeployment || !selectedLocation}
                        className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {promoting ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitPullRequestArrow className="w-3 h-3" />}
                        Create draft
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="mt-2 pt-2 border-t border-gray-100">
                <button
                  onClick={() => setPublishOpen((v) => !v)}
                  className="w-full flex items-center gap-1.5 text-[11px] font-medium text-amber-700 hover:text-amber-900"
                >
                  <Rocket className="w-3.5 h-3.5" />
                  Publish directly (skip git)
                  <ChevronDown className={`w-3 h-3 opacity-60 ml-auto transition-transform ${publishOpen ? 'rotate-180' : ''}`} />
                </button>
                {publishOpen && (
                  <div className="mt-2 space-y-2">
                    <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5">
                      Pushes the sandbox straight to a Serverless deployment — no commit, no PR, no
                      review. Discouraged for anything but a demo you're going to throw away.
                    </p>
                    <input
                      type="text"
                      value={publishLocationName}
                      onChange={(e) => setPublishLocationName(e.target.value)}
                      placeholder={`Location name (default: designer-sandbox-${(projectId ?? '').slice(0, 8)})`}
                      className="w-full px-2 py-1 text-[11px] border border-gray-300 rounded font-mono"
                    />
                    <button
                      onClick={handlePublishServerless}
                      disabled={publishing}
                      className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {publishing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
                      {publishing ? 'Publishing…' : 'Publish now'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          {status?.log_tail && status.log_tail.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-gray-500 select-none">Boot log ({status.log_tail.length} lines)</summary>
              <pre className="mt-1 max-h-56 overflow-auto bg-gray-50 border border-gray-200 rounded p-2 text-[10px] leading-tight whitespace-pre-wrap">
                {status.log_tail.join('\n')}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function pillTone(status: string): string {
  switch (status) {
    case 'ready':
      return 'bg-emerald-50 border-emerald-200 text-emerald-800';
    case 'error':
      return 'bg-red-50 border-red-200 text-red-800';
    case 'scaffolding':
    case 'installing':
    case 'starting':
      return 'bg-amber-50 border-amber-200 text-amber-800';
    default:
      return 'bg-gray-50 border-gray-200 text-gray-600';
  }
}

function pillIcon(status: string) {
  const cls = 'w-3 h-3';
  switch (status) {
    case 'ready':
      return <CheckCircle2 className={cls} />;
    case 'error':
      return <AlertTriangle className={cls} />;
    case 'scaffolding':
    case 'installing':
    case 'starting':
      return <Loader2 className={`${cls} animate-spin`} />;
    default:
      return <Boxes className={cls} />;
  }
}

export function pillLabel(status: string): string {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    case 'scaffolding':
      return 'scaffolding';
    case 'installing':
      return 'installing deps';
    case 'starting':
      return 'starting';
    default:
      return 'not started';
  }
}
