import { useMemo, useState } from 'react';
import { X, ArrowLeft, ArrowRight, Loader2, BrainCircuit, MessageSquareText, Sparkles, Image as ImageIcon, Headset, FileSpreadsheet, FolderOpen, Gauge, Scale, ShieldAlert, FileSearch, FileStack, GraduationCap, Wrench } from 'lucide-react';
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
  kind: 'text' | 'image' | 'document';
  // The fork this session's testing surfaced as the missing question:
  // do you have labeled historical examples to learn from? 'train' spends
  // time once (a real model gets fit) to make every future row cheap;
  // 'judge' spends money/time on every single row (an LLM or zero-shot
  // model looks at it cold, no training data needed); 'external' skips
  // both because the model already exists somewhere else. Conflating
  // these was the actual gap -- without asking it, the wizard silently
  // defaulted every request into a per-row judgment call even when the
  // user already had a labeled column sitting right there.
  labelMode: 'judge' | 'train' | 'external';
}
const CLASSIFIER_OPTIONS: ClassifierOption[] = [
  {
    id: 'text_classifier',
    label: 'Text classification (LLM)',
    description: 'Any provider, your own category list -- best when categories are nuanced, need reasoning, or the label set is open-ended.',
    icon: MessageSquareText,
    kind: 'text',
    labelMode: 'judge',
  },
  {
    id: 'zero_shot_classifier',
    label: 'Text classification (zero-shot, no LLM)',
    description: 'HuggingFace model, no API key or per-row cost -- best for a fixed label set at high volume.',
    icon: Sparkles,
    kind: 'text',
    labelMode: 'judge',
  },
  {
    id: 'ticket_classifier',
    label: 'Support ticket triage',
    description: 'Category + urgency + sentiment + department routing, purpose-built for support tickets specifically.',
    icon: Headset,
    kind: 'text',
    labelMode: 'judge',
  },
  {
    id: 'llm_judge',
    label: 'Score against a rubric',
    description: "Not a fixed category -- rates each row 0-10 on criteria you set, with a written reason. Use this for quality/fit scoring, not sorting into buckets.",
    icon: Scale,
    kind: 'text',
    labelMode: 'judge',
  },
  {
    id: 'moderation_scorer',
    label: 'Content-risk / moderation scoring',
    description: 'Purpose-built risk scoring for user-generated content -- narrower than llm_judge, tuned for moderation specifically.',
    icon: ShieldAlert,
    kind: 'text',
    labelMode: 'judge',
  },
  {
    id: 'automl_asset',
    label: 'Train a model automatically (AutoML)',
    description: "Searches across model families (LightGBM, XGBoost, random forest, ...) and picks the winner -- no algorithm choice needed. The default answer when you have a labeled column.",
    icon: GraduationCap,
    kind: 'text',
    labelMode: 'train',
  },
  {
    id: 'ml_pipeline',
    label: 'Train a specific model (advanced)',
    description: 'You pick the algorithm and preprocessing yourself -- a 30-op YAML pipeline (feature engineering, hyperparameter search, evaluation, model registry). Falls back to the raw config form.',
    icon: Wrench,
    kind: 'text',
    labelMode: 'train',
  },
  {
    id: 'mlflow_model_inference',
    label: 'Score with an existing model (MLflow)',
    description: "Loads a model already registered in MLflow and scores every row with it -- doesn't train anything, just runs one you already have.",
    icon: Gauge,
    kind: 'text',
    labelMode: 'external',
  },
  {
    id: 'image_classifier',
    label: 'Image classification',
    description: 'CLIP zero-shot or pre-trained torchvision models -- a fixed label set, no per-image API cost.',
    icon: ImageIcon,
    kind: 'image',
    labelMode: 'judge',
  },
  {
    id: 'image_llm_extractor',
    label: 'Open-ended image attributes',
    description: "Not a fixed label set -- a vision-LLM call per image, extracting whatever fields you define (can include a free-form category).",
    icon: FileSearch,
    kind: 'image',
    labelMode: 'judge',
  },
  {
    id: 'structured_document_extractor',
    label: 'Classify or score documents',
    description: 'Real PDF/scanned-file extraction -- add your category or score as one of the fields to pull out.',
    icon: FileStack,
    kind: 'document',
    labelMode: 'judge',
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
  const [step, setStep] = useState<'source' | 'labels' | 'method'>('source');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  // Which classifier options make sense for the source just picked --
  // known for certain right after "connect a new source" (csv -> text
  // rows, images -> image rows, a folder of PDFs -> document rows); for
  // an EXISTING source, guessed from its component type (file_lister-
  // shaped sources are file listings, so image-like; anything else is
  // assumed to produce text rows -- there's no reliable signal to guess
  // "document" specifically for an existing source, so that guess stays
  // 'image' same as before). Null means "unknown, show everything" rather
  // than guessing wrong and hiding a real option.
  const [sourceKind, setSourceKind] = useState<'text' | 'image' | 'document' | null>(null);
  // The fork this session's real feedback said was missing: do you have
  // labeled historical examples to train a model on, or should something
  // judge each row cold? Only meaningful for tabular/text sources --
  // image and document sources in this catalog only have judge-mode
  // options today, so the question is skipped for them (asking it would
  // just be a screen with one real answer).
  const [hasLabels, setHasLabels] = useState<'judge' | 'train' | 'external' | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [newSourceMode, setNewSourceMode] = useState<'csv' | 'images' | 'documents' | null>(null);
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
      const connectedKind: 'text' | 'image' | 'document' = newSourceMode === 'csv' ? 'text' : newSourceMode === 'documents' ? 'document' : 'image';

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
      setSourceKind(connectedKind);
      setHasLabels(null);
      setNewSourceMode(null);
      setNewSourcePath('');
      setStep(connectedKind === 'text' ? 'labels' : 'method');
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
      // ml_pipeline doesn't take a top-level upstream_asset_key like every
      // other option here -- its source is a nested `source: {kind, ...}`
      // block (confirmed against the real Pydantic model, not the README).
      // It has no bespoke config step yet, so this just pre-wires the one
      // field that IS knowable here and leaves the rest (target_column,
      // steps, outputs) to the raw generic form.
      const initialAttributes = opt.id === 'ml_pipeline'
        ? { source: { kind: 'upstream_asset', upstream_asset_key: selectedSource } }
        : { upstream_asset_key: selectedSource };
      onOpenComponentConfig(body.component_type, initialAttributes);
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
              {step === 'source' ? 'Classify or score — what are the rows?' : step === 'labels' ? 'Do you have labeled historical examples?' : 'How should each row be labeled or scored?'}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {step === 'source' ? (
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
                      onClick={() => {
                        setSelectedSource(s.assetKey);
                        setSourceKind(s.kindGuess);
                        setHasLabels(null);
                        setStep(s.kindGuess === 'text' ? 'labels' : 'method');
                      }}
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
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <button
                      onClick={() => setNewSourceMode('csv')}
                      className="flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                    >
                      <FileSpreadsheet className="w-4 h-4 text-violet-600 flex-shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">A CSV / data file</div>
                        <div className="text-xs text-gray-500">Each ROW becomes one thing to classify or score</div>
                      </div>
                    </button>
                    <button
                      onClick={() => setNewSourceMode('images')}
                      className="flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                    >
                      <FolderOpen className="w-4 h-4 text-violet-600 flex-shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">A folder of images</div>
                        <div className="text-xs text-gray-500">Each FILE becomes one thing to classify or score</div>
                      </div>
                    </button>
                    <button
                      onClick={() => setNewSourceMode('documents')}
                      className="flex items-center gap-2 px-3 py-2.5 text-left bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-200 rounded-md hover:border-violet-400"
                    >
                      <FileStack className="w-4 h-4 text-violet-600 flex-shrink-0" />
                      <div>
                        <div className="text-sm font-medium text-gray-900">A folder of documents</div>
                        <div className="text-xs text-gray-500">PDFs/scans — tickets, contracts, resumes</div>
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
                        placeholder={newSourceMode === 'csv' ? 's3://my-bucket/tickets.csv' : newSourceMode === 'documents' ? 's3://my-bucket/contracts/**/*.pdf' : 's3://my-bucket/product-images/**/*.jpg'}
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
          ) : step === 'labels' ? (
            <>
              <button
                onClick={() => setStep('source')}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back to source
              </button>
              <p className="text-sm text-gray-500">
                Reading from <span className="font-mono text-gray-700">{selectedSource}</span>. This is the fork that decides everything downstream — a trained model is cheap to run but needs training data; an LLM judging cold needs no training data but costs something on every row.
              </p>
              <div className="space-y-2">
                <button
                  onClick={() => { setHasLabels('train'); setStep('method'); }}
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
                >
                  <GraduationCap className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900">Yes — I have a labeled column already</div>
                    <div className="text-xs text-gray-500">Train a real model on it. Cheap and reproducible to run afterward.</div>
                  </div>
                </button>
                <button
                  onClick={() => { setHasLabels('judge'); setStep('method'); }}
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
                >
                  <Sparkles className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900">No — judge each row live, no training</div>
                    <div className="text-xs text-gray-500">An LLM or zero-shot model looks at each row cold. More flexible, costs something per row.</div>
                  </div>
                </button>
                <button
                  onClick={() => { setHasLabels('external'); setStep('method'); }}
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left border border-gray-200 rounded-md hover:border-blue-300 hover:bg-blue-50/40"
                >
                  <Gauge className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900">I already have a trained model</div>
                    <div className="text-xs text-gray-500">It's registered in MLflow somewhere — just score with it.</div>
                  </div>
                </button>
              </div>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep(sourceKind === 'text' ? 'labels' : 'source')}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
              <p className="text-sm text-gray-500">
                Reading from <span className="font-mono text-gray-700">{selectedSource}</span> — pick one.
                {sourceKind && (
                  <span className="text-gray-400"> Only showing types that work on {sourceKind === 'image' ? 'images' : sourceKind === 'document' ? 'documents' : 'text rows'}, since that's what this source produces.</span>
                )}
              </p>
              <div className="space-y-2">
                {CLASSIFIER_OPTIONS.filter((opt) => (!sourceKind || opt.kind === sourceKind) && (!hasLabels || opt.labelMode === hasLabels)).map((opt) => {
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
