import { useState } from 'react';
import { X, Loader2, BrainCircuit, Plus, Sparkles, Image as ImageIcon } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { DocumentPreviewPanel } from './DocumentPreviewPanel';
import { TextSamplePreviewPanel } from './TextSamplePreviewPanel';
import type { ComponentInstance } from '@/types';

// text_classifier / zero_shot_classifier / image_classifier share enough
// shape (upstream asset + one input column + a label list + a model
// choice) for one bespoke step, branching on these per-id differences --
// ticket_classifier's shape (preset categories/urgency/sentiment/
// department fields) is different enough to deserve its own pass later;
// it still falls back to the generic form for now, same call made for
// document_ai_extractor/vision_api_asset in the extraction wizard.
const TYPE_CONFIG: Record<string, {
  labelField: 'categories' | 'candidate_labels';
  labelsRequired: boolean;
  labelsHelp: string;
  columnField: 'input_column' | 'text_column' | 'image_column';
  columnDefault: string;
  columnLabel: string;
  isImage: boolean;
  hasProvider: boolean;
  hasModelName: boolean;
  modelNameDefault: string;
}> = {
  text_classifier: {
    labelField: 'categories', labelsRequired: true,
    labelsHelp: 'The categories to classify each row into.',
    columnField: 'input_column', columnDefault: 'text', columnLabel: 'Text column',
    isImage: false, hasProvider: true, hasModelName: false, modelNameDefault: '',
  },
  zero_shot_classifier: {
    labelField: 'candidate_labels', labelsRequired: true,
    labelsHelp: 'The categories to classify each row into — no training, no API key.',
    columnField: 'text_column', columnDefault: 'text', columnLabel: 'Text column',
    isImage: false, hasProvider: false, hasModelName: true, modelNameDefault: 'facebook/bart-large-mnli',
  },
  image_classifier: {
    labelField: 'candidate_labels', labelsRequired: false,
    labelsHelp: "Optional — restricts CLIP's zero-shot output to just these labels. Leave empty to use the model's full label set.",
    columnField: 'image_column', columnDefault: 'local_path', columnLabel: 'Image column',
    isImage: true, hasProvider: false, hasModelName: true, modelNameDefault: 'openai/clip-vit-base-patch32',
  },
};

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', apiKeyPlaceholder: '${OPENAI_API_KEY}' },
  { id: 'anthropic', label: 'Anthropic', apiKeyPlaceholder: '${ANTHROPIC_API_KEY}' },
  { id: 'gemini', label: 'Google (Gemini)', apiKeyPlaceholder: '${GEMINI_API_KEY}' },
];

export function ClassifierConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
  onReviewExtractions,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
  onReviewExtractions?: (component: ComponentInstance) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const upstreamAssetKey: string | undefined = seedAttrs.upstream_asset_key;
  const componentId = extractComponentId(componentType);
  const cfg = TYPE_CONFIG[componentId] || TYPE_CONFIG.text_classifier;

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_classified` : 'classified'),
  );
  const [column, setColumn] = useState<string>(seedAttrs[cfg.columnField] || cfg.columnDefault);
  const [labels, setLabels] = useState<string[]>(seedAttrs[cfg.labelField] || []);
  const [newLabel, setNewLabel] = useState('');
  const [provider, setProvider] = useState<string>(seedAttrs.provider || 'openai');
  const [apiKey, setApiKey] = useState<string>(seedAttrs.api_key || '');
  const [modelName, setModelName] = useState<string>(seedAttrs.model_name || cfg.modelNameDefault);
  const [saving, setSaving] = useState(false);

  const addLabel = () => {
    const l = newLabel.trim();
    if (l && !labels.includes(l)) setLabels((prev) => [...prev, l]);
    setNewLabel('');
  };
  const removeLabel = (l: string) => setLabels((prev) => prev.filter((x) => x !== l));

  const canSave = assetName.trim().length > 0
    && column.trim().length > 0
    && (!cfg.labelsRequired || labels.length > 0)
    && !!upstreamAssetKey;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        [cfg.columnField]: column.trim(),
      };
      if (labels.length > 0) config[cfg.labelField] = labels;
      if (cfg.hasProvider) {
        config.provider = provider;
        if (apiKey.trim()) config.api_key = apiKey.trim();
      }
      if (cfg.hasModelName && modelName.trim() && modelName.trim() !== cfg.modelNameDefault) {
        config.model_name = modelName.trim();
      }

      const res = await fetch(`${API_BASE}/templates/configure/${componentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, config }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(body.detail || 'Failed to configure component');

      await loadProject(currentProject.id);
      try {
        await projectsApi.regenerateAssets(currentProject.id, true);
      } catch (e) {
        console.error('[ClassifierConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — classifying into ${labels.length || 'the model\'s'} categories.`);
        onDone();
      } else {
        notify.error(`Saved, but Dagster couldn't load it:\n\n${body.regenerate_error || 'Unknown error'}`);
      }
    } catch (e: any) {
      notify.error(`Failed to save: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit classifier' : 'Configure classifier'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          {cfg.isImage ? (
            <DocumentPreviewPanel upstreamAssetKey={upstreamAssetKey} />
          ) : (
            <TextSamplePreviewPanel upstreamAssetKey={upstreamAssetKey} column={column} />
          )}

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Asset name</label>
              <input
                type="text"
                value={assetName}
                onChange={(e) => setAssetName(e.target.value)}
                disabled={isEditing}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono disabled:bg-gray-50 disabled:text-gray-400"
              />
              {isEditing && <p className="text-[10px] text-gray-400 mt-0.5">Can't be renamed after creation.</p>}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">{cfg.columnLabel}</label>
              <input
                type="text"
                value={column}
                onChange={(e) => setColumn(e.target.value)}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {cfg.labelField === 'categories' ? 'Categories' : 'Labels'}
                {!cfg.labelsRequired && <span className="text-gray-400 font-normal"> (optional)</span>}
              </label>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {labels.map((l) => (
                  <span key={l} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-violet-50 text-violet-700 border border-violet-100 rounded-md font-mono">
                    {l}
                    <button onClick={() => removeLabel(l)} className="text-violet-400 hover:text-violet-700">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {labels.length === 0 && (
                  <span className="text-xs text-gray-400 italic py-1">
                    {cfg.labelsRequired ? 'No labels yet — add at least one below.' : "None set — the model's default label set will be used."}
                  </span>
                )}
              </div>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
                  placeholder="add a label"
                  className="flex-1 px-2.5 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <button
                  onClick={addLabel}
                  disabled={!newLabel.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">{cfg.labelsHelp}</p>
            </div>

            {cfg.hasProvider && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Provider</label>
                  <select
                    value={provider}
                    onChange={(e) => {
                      setProvider(e.target.value);
                      const p = PROVIDERS.find((p) => p.id === e.target.value);
                      if (p && (!apiKey || PROVIDERS.some((pp) => pp.apiKeyPlaceholder === apiKey))) setApiKey('');
                    }}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">API key</label>
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={PROVIDERS.find((p) => p.id === provider)?.apiKeyPlaceholder}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">${'{'}VAR_NAME{'}'} syntax — reads from the environment.</p>
                </div>
              </div>
            )}

            {cfg.hasModelName && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
                <input
                  type="text"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">HuggingFace model id.</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {isEditing && onReviewExtractions && (
            <button
              onClick={() => onReviewExtractions(component!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md hover:bg-emerald-100 mr-auto"
            >
              <ImageIcon className="w-3.5 h-3.5" /> Review results
            </button>
          )}
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-accent disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Add classifier'}
          </button>
        </div>
      </div>
    </div>
  );
}
