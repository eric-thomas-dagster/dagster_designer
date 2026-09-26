import { useState } from 'react';
import { Sparkles, FileText, BrainCircuit, Search, ShieldCheck, Eye, Mic } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { AgentPipelineBuilder } from './AgentPipelineBuilder';
import { DocumentExtractionWizard } from './DocumentExtractionWizard';
import { DocumentExtractorConfigStep } from './DocumentExtractorConfigStep';
import { ComponentConfigModal } from './ComponentConfigModal';
import { extractComponentId } from '@/lib/componentId';

interface HubCard {
  id: string;
  label: string;
  description: string;
  icon: any;
  count: number;
  status: 'ready' | 'soon';
}

// Real component counts from the manifest's "ai" category (130 total),
// split by natural tag groupings -- see the session notes in
// genie_service.py's agents_pipelines_component_ids and this file's own
// history for how these were derived. Kept as a flat list here (not
// re-fetched from the manifest) since it only drives card copy/counts,
// not functional filtering.
const CARDS: HubCard[] = [
  {
    id: 'agents_pipelines',
    label: 'Agents & Pipelines',
    description: 'Describe what it should do in plain English — Genie picks the right agent framework or whole-pipeline component and drafts the config.',
    icon: Sparkles,
    count: 16,
    status: 'ready',
  },
  {
    id: 'document_extraction',
    label: 'Document Extraction',
    description: 'OCR, invoices, receipts, contracts, resumes, and more — point at a source, then attach the extraction rules.',
    icon: FileText,
    count: 24,
    status: 'ready',
  },
  {
    id: 'classic_ml',
    label: 'Classic ML / Inference',
    description: 'BigQuery ML, MLflow, classifiers, translation, forecasting.',
    icon: BrainCircuit,
    count: 11,
    status: 'soon',
  },
  {
    id: 'rag',
    label: 'RAG & Vector Search',
    description: 'Embeddings, vector stores, semantic search.',
    icon: Search,
    count: 11,
    status: 'soon',
  },
  {
    id: 'vision',
    label: 'Vision & Image',
    description: 'Classification, object detection, captioning, image generation.',
    icon: Eye,
    count: 10,
    status: 'soon',
  },
  {
    id: 'hitl',
    label: 'HITL / Governance',
    description: 'Human approval gates, audit trails, remediation workflows.',
    icon: ShieldCheck,
    count: 8,
    status: 'soon',
  },
  {
    id: 'audio',
    label: 'Audio & Speech',
    description: 'Transcription, text-to-speech.',
    icon: Mic,
    count: 3,
    status: 'soon',
  },
];

/**
 * Single discoverable home for every curated AI/ML builder. Exists
 * because burying each one behind either the Component Palette's "ai"
 * category or its own graph-toolbar button doesn't scale past one or
 * two of these -- confirmed live with Agents & Pipelines needing a
 * dedicated toolbar button just to stop being missed entirely. One nav
 * tab, one card per bin, each opening its own builder -- new bins get
 * added as cards here as they're built, not as new nav tabs.
 */
export function AiMlHub() {
  const { currentProject } = useProjectStore();
  const [openBuilder, setOpenBuilder] = useState<string | null>(null);
  const [pendingConfig, setPendingConfig] = useState<{ componentType: string; initialAttributes?: Record<string, any>; sourcePath?: string } | null>(null);

  if (!currentProject) {
    return (
      <div className="p-8 text-center text-sm text-gray-500">
        Open a project to use the AI/ML builders.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50">
      <div className="px-8 py-6 max-w-4xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">AI/ML</h2>
          <p className="text-sm text-gray-500 mt-1">
            Curated, guided builders for the ~130-component AI/ML catalog — describe or configure what you need instead of hunting through a component list.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            const disabled = card.status === 'soon';
            return (
              <button
                key={card.id}
                onClick={() => !disabled && setOpenBuilder(card.id)}
                disabled={disabled}
                className={`text-left p-4 rounded-lg border flex items-start gap-3 transition-all ${
                  disabled
                    ? 'bg-gray-100 border-gray-200 opacity-60 cursor-not-allowed'
                    : 'bg-white border-gray-200 hover:border-blue-300 hover:shadow-sm'
                }`}
              >
                <div className={`w-9 h-9 rounded-md flex items-center justify-center flex-shrink-0 ${disabled ? 'bg-gray-200' : 'bg-violet-50 border border-violet-100'}`}>
                  <Icon className={`w-4.5 h-4.5 ${disabled ? 'text-gray-400' : 'text-violet-600'}`} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-gray-900">{card.label}</span>
                    <span className="text-xs text-gray-400">{card.count}</span>
                    {disabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-500">Coming soon</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">{card.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {openBuilder === 'agents_pipelines' && (
        <AgentPipelineBuilder onClose={() => setOpenBuilder(null)} />
      )}

      {openBuilder === 'document_extraction' && (
        <DocumentExtractionWizard
          onClose={() => setOpenBuilder(null)}
          onOpenComponentConfig={(componentType, initialAttributes, sourcePath) => {
            setPendingConfig({ componentType, initialAttributes, sourcePath });
            setOpenBuilder(null);
          }}
        />
      )}

      {pendingConfig && (
        extractComponentId(pendingConfig.componentType) === 'structured_document_extractor' ? (
          <DocumentExtractorConfigStep
            componentType={pendingConfig.componentType}
            initialAttributes={pendingConfig.initialAttributes || {}}
            sourcePath={pendingConfig.sourcePath}
            onDone={() => setPendingConfig(null)}
            onClose={() => setPendingConfig(null)}
          />
        ) : (
          <ConfigHandoff
            componentType={pendingConfig.componentType}
            initialAttributes={pendingConfig.initialAttributes}
            onDone={() => setPendingConfig(null)}
          />
        )
      )}
    </div>
  );
}

// Thin wrapper so DocumentExtractionWizard's picked component opens the
// SAME ComponentConfigModal every other install path uses, without this
// hub needing App.tsx's editingComponent/addingComponentType wiring.
function ConfigHandoff({
  componentType,
  initialAttributes,
  onDone,
}: {
  componentType: string;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
}) {
  return (
    <ComponentConfigModal
      component={null}
      componentType={componentType}
      initialAttributes={initialAttributes}
      onSave={onDone}
      onClose={onDone}
    />
  );
}
