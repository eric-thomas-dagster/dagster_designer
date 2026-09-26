import { useState } from 'react';
import { Sparkles, FileText, BrainCircuit, Search, ShieldCheck, Film, Mic } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { AgentPipelineBuilder } from './AgentPipelineBuilder';
import { DocumentExtractionWizard } from './DocumentExtractionWizard';
import { DocumentExtractorConfigStep } from './DocumentExtractorConfigStep';
import { OcrExtractorConfigStep } from './OcrExtractorConfigStep';
import { ClassificationWizard } from './ClassificationWizard';
import { ClassifierConfigStep } from './ClassifierConfigStep';
import { SingleComponentWizard } from './SingleComponentWizard';
import { VideoSceneConfigStep } from './VideoSceneConfigStep';
import { AudioDiarizedConfigStep } from './AudioDiarizedConfigStep';
import { MlflowInferenceConfigStep } from './MlflowInferenceConfigStep';
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
    description: 'Classifiers (text, zero-shot, image) and scoring an existing MLflow model are ready — point at a source, pick what to do. BigQuery ML and feature engineering still fall back to the raw form.',
    icon: BrainCircuit,
    count: 11,
    status: 'ready',
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
    id: 'video_scene',
    label: 'Video',
    description: 'Scene understanding, frame extraction, audio extraction, or metadata — point at a folder of videos, pick what you need.',
    icon: Film,
    count: 10,
    status: 'ready',
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
    description: 'Transcription — with or without speaker labels, local or cloud — point at a folder of audio files, pick what you need.',
    icon: Mic,
    count: 3,
    status: 'ready',
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

      {openBuilder === 'classic_ml' && (
        <ClassificationWizard
          onClose={() => setOpenBuilder(null)}
          onOpenComponentConfig={(componentType, initialAttributes) => {
            setPendingConfig({ componentType, initialAttributes });
            setOpenBuilder(null);
          }}
        />
      )}

      {openBuilder === 'video_scene' && (
        <SingleComponentWizard
          title="Video — point at your videos"
          icon={Film}
          sourceHint="Pick an existing DataFrame of video paths already in this project, or connect a new folder."
          pathPlaceholder="s3://my-bucket/videos/**/*.mp4"
          targetOptions={[
            { id: 'video_scene_summarizer', label: 'Understand scenes', description: 'Detect scene changes and summarize each one with a vision-LLM call — a table of contents for the video.' },
            { id: 'video_frame_extract_asset', label: 'Extract frames', description: 'Pull N frames per video as image files (every N seconds/frames, or a fixed count) — no LLM call.' },
            { id: 'video_audio_extract_asset', label: 'Extract audio track', description: 'Pull just the audio out of each video via ffmpeg, for feeding into a transcriber.' },
            { id: 'video_metadata_extractor', label: 'Get metadata', description: 'Container + stream metadata (duration, resolution, codec, ...) via ffprobe — no LLM call.' },
          ]}
          onClose={() => setOpenBuilder(null)}
          onOpenComponentConfig={(componentType, initialAttributes) => {
            setPendingConfig({ componentType, initialAttributes });
            setOpenBuilder(null);
          }}
        />
      )}

      {openBuilder === 'audio' && (
        <SingleComponentWizard
          title="Audio — point at your audio files"
          icon={Mic}
          sourceHint="Pick an existing DataFrame of audio paths already in this project (e.g. video_audio_extract_asset's output), or connect a new folder."
          pathPlaceholder="s3://my-bucket/calls/**/*.mp3"
          targetOptions={[
            { id: 'audio_diarized_transcriber', label: 'Transcribe with speaker labels', description: 'Who said what, when — segments per speaker turn. Google Cloud Speech or local pyannote+Whisper.' },
            { id: 'audio_transcriber', label: 'Transcribe (local Whisper)', description: 'Plain transcript, no speaker labels — runs fully locally via OpenAI\'s Whisper model, no API key.' },
            { id: 'litellm_audio_transcription', label: 'Transcribe (LiteLLM/cloud Whisper)', description: 'Plain transcript via any LiteLLM-compatible Whisper endpoint (OpenAI, Azure, ...).' },
            { id: 'speech_to_text_asset', label: 'Transcribe (Google Cloud Speech)', description: 'Plain transcript via Cloud Speech-to-Text v2 — good for long files, non-English, or noisy audio.' },
          ]}
          onClose={() => setOpenBuilder(null)}
          onOpenComponentConfig={(componentType, initialAttributes) => {
            setPendingConfig({ componentType, initialAttributes });
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
        ) : extractComponentId(pendingConfig.componentType) === 'ocr_extractor' ? (
          <OcrExtractorConfigStep
            componentType={pendingConfig.componentType}
            initialAttributes={pendingConfig.initialAttributes || {}}
            onDone={() => setPendingConfig(null)}
            onClose={() => setPendingConfig(null)}
          />
        ) : ['text_classifier', 'zero_shot_classifier', 'image_classifier'].includes(extractComponentId(pendingConfig.componentType)) ? (
          <ClassifierConfigStep
            componentType={pendingConfig.componentType}
            initialAttributes={pendingConfig.initialAttributes || {}}
            onDone={() => setPendingConfig(null)}
            onClose={() => setPendingConfig(null)}
          />
        ) : extractComponentId(pendingConfig.componentType) === 'video_scene_summarizer' ? (
          <VideoSceneConfigStep
            componentType={pendingConfig.componentType}
            initialAttributes={pendingConfig.initialAttributes || {}}
            onDone={() => setPendingConfig(null)}
            onClose={() => setPendingConfig(null)}
          />
        ) : extractComponentId(pendingConfig.componentType) === 'audio_diarized_transcriber' ? (
          <AudioDiarizedConfigStep
            componentType={pendingConfig.componentType}
            initialAttributes={pendingConfig.initialAttributes || {}}
            onDone={() => setPendingConfig(null)}
            onClose={() => setPendingConfig(null)}
          />
        ) : extractComponentId(pendingConfig.componentType) === 'mlflow_model_inference' ? (
          <MlflowInferenceConfigStep
            componentType={pendingConfig.componentType}
            initialAttributes={pendingConfig.initialAttributes || {}}
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
