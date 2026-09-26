import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, FileText, ImageOff, ZoomIn, X } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi, API_BASE } from '@/services/api';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

/**
 * Shared document/image preview -- main image + a scrollable thumbnail
 * strip of every sample file found at the source, click-to-zoom lightbox.
 * Extracted by the bespoke extractor config steps (structured_document_
 * extractor first, ocr_extractor next) instead of copy-pasting this ~150
 * lines per extractor -- every future bespoke step in this family (image/
 * video/audio) should reuse this rather than re-implement it.
 *
 * Resolves a real fsspec path to preview from either `sourcePath` directly
 * (path mode) or `upstreamAssetKey` (upstream_asset_key mode: looks up the
 * matching component's own `path` attribute, e.g. file_lister's -- purely
 * for showing a preview, never persisted). Shows a placeholder when
 * neither resolves to a real path (e.g. the upstream isn't a component
 * with a known path, like a dbt model).
 */
export function DocumentPreviewPanel({
  sourcePath,
  upstreamAssetKey,
  onActiveImageChange,
}: {
  sourcePath?: string;
  upstreamAssetKey?: string;
  /** Fires with the currently-shown image's URL (or null when there
   *  isn't one) -- lets a parent that needs the actual pixels (e.g. the
   *  field-location annotator) stay in sync with whichever sample this
   *  panel is showing, without duplicating its own sample-files fetch. */
  onActiveImageChange?: (url: string | null) => void;
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

  const { data: sample, isLoading: sampleLoading } = useQuery({
    queryKey: ['document-preview-sample', currentProject?.id, resolvedPath],
    queryFn: () => assetsApi.sampleFiles(currentProject!.id, resolvedPath!, 12),
    enabled: !!currentProject && !!resolvedPath,
  });
  const files = sample?.files || [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const previewFile = files[activeIndex];
  const previewIsImage = previewFile ? IMAGE_EXTENSIONS.test(previewFile.path) : false;
  const previewUrl = (f: { path: string }) =>
    `${API_BASE}/assets/${currentProject?.id}/local-file?path=${encodeURIComponent(f.path)}`;

  useEffect(() => {
    onActiveImageChange?.(previewFile && previewIsImage ? previewUrl(previewFile) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFile?.path, previewIsImage]);

  return (
    <>
      <div className="flex flex-col min-w-0 border-r border-gray-100 bg-gray-50">
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          {!resolvedPath ? (
            <div className="flex flex-col items-center gap-1.5 text-gray-300 px-3 text-center">
              <ImageOff className="w-8 h-8" />
              <span className="text-xs">no preview available for this source</span>
            </div>
          ) : sampleLoading ? (
            <Loader2 className="w-6 h-6 text-gray-300 animate-spin" />
          ) : previewFile && previewIsImage ? (
            <button
              onClick={() => setZoomed(true)}
              className="relative group max-w-full max-h-full rounded-lg overflow-hidden border border-gray-200 bg-white shadow-sm"
              title="Click to zoom"
            >
              <img src={previewUrl(previewFile)} alt={previewFile.name} className="max-w-full max-h-[calc(90vh-220px)] object-contain" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-90 drop-shadow" />
              </div>
            </button>
          ) : previewFile ? (
            <div className="flex flex-col items-center gap-1.5 text-gray-400 px-3 text-center">
              <FileText className="w-10 h-10" />
              <span className="text-xs break-all">{previewFile.name}</span>
              <span className="text-[10px] text-gray-400">no inline preview for this file type</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 text-gray-300 px-3 text-center">
              <ImageOff className="w-8 h-8" />
              <span className="text-xs">no matching files found</span>
            </div>
          )}
        </div>
        {files.length > 0 && (
          <div className="flex-shrink-0 border-t border-gray-200 bg-white px-3 py-2 flex items-center gap-2 overflow-x-auto">
            {files.map((f, i) => (
              <button
                key={f.path}
                onClick={() => setActiveIndex(i)}
                title={f.name}
                className={`flex-shrink-0 w-12 h-14 rounded border overflow-hidden bg-gray-100 flex items-center justify-center ${
                  i === activeIndex ? 'border-primary ring-2 ring-primary/30' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                {IMAGE_EXTENSIONS.test(f.path) ? (
                  <img src={previewUrl(f)} alt={f.name} className="w-full h-full object-cover" />
                ) : (
                  <FileText className="w-4 h-4 text-gray-400" />
                )}
              </button>
            ))}
          </div>
        )}
        <p className="flex-shrink-0 text-[11px] text-gray-400 text-center py-1.5 border-t border-gray-100 bg-white">
          {files.length > 0 ? `${activeIndex + 1} of ${files.length} real file(s) from your source` : 'Preview'}
        </p>
      </div>

      {zoomed && previewFile && previewIsImage && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-8"
          onClick={() => setZoomed(false)}
        >
          <button onClick={() => setZoomed(false)} className="absolute top-4 right-4 text-white/70 hover:text-white" aria-label="Close zoom">
            <X className="w-6 h-6" />
          </button>
          <img src={previewUrl(previewFile)} alt={previewFile.name} className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </>
  );
}
