import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, FileVideo, FileAudio, AlertCircle } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, API_BASE } from '@/services/api';

/**
 * Video/audio counterpart to DocumentPreviewPanel -- a native <video>/
 * <audio> player instead of an <img>, same "works before materialization"
 * reasoning (sample-files lists raw files directly, no Dagster
 * involved). No zoom lightbox (doesn't apply to media playback); a
 * thumbnail strip doesn't make sense for audio, so this is a simpler
 * list-of-files + player layout instead of DocumentPreviewPanel's
 * image-grid-strip.
 */
export function MediaPreviewPanel({
  sourcePath,
  upstreamAssetKey,
  kind,
  onActiveFileChange,
}: {
  sourcePath?: string;
  upstreamAssetKey?: string;
  kind: 'video' | 'audio';
  onActiveFileChange?: (path: string | null) => void;
}) {
  const { currentProject } = useProjectStore();
  const resolvedPath = useMemo(() => {
    if (sourcePath) return sourcePath;
    if (upstreamAssetKey && currentProject) {
      const comp = currentProject.components.find((c) => (c.attributes?.asset_name || c.id) === upstreamAssetKey);
      return (comp?.attributes?.path as string | undefined) || undefined;
    }
    return undefined;
  }, [sourcePath, upstreamAssetKey, currentProject]);

  const { data: sample, isLoading } = useQuery({
    queryKey: ['media-preview-sample', currentProject?.id, resolvedPath],
    queryFn: () => assetsApi.sampleFiles(currentProject!.id, resolvedPath!, 12),
    enabled: !!currentProject && !!resolvedPath,
  });
  const files = sample?.files || [];
  const [activeIndex, setActiveIndex] = useState(0);
  const activeFile = files[activeIndex];
  const fileUrl = (f: { path: string }) => `${API_BASE}/assets/${currentProject?.id}/local-file?path=${encodeURIComponent(f.path)}`;

  useEffect(() => {
    onActiveFileChange?.(activeFile?.path || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile?.path]);

  const Icon = kind === 'video' ? FileVideo : FileAudio;

  return (
    <div className="flex flex-col min-w-0 border-r border-gray-100 bg-gray-50">
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        {!resolvedPath ? (
          <div className="flex flex-col items-center gap-1.5 text-gray-300 px-3 text-center">
            <Icon className="w-8 h-8" />
            <span className="text-xs">no preview available for this source</span>
          </div>
        ) : isLoading ? (
          <Loader2 className="w-6 h-6 text-gray-300 animate-spin" />
        ) : activeFile ? (
          kind === 'video' ? (
            <video key={activeFile.path} src={fileUrl(activeFile)} controls className="max-w-full max-h-[calc(90vh-260px)] rounded-lg border border-gray-200 bg-black" />
          ) : (
            <div className="w-full max-w-sm flex flex-col items-center gap-3">
              <FileAudio className="w-16 h-16 text-gray-300" />
              <audio key={activeFile.path} src={fileUrl(activeFile)} controls className="w-full" />
            </div>
          )
        ) : (
          <div className="flex flex-col items-center gap-1 text-gray-300 px-3 text-center">
            <AlertCircle className="w-8 h-8" />
            <span className="text-xs">no matching files found</span>
          </div>
        )}
      </div>
      {files.length > 0 && (
        <div className="flex-shrink-0 border-t border-gray-200 bg-white max-h-32 overflow-y-auto">
          {files.map((f, i) => (
            <button
              key={f.path}
              onClick={() => setActiveIndex(i)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs truncate ${
                i === activeIndex ? 'bg-primary/10 text-primary font-medium' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{f.name}</span>
            </button>
          ))}
        </div>
      )}
      <p className="flex-shrink-0 text-[11px] text-gray-400 text-center py-1.5 border-t border-gray-100 bg-white">
        {files.length > 0 ? `${activeIndex + 1} of ${files.length} real file(s) from your source` : 'Preview'}
      </p>
    </div>
  );
}
