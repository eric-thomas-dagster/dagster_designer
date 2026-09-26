import { useMemo, useState } from 'react';
import { X, ArrowLeft, ArrowRight, Loader2, FolderOpen } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';
import { API_BASE } from '@/services/api';

// Same lenient substring check used by every other wizard here --
// community components phrase x-dagster-io's outputs.type by hand, not a
// strict enum.
function isDataFrameType(t: unknown): boolean {
  return typeof t === 'string' && t.toLowerCase().includes('dataframe');
}

// Same auto-naming as the other wizards' deriveSourceName.
function deriveSourceName(path: string, existingNames: Set<string>): string {
  const cleaned = path.replace(/[*?[\]{}].*$/, '').replace(/\/+$/, '');
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  let base = (segments[segments.length - 1] || 'files').replace(/\.[^./]+$/, '');
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'files';
  if (!/^[a-z]/.test(base)) base = `source_${base}`;
  if (!existingNames.has(base)) return base;
  let n = 2;
  while (existingNames.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export interface WizardTargetOption {
  id: string;
  label: string;
  description: string;
}

/**
 * Single-source wizard: pick an existing DataFrame-of-paths asset, or
 * connect a new folder via file_lister, then choose which of
 * `targetOptions` to install wired to it. Extracted after
 * DocumentExtractionWizard/ClassificationWizard being the 2nd/3rd
 * near-identical "pick or connect a source" flow.
 *
 * `targetOptions` deliberately lists every real alternative in the
 * catalog for this source shape (not just the one with a bespoke config
 * step) -- an earlier version of this wizard only offered a single
 * hardcoded target, which hid perfectly good components (e.g.
 * video_frame_extract_asset, audio_transcriber) with no way to reach
 * them from here at all. Anything without its own bespoke step still
 * falls through to the generic form via the caller's ConfigHandoff --
 * same "discovery over depth for the long tail" call already made for
 * Document Extraction's 24 options.
 */
export function SingleComponentWizard({
  title,
  icon: Icon,
  sourceHint,
  pathPlaceholder,
  targetOptions,
  onOpenComponentConfig,
  onClose,
}: {
  title: string;
  icon: any;
  sourceHint: string;
  pathPlaceholder: string;
  targetOptions: WizardTargetOption[];
  onOpenComponentConfig: (componentType: string, initialAttributes?: Record<string, any>) => void;
  onClose: () => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [showNewSourceForm, setShowNewSourceForm] = useState(false);
  const [newSourcePath, setNewSourcePath] = useState('');
  const [newSourceDownload, setNewSourceDownload] = useState(true);
  const [installingSource, setInstallingSource] = useState(false);
  const [installingTargetId, setInstallingTargetId] = useState<string | null>(null);

  const existingSources = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => (n.type === 'asset' || (n.data as any)?.asset_key) && isDataFrameType((n.data as any)?.io_output_type))
      .map((n) => ({
        assetKey: (n.data as any)?.asset_key || n.id,
        label: (n.data as any)?.label || (n.data as any)?.asset_key || n.id,
        componentType: (n.data as any)?.component_type,
      }));
  }, [currentProject]);

  const connectNewSource = async () => {
    if (!currentProject || !newSourcePath.trim() || installingSource) return;
    setInstallingSource(true);
    try {
      const existingNames = new Set(currentProject.components.map((c) => (c.attributes?.asset_name as string) || c.id));
      const derivedName = deriveSourceName(newSourcePath.trim(), existingNames);

      // install(template_only) then configure(attributes) -- install-via-
      // cli-with-attributes never syncs project.components, only writing
      // the raw defs.yaml; configure is the one path that does both,
      // confirmed the hard way debugging the classifier wizard's own
      // "materialize first" dead end.
      const installRes = await fetch(`${API_BASE}/templates/install-via-cli/file_lister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      const installBody = await installRes.json().catch(() => ({} as any));
      if (!installRes.ok) throw new Error(installBody.detail || 'Failed to add source');

      const configRes = await fetch(`${API_BASE}/templates/configure/file_lister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: currentProject.id,
          config: { name: derivedName, asset_name: derivedName, path: newSourcePath.trim(), download: newSourceDownload },
        }),
      });
      const configBody = await configRes.json().catch(() => ({} as any));
      if (!configRes.ok) throw new Error(configBody.detail || 'Failed to configure source');

      notify.success(`Added "${derivedName}" as a source.`);
      await loadProject(currentProject.id);
      setSelectedSource(derivedName);
      setShowNewSourceForm(false);
      setNewSourcePath('');
      setStep(2);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to add source: ${msg}`);
    } finally {
      setInstallingSource(false);
    }
  };

  const pickTarget = async (opt: WizardTargetOption) => {
    if (!currentProject || !selectedSource || installingTargetId) return;
    setInstallingTargetId(opt.id);
    try {
      const res = await fetch(`${API_BASE}/templates/install-via-cli/${opt.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Install failed');
      onOpenComponentConfig(body.component_type, { upstream_asset_key: selectedSource });
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to add component: ${msg}`);
    } finally {
      setInstallingTargetId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{step === 1 ? title : 'What do you want to do with these files?'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {step === 1 ? (
            <>
              <p className="text-sm text-gray-500">{sourceHint}</p>

              {existingSources.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Existing sources</h3>
                  {existingSources.map((s) => (
                    <button
                      key={s.assetKey}
                      onClick={() => { setSelectedSource(s.assetKey); setStep(2); }}
                      className="w-full flex items-center justify-between px-3 py-2 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
                    >
                      <div>
                        <div className="text-sm font-medium text-gray-900">{s.label}</div>
                        {s.componentType && <div className="text-xs text-gray-400 font-mono">{s.componentType}</div>}
                      </div>
                      <ArrowRight className="w-4 h-4 text-gray-300" />
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Connect a new source</h3>
                {!showNewSourceForm ? (
                  <button
                    onClick={() => setShowNewSourceForm(true)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                  >
                    <FolderOpen className="w-4 h-4 text-violet-600" />
                    <div>
                      <div className="text-sm font-medium text-gray-900">Point at a bucket or folder</div>
                      <div className="text-xs text-gray-500">S3, GCS, ADLS, or a local path — matches a glob pattern</div>
                    </div>
                  </button>
                ) : (
                  <div className="border border-gray-200 rounded-md p-3 space-y-2.5">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Path / glob</label>
                      <input
                        type="text"
                        value={newSourcePath}
                        onChange={(e) => setNewSourcePath(e.target.value)}
                        placeholder={pathPlaceholder}
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input type="checkbox" checked={newSourceDownload} onChange={(e) => setNewSourceDownload(e.target.checked)} />
                      Download files to a local cache
                    </label>
                    <div className="flex justify-end gap-2 pt-1">
                      <button onClick={() => setShowNewSourceForm(false)} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-md">
                        Cancel
                      </button>
                      <button
                        onClick={connectNewSource}
                        disabled={installingSource || !newSourcePath.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                      >
                        {installingSource ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                        Use this path
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <button onClick={() => setStep(1)} className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                <ArrowLeft className="w-3.5 h-3.5" /> Back to source
              </button>
              <p className="text-sm text-gray-500">
                Reading from <span className="font-mono text-gray-700">{selectedSource}</span> — pick what to do with it.
              </p>
              <div className="space-y-2">
                {targetOptions.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => pickTarget(opt)}
                    disabled={!!installingTargetId}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50 disabled:cursor-progress"
                  >
                    <div>
                      <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                      <div className="text-xs text-gray-500">{opt.description}</div>
                    </div>
                    {installingTargetId === opt.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400 flex-shrink-0" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
