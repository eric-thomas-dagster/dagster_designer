import { useMemo, useState } from 'react';
import { X, ArrowLeft, ArrowRight, Loader2, BrainCircuit, MessageSquareText, Sparkles, Image as ImageIcon, Headset } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { notify } from './Notifications';
import { API_BASE } from '@/services/api';

// Same lenient substring check used by DocumentExtractionWizard/
// ComponentConfigModal -- community components phrase x-dagster-io's
// outputs.type by hand, not a strict enum.
function isDataFrameType(t: unknown): boolean {
  return typeof t === 'string' && t.toLowerCase().includes('dataframe');
}

interface ClassifierOption {
  id: string;
  label: string;
  description: string;
  icon: any;
}
const CLASSIFIER_OPTIONS: ClassifierOption[] = [
  {
    id: 'text_classifier',
    label: 'Text classification (LLM)',
    description: 'Any provider, your own category list -- best when categories are nuanced or need reasoning.',
    icon: MessageSquareText,
  },
  {
    id: 'zero_shot_classifier',
    label: 'Text classification (zero-shot, no LLM)',
    description: 'HuggingFace model, no API key or per-row cost -- best for straightforward, high-volume classification.',
    icon: Sparkles,
  },
  {
    id: 'image_classifier',
    label: 'Image classification',
    description: 'CLIP zero-shot or pre-trained torchvision models.',
    icon: ImageIcon,
  },
  {
    id: 'ticket_classifier',
    label: 'Support ticket triage',
    description: 'Category + urgency + sentiment + department routing, purpose-built for support tickets.',
    icon: Headset,
  },
];

export function ClassificationWizard({
  onClose,
  onOpenComponentConfig,
}: {
  onClose: () => void;
  onOpenComponentConfig: (componentType: string, initialAttributes?: Record<string, any>) => void;
}) {
  const { currentProject } = useProjectStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

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
                Pick an existing asset in this project that produces the rows you want to classify (tickets, reviews, product images, ...).
              </p>
              {existingSources.length === 0 ? (
                <div className="text-center text-sm text-gray-400 py-8">
                  No DataFrame-producing assets found yet in this project. Add a source first (e.g. via Ingestions), then come back here.
                </div>
              ) : (
                <div className="space-y-1.5">
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
              </p>
              <div className="space-y-2">
                {CLASSIFIER_OPTIONS.map((opt) => {
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
