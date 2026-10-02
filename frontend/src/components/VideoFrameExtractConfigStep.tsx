import { useEffect, useState } from 'react';
import { X, Loader2, Image as ImageIcon, Sparkles, Lightbulb } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { MediaPreviewPanel } from './MediaPreviewPanel';
import { MediaProbeInfo } from './MediaProbeInfo';
import { PathPickerButton } from './PathPickerButton';
import { useMediaProbe } from '@/hooks/useMediaProbe';
import { useUpstreamColumns, pickBestPathColumn } from '@/hooks/useUpstreamColumns';
import { suggestFrameInterval, estimateFrameCount } from '@/lib/mediaSuggestions';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for video_frame_extract_asset -- same real-preview
 * treatment as video_scene_summarizer (MediaPreviewPanel's <video> player
 * against the same upstream file-listing asset), previously missing
 * entirely: this target fell through to the blind generic form with zero
 * visual feedback.
 */
export function VideoFrameExtractConfigStep({
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
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_frames` : 'extracted_frames'),
  );
  const videoPathColumnExplicitlySet = !!seedAttrs.video_path_column;
  const [videoPathColumn, setVideoPathColumn] = useState<string>(seedAttrs.video_path_column || 'file_path');
  const { columns: upstreamColumns } = useUpstreamColumns(currentProject?.id, upstreamAssetKey);
  useEffect(() => {
    if (!videoPathColumnExplicitlySet && upstreamColumns.length > 0) {
      setVideoPathColumn(pickBestPathColumn(upstreamColumns, 'file_path'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstreamColumns.join(',')]);
  const [outputDir, setOutputDir] = useState<string>(seedAttrs.output_dir || '/tmp/extracted_frames');
  const [imageFormat, setImageFormat] = useState<'jpg' | 'png'>(seedAttrs.image_format || 'jpg');
  const [mode, setMode] = useState<'every_seconds' | 'every_n_frames' | 'fixed_count'>(seedAttrs.mode || 'every_seconds');
  const [everySeconds, setEverySeconds] = useState<number>(seedAttrs.every_seconds ?? 1.0);
  const [everyNFrames, setEveryNFrames] = useState<number>(seedAttrs.every_n_frames ?? 30);
  const [fixedCount, setFixedCount] = useState<number>(seedAttrs.fixed_count ?? 10);
  const [saving, setSaving] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  const { probe, isLoading: probeLoading } = useMediaProbe(currentProject?.id, activeFilePath);
  const suggestedInterval = suggestFrameInterval(probe?.duration_seconds);
  const currentFrameCount = mode === 'every_seconds' ? estimateFrameCount(probe?.duration_seconds, everySeconds) : null;
  const suggestedFrameCount = suggestedInterval != null ? estimateFrameCount(probe?.duration_seconds, suggestedInterval) : null;
  // Only worth surfacing when the current setting is way off (>2x or <0.5x
  // the suggested count) -- otherwise this would nag on every reasonable
  // choice, the exact noise complaint the tabular suggestions strip fixed.
  const showIntervalSuggestion = mode === 'every_seconds' && suggestedInterval != null && suggestedInterval !== everySeconds
    && currentFrameCount != null && suggestedFrameCount != null
    && (currentFrameCount > suggestedFrameCount * 2 || currentFrameCount < suggestedFrameCount * 0.5);

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey && videoPathColumn.trim().length > 0;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'video_frame_extract_asset';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        video_path_column: videoPathColumn.trim(),
        output_dir: outputDir.trim() || '/tmp/extracted_frames',
        image_format: imageFormat,
        mode,
        ...(mode === 'every_seconds' ? { every_seconds: everySeconds }
          : mode === 'every_n_frames' ? { every_n_frames: everyNFrames }
          : { fixed_count: fixedCount }),
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
        console.error('[VideoFrameExtractConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — extracting frames.`);
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
            <ImageIcon className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit frame extraction' : 'Configure frame extraction'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <MediaPreviewPanel upstreamAssetKey={upstreamAssetKey} kind="video" onActiveFileChange={setActiveFilePath} />

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            <MediaProbeInfo probe={probe} isLoading={probeLoading} kind="video" />

            {showIntervalSuggestion && (
              <div className="flex items-start gap-2 px-3 py-2 border border-blue-200 bg-blue-50 rounded-md">
                <Lightbulb className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0 text-xs text-blue-900">
                  <p>
                    Every {everySeconds}s over {probe?.duration_seconds ? `${Math.round(probe.duration_seconds)}s` : 'this video'} yields ~{currentFrameCount} frames.
                    Every {suggestedInterval}s would yield ~{suggestedFrameCount} — usually a better balance.
                  </p>
                  <button
                    onClick={() => setEverySeconds(suggestedInterval!)}
                    className="mt-1.5 px-2 py-1 text-[11px] font-medium bg-white border border-blue-300 text-blue-700 rounded hover:bg-blue-100"
                  >
                    Use every {suggestedInterval}s
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
              <label className="block text-xs font-medium text-gray-700 mb-1">Video path column</label>
              {upstreamColumns.length > 0 ? (
                <select
                  value={upstreamColumns.includes(videoPathColumn) ? videoPathColumn : ''}
                  onChange={(e) => setVideoPathColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white font-mono"
                >
                  {!upstreamColumns.includes(videoPathColumn) && <option value="" disabled>{videoPathColumn} (not found — pick one)</option>}
                  {upstreamColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={videoPathColumn}
                  onChange={(e) => setVideoPathColumn(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              )}
              <p className="text-[10px] text-gray-400 mt-0.5">Column in the upstream DataFrame holding each video's local file path.</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">How to sample frames</label>
              <div className="grid grid-cols-3 gap-1.5 mb-2">
                {(['every_seconds', 'every_n_frames', 'fixed_count'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-2 py-1.5 text-xs rounded-md border ${mode === m ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                  >
                    {m === 'every_seconds' ? 'Every N sec' : m === 'every_n_frames' ? 'Every N frames' : 'Fixed count'}
                  </button>
                ))}
              </div>
              {mode === 'every_seconds' ? (
                <input
                  type="number" min={0.1} step={0.1}
                  value={everySeconds}
                  onChange={(e) => setEverySeconds(Math.max(0.1, Number(e.target.value) || 0.1))}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md font-mono"
                />
              ) : mode === 'every_n_frames' ? (
                <input
                  type="number" min={1}
                  value={everyNFrames}
                  onChange={(e) => setEveryNFrames(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md font-mono"
                />
              ) : (
                <input
                  type="number" min={1}
                  value={fixedCount}
                  onChange={(e) => setFixedCount(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md font-mono"
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Image format</label>
                <div className="flex gap-2">
                  {(['jpg', 'png'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setImageFormat(f)}
                      className={`flex-1 px-2.5 py-1.5 text-xs rounded-md border uppercase ${imageFormat === f ? 'bg-primary text-primary-foreground border-primary' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Output directory</label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={outputDir}
                    onChange={(e) => setOutputDir(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded-md font-mono"
                  />
                  <PathPickerButton mode="directory" title="Choose an output folder for extracted frames" onPicked={setOutputDir} />
                </div>
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
