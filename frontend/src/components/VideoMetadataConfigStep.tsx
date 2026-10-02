import { useEffect, useState } from 'react';
import { X, Loader2, Info, Sparkles } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { projectsApi, API_BASE } from '@/services/api';
import { notify } from './Notifications';
import { extractComponentId } from '@/lib/componentId';
import { MediaPreviewPanel } from './MediaPreviewPanel';
import { MediaProbeInfo } from './MediaProbeInfo';
import { useMediaProbe } from '@/hooks/useMediaProbe';
import { useUpstreamColumns, pickBestPathColumn } from '@/hooks/useUpstreamColumns';
import type { ComponentInstance } from '@/types';

/**
 * Bespoke config step for video_metadata_extractor -- same real-preview
 * treatment as video_scene_summarizer, previously missing entirely. Almost
 * no config to speak of (duration/resolution/fps/codec come straight out
 * of ffprobe, nothing to tune), so this is intentionally a small form.
 */
export function VideoMetadataConfigStep({
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
    seedAttrs.asset_name || component?.label || (upstreamAssetKey ? `${upstreamAssetKey}_metadata` : 'video_metadata'),
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
  const [saving, setSaving] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const { probe, isLoading: probeLoading } = useMediaProbe(currentProject?.id, activeFilePath);

  const canSave = assetName.trim().length > 0 && !!upstreamAssetKey && videoPathColumn.trim().length > 0;

  const handleSave = async () => {
    if (!currentProject || !canSave || saving) return;
    setSaving(true);
    try {
      const componentId = extractComponentId(componentType) || 'video_metadata_extractor';
      const config: Record<string, any> = {
        name: assetName.trim(),
        asset_name: assetName.trim(),
        upstream_asset_key: upstreamAssetKey,
        video_path_column: videoPathColumn.trim(),
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
        console.error('[VideoMetadataConfigStep] Failed to regenerate lineage:', e);
      }

      if (body.assets_regenerated) {
        notify.success(isEditing ? `Updated "${assetName.trim()}".` : `Added "${assetName.trim()}" — reading video metadata.`);
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
            <Info className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{isEditing ? 'Edit video metadata' : 'Configure video metadata'}</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden grid grid-cols-1 sm:grid-cols-[1fr_380px]">
          <MediaPreviewPanel upstreamAssetKey={upstreamAssetKey} kind="video" onActiveFileChange={setActiveFilePath} />

          <div className="space-y-4 overflow-y-auto px-6 py-4">
            <MediaProbeInfo probe={probe} isLoading={probeLoading} kind="video" />

            <div className="bg-blue-50 border border-blue-100 rounded-md p-3 text-xs text-blue-900 space-y-1">
              <p className="font-medium">How this works</p>
              <p>Reads container + stream metadata (duration, resolution, codec, fps, ...) via ffprobe — no LLM call, nothing to tune besides where to find the files.</p>
            </div>

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
