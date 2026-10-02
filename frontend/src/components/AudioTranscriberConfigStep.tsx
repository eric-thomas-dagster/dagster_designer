import { useEffect, useState } from 'react';
import { X, Loader2, Mic, Sparkles, Lightbulb } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { MediaPreviewPanel } from './MediaPreviewPanel';
import { MediaProbeInfo } from './MediaProbeInfo';
import { useMediaProbe } from '@/hooks/useMediaProbe';
import { useUpstreamColumns, pickBestPathColumn } from '@/hooks/useUpstreamColumns';
import { suggestWhisperModelSize } from '@/lib/mediaSuggestions';
import type { ComponentInstance } from '@/types';

const MODEL_SIZES = ['tiny', 'base', 'small', 'medium', 'large'] as const;

/**
 * Bespoke config step for audio_transcriber (plain Whisper, no speaker
 * diarization) -- same real-preview treatment as audio_diarized_transcriber,
 * previously missing entirely. audio_path_column now defaults to
 * "audio_path" (fixed alongside this in the component itself, matching
 * every sibling in the video/audio family).
 */
export function AudioTranscriberConfigStep({
  componentType,
  component,
  initialAttributes,
  onDone,
  onClose,
}: {
  componentType: string;
  component?: ComponentInstance | null;
  initialAttributes?: Record<string, any>;
  onDone: () => void;
  onClose: () => void;
}) {
  const { currentProject, loadProject } = useProjectStore();
  const isEditing = !!component;
  const seedAttrs = component?.attributes || initialAttributes || {};
  const upstreamAssetKey: string | undefined = seedAttrs.upstream_asset_key;

  const [assetName, setAssetName] = useState<string>(
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_transcribed` : 'transcribed'),
  );
  const audioPathColumnExplicitlySet = !!seedAttrs.audio_path_column;
  const [audioPathColumn, setAudioPathColumn] = useState<string>(seedAttrs.audio_path_column || 'audio_path');
  const { columns: upstreamColumns } = useUpstreamColumns(currentProject?.id, upstreamAssetKey);
  useEffect(() => {
    if (!audioPathColumnExplicitlySet && upstreamColumns.length > 0) {
      setAudioPathColumn(pickBestPathColumn(upstreamColumns, 'audio_path'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstreamColumns.join(',')]);
  const [outputColumn, setOutputColumn] = useState<string>(seedAttrs.output_column || 'transcription');
  const [modelSize, setModelSize] = useState<(typeof MODEL_SIZES)[number]>(seedAttrs.model_size || 'base');
  const [language, setLanguage] = useState<string>(seedAttrs.language || '');
  const [saving, setSaving] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  const { probe, isLoading: probeLoading } = useMediaProbe(currentProject?.id, activeFilePath);
  const suggestedModelSize = suggestWhisperModelSize(probe?.duration_seconds);
  const showModelSizeSuggestion = suggestedModelSize != null && suggestedModelSize !== modelSize
    && MODEL_SIZES.indexOf(suggestedModelSize) < MODEL_SIZES.indexOf(modelSize);

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey && audioPathColumn.trim().length > 0;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'audio_transcriber';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        audio_path_column: audioPathColumn.trim(),
        output_column: outputColumn.trim() || 'transcription',
        model_size: modelSize,
      };
      if (language.trim()) config.language = language.trim();

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
        console.error('[AudioTranscriberConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — transcribing audio.`);
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
            <Mic className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit transcription' : 'Configure transcription'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <MediaPreviewPanel upstreamAssetKey={upstreamAssetKey} kind="audio" onActiveFileChange={setActiveFilePath} />

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            <MediaProbeInfo probe={probe} isLoading={probeLoading} kind="audio" />

            {showModelSizeSuggestion && (
              <div className="flex items-start gap-2 px-3 py-2 border border-blue-200 bg-blue-50 rounded-md">
                <Lightbulb className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-xs text-blue-900">
                  <p>This clip runs long — "{suggestedModelSize}" transcribes noticeably faster than "{modelSize}" with a reasonable accuracy trade-off.</p>
                  <button
                    onClick={() => setModelSize(suggestedModelSize!)}
                    className="mt-1.5 px-2 py-1 text-[11px] font-medium bg-white border border-blue-300 text-blue-700 rounded hover:bg-blue-100 capitalize"
                  >
                    Use "{suggestedModelSize}"
                  </button>
                </div>
              </div>
            )}

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
              <label className="block text-xs font-medium text-gray-700 mb-1">Audio path column</label>
              {upstreamColumns.length > 0 ? (
                <select
                  value={upstreamColumns.includes(audioPathColumn) ? audioPathColumn : ''}
                  onChange={(e) => setAudioPathColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                >
                  {!upstreamColumns.includes(audioPathColumn) && <option value="" disabled>{audioPathColumn} (not found — pick one)</option>}
                  {upstreamColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={audioPathColumn}
                  onChange={(e) => setAudioPathColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              )}
              <p className="text-[10px] text-gray-400 mt-0.5">Column in the upstream DataFrame holding each clip's local file path.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Whisper model size</label>
              <div className="grid grid-cols-5 gap-1.5">
                {MODEL_SIZES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setModelSize(s)}
                    className={`px-1.5 py-1.5 text-xs rounded-md border capitalize ${modelSize === s ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5">Bigger is more accurate and slower.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Language</label>
                <input
                  type="text"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="auto-detect"
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Output column</label>
                <input
                  type="text"
                  value={outputColumn}
                  onChange={(e) => setOutputColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-200">
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
