import { useState } from 'react';
import { X, Loader2, Film, Sparkles } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { MediaPreviewPanel } from './MediaPreviewPanel';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for video_scene_summarizer -- same "real preview
 * instead of a raw form" treatment as the document/classifier steps, using
 * MediaPreviewPanel's <video> player instead of an <img>. There's no
 * "detected scenes" preview possible here (that requires actually running
 * ffmpeg + the LLM), so this shows the real source video instead --
 * still far better than a blank form.
 */
export function VideoSceneConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
  onReviewScenes,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
  onReviewScenes?: (component: ComponentInstance) => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const upstreamAssetKey: string | undefined = seedAttrs.upstream_asset_key;

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_scenes` : 'scene_summaries'),
  );
  const [sceneThreshold, setSceneThreshold] = useState<number>(seedAttrs.scene_threshold ?? 0.4);
  const [maxScenes, setMaxScenes] = useState<number>(seedAttrs.max_scenes_per_video ?? 10);
  const [model, setModel] = useState<string>(seedAttrs.model || 'gpt-4o');
  const [apiKeyEnvVar, setApiKeyEnvVar] = useState<string>(seedAttrs.api_key_env_var || 'OPENAI_API_KEY');
  const [summaryPrompt, setSummaryPrompt] = useState<string>(
    seedAttrs.summary_prompt || "Describe what's happening in this video frame in one or two sentences. Be specific about action, setting, and any visible text.",
  );
  const [saving, setSaving] = useState(false);

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'video_scene_summarizer';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        scene_threshold: sceneThreshold,
        max_scenes_per_video: maxScenes,
        model,
        api_key_env_var: apiKeyEnvVar,
        summary_prompt: summaryPrompt,
      };

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
        console.error('[VideoSceneConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — detecting scenes and summarizing each one.`);
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
            <Film className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit video scene summary' : 'Configure video scene summary'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <MediaPreviewPanel upstreamAssetKey={upstreamAssetKey} kind="video" />

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

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Scene sensitivity</label>
                <input
                  type="number" min={0} max={1} step={0.05}
                  value={sceneThreshold}
                  onChange={(e) => setSceneThreshold(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">0-1 — lower catches more/subtler cuts.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Max scenes per video</label>
                <input
                  type="number" min={1}
                  value={maxScenes}
                  onChange={(e) => setMaxScenes(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">What to look for in each scene</label>
              <textarea
                value={summaryPrompt}
                onChange={(e) => setSummaryPrompt(e.target.value)}
                rows={3}
                className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Model</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">Vision-capable — gpt-4o, claude-3-5-sonnet, gemini-1.5-pro.</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">API key env var</label>
                <input
                  type="text"
                  value={apiKeyEnvVar}
                  onChange={(e) => setApiKeyEnvVar(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {isEditing && onReviewScenes && (
            <button
              onClick={() => onReviewScenes(component!)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 border border-emerald-200 bg-emerald-50 rounded-md hover:bg-emerald-100 mr-auto"
            >
              <Film className="w-3.5 h-3.5" /> Review scenes
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
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Add component'}
          </button>
        </div>
      </div>
    </div>
  );
}
