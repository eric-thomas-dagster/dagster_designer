import { useMemo, useState } from 'react';
import { X, ArrowLeft, ArrowRight, Loader2, BrainCircuit, MessageSquareText, Sparkles, Image as ImageIcon, Headset, FileSpreadsheet, FolderOpen } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';
import { API_BASE } from '@/services/api';

// Same lenient substring check used by DocumentExtractionWizard/
// ComponentConfigModal -- community components phrase x-dagster-io's
// outputs.type by hand, not a strict enum.
function isDataFrameType(t: unknown): boolean {
  return typeof t === 'string' && t.toLowerCase().includes('dataframe');
}

// Same auto-naming as DocumentExtractionWizard's deriveSourceName --
// duplicated rather than shared since the two wizards' surrounding state
// differs enough that extracting it now isn't worth the indirection.
function deriveSourceName(path: string, existingNames: Set<string>): string {
  const cleaned = path.replace(/[*?[\]{}].*$/, '').replace(/\/+$/, '');
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  let base = (segments[segments.length - 1] || 'data').replace(/\.[^./]+$/, '');
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
  if (!/^[a-z]/.test(base)) base = `source_${base}`;
  if (!existingNames.has(base)) return base;
  let n = 2;
  while (existingNames.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

interface ClassifierOption {
  id: string;
  label: string;
  description: string;
  icon: any;
  kind: 'text' | 'image';
}
const CLASSIFIER_OPTIONS: ClassifierOption[] = [
  {
    id: 'text_classifier',
    label: 'Text classification (LLM)',
    description: 'Any provider, your own category list -- best when categories are nuanced or need reasoning.',
    icon: MessageSquareText,
    kind: 'text',
  },
  {
    id: 'zero_shot_classifier',
    label: 'Text classification (zero-shot, no LLM)',
    description: 'HuggingFace model, no API key or per-row cost -- best for straightforward, high-volume classification.',
    icon: Sparkles,
    kind: 'text',
  },
  {
    id: 'image_classifier',
    label: 'Image classification',
    description: 'CLIP zero-shot or pre-trained torchvision models.',
    icon: ImageIcon,
    kind: 'image',
  },
  {
    id: 'ticket_classifier',
    label: 'Support ticket triage',
    description: 'Category + urgency + sentiment + department routing, purpose-built for support tickets.',
    icon: Headset,
    kind: 'text',
  },
];

export function ClassificationWizard({
  onClose,
  onOpenComponentConfig,
}: {
  onClose: () => void;
  onOpenComponentConfig: (componentType: string, initialAttributes?: Record<string, any>) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  // Which classifier options make sense for the source just picked --
  // known for certain right after "connect a new source" (csv -> text
  // rows, images -> image rows); for an EXISTING source, guessed from its
  // component type (file_lister-shaped sources are file listings, so
  // image-like; anything else is assumed to produce text rows). Null
  // means "unknown, show everything" rather than guessing wrong and
  // hiding a real option. Fixes a real gap: step 2 used to show ALL FOUR
  // classifier types regardless of source, including "Text classification"
  // right after connecting a folder of images, which can't work at all
  // (there's no text column, only image paths).
  const [sourceKind, setSourceKind] = useState<'text' | 'image' | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [newSourceMode, setNewSourceMode] = useState<'csv' | 'images' | null>(null);
  const [newSourcePath, setNewSourcePath] = useState('');
  const [installingSource, setInstallingSource] = useState(false);

  const existingSources = useMemo(() => {
    if (!currentProject) return [];
    return currentProject.graph.nodes
      .filter((n) => (n.type === 'asset' || (n.data as any)?.asset_key) && isDataFrameType((n.data as any)?.io_output_type))
      .map((n) => {
        const componentType = (n.data as any)?.component_type as string | undefined;
        // Best-effort guess, not a certainty -- a file_lister could in
        // principle list PDFs or CSVs too. Still better than always
        // showing every classifier type regardless of what's actually in
        // the source.
        const kindGuess: 'text' | 'image' = componentType?.toLowerCase().includes('file_lister') ? 'image' : 'text';
        return {
          assetKey: (n.data as any)?.asset_key || n.id,
          label: (n.data as any)?.label || (n.data as any)?.asset_key || n.id,
          componentType,
          kindGuess,
        };
      });
  }, [currentProject]);

  const connectNewSource = async () => {
    if (!currentProject || !newSourcePath.trim() || installingSource) return;
    setInstallingSource(true);
    try {
      const existingNames = new Set(currentProject.components.map((c) => (c.attributes?.asset_name as string) || c.id));
      const derivedName = deriveSourceName(newSourcePath.trim(), existingNames);
      const componentId = newSourceMode === 'csv' ? 'dataframe_from_csv' : 'file_lister';
      const attributes = newSourceMode === 'csv'
        ? { asset_name: derivedName, file_path: newSourcePath.trim() }
        : { asset_name: derivedName, path: newSourcePath.trim(), download: true };

      // install-via-cli only drops the component's template code + a demo
      // stub defs.yaml on disk -- it never touches project.components (the
      // separate list this wizard's own preview lookups read from), so
      // calling it WITH attributes directly (as this used to) left
      // project.components stale no matter how many times loadProject/
      // regenerateAssets ran afterward -- confirmed live by inspecting the
      // project's persisted JSON directly. /templates/configure/{id} is
      // the one path that both writes the real defs.yaml AND syncs
      // project.components -- the same mechanism every other save in this
      // app (ComponentConfigModal, ClassifierConfigStep, ...) already uses.
      const installRes = await fetch(`${API_BASE}/templates/install-via-cli/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: {}, template_only: true }),
      });
      const installBody = await installRes.json().catch(() => ({} as any));
      if (!installRes.ok) throw new Error(installBody.detail || 'Failed to add source');

      const configRes = await fetch(`${API_BASE}/templates/configure/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config: { name: derivedName, ...attributes } }),
      });
      const configBody = await configRes.json().catch(() => ({} as any));
      if (!configRes.ok) throw new Error(configBody.detail || 'Failed to configure source');

      notify.success(`Added "${derivedName}" as a source.`);
      await loadProject(currentProject.id);
      setSelectedSource(derivedName);
      setSourceKind(newSourceMode === 'csv' ? 'text' : 'image');
      setNewSourceMode(null);
      setNewSourcePath('');
      setStep(2);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.error(`Failed to add source: ${msg}`);
    } finally {
      setInstallingSource(false);
    }
  };

  const pickClassifier = async (opt: ClassifierOption) => {
    if (!currentProject || !selectedSource || installingId) return;
    setInstallingId(opt.id);
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
      notify.error(`Failed to add classifier: ${msg}`);
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">
              {step === 1 ? 'Classification — what do you want to classify?' : 'What kind of classifier?'}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {step === 1 ? (
            <>
              <p className="text-sm text-gray-500">
                Pick an asset already in this project that produces the rows you want to classify, or connect a new one.
              </p>
              {existingSources.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Existing sources</h3>
                  {existingSources.map((s) => (
                    <button
                      key={s.assetKey}
                      onClick={() => { setSelectedSource(s.assetKey); setSourceKind(s.kindGuess); setStep(2); }}
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
                {!newSourceMode ? (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setNewSourceMode('csv')}
                      className="flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                    >
                      <FileSpreadsheet className="w-4 h-4 text-violet-600 flex-shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">A CSV / data file</div>
                        <div className="text-xs text-gray-500">One file — each ROW in it becomes one thing to classify</div>
                      </div>
                    </button>
                    <button
                      onClick={() => setNewSourceMode('images')}
                      className="flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                    >
                      <FolderOpen className="w-4 h-4 text-violet-600 flex-shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">A folder of images</div>
                        <div className="text-xs text-gray-500">One folder (S3, GCS, ADLS, or local) — each FILE in it becomes one thing to classify</div>
                      </div>
                    </button>
                  </div>
                ) : (
                  <div className="border border-gray-200 rounded-md p-3 space-y-2.5">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        {newSourceMode === 'csv' ? 'Path or URL to the CSV file' : 'Path / glob'}
                      </label>
                      <input
                        type="text"
                        value={newSourcePath}
                        onChange={(e) => setNewSourcePath(e.target.value)}
                        placeholder={newSourceMode === 'csv' ? 's3://my-bucket/tickets.csv' : 's3://my-bucket/product-images/**/*.jpg'}
                        className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                      />
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() => { setNewSourceMode(null); setNewSourcePath(''); }}
                        className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-md"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={connectNewSource}
                        disabled={installingSource || !newSourcePath.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
                      >
                        {installingSource ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                        Use this source
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back to source
              </button>
              <p className="text-sm text-gray-500">
                Reading from <span className="font-mono text-gray-700">{selectedSource}</span> — pick a classifier.
                {sourceKind && (
                  <span className="text-gray-400"> Only showing types that work on {sourceKind === 'image' ? 'images' : 'text rows'}, since that's what this source produces.</span>
                )}
              </p>
              <div className="space-y-2">
                {CLASSIFIER_OPTIONS.filter((opt) => !sourceKind || opt.kind === sourceKind).map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => pickClassifier(opt)}
                      disabled={!!installingId}
                      className="w-full flex items-start gap-3 px-3 py-2.5 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40 disabled:opacity-50 disabled:cursor-progress"
                    >
                      <Icon className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-gray-900">{opt.label}</div>
                        <div className="text-xs text-gray-500">{opt.description}</div>
                      </div>
                      {installingId === opt.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400 flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
