import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Loader2, AlertCircle, ImageOff, RefreshCw } from 'lucide-react';
import { assetsApi, API_BASE } from '@/services/api';

// Columns that came from the SOURCE (file_lister's own output shape),
// not from extraction -- excluded from the "extracted fields" side of
// each card so it only shows what the extractor actually added.
const SOURCE_COLUMNS = new Set(['path', 'local_path', 'filename', 'size', 'modified_at']);
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

function formatFieldValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) {
    if (v.length === 0) return '—';
    if (typeof v[0] === 'object') return v.map((item) => JSON.stringify(item)).join('\n');
    return v.join(', ');
  }
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

/**
 * Clean, visual review for a document/image extractor's output: source
 * image next to what actually got extracted from it, one card per row --
 * built for the "does this actually work, can I ship it" moment before
 * trusting an extraction pipeline. Reuses the existing preview endpoint
 * (assetsApi.previewData) for row data; local images are served through
 * a new backend endpoint (GET /assets/{project}/local-file) since the
 * app has no other local-filesystem-to-webview path.
 */
export function DocumentExtractionReview({
  projectId,
  assetKey,
  onClose,
}: {
  projectId: string;
  assetKey: string;
  onClose: () => void;
}) {
  const [failedImages, setFailedImages] = useState<Set<number>>(new Set());
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['document-extraction-review', projectId, assetKey],
    queryFn: () => assetsApi.previewData(projectId, assetKey, { sampleLimit: 50, noCache: true }),
  });

  const imageColumn = useMemo(() => {
    const cols = data?.columns || [];
    if (cols.includes('local_path')) return 'local_path';
    if (cols.includes('path') && (data?.data || []).some((r) => IMAGE_EXTENSIONS.test(String(r.path || '')))) return 'path';
    return null;
  }, [data]);

  const extractedFieldColumns = useMemo(
    () => (data?.columns || []).filter((c) => !SOURCE_COLUMNS.has(c)),
    [data],
  );

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold">Extraction Review</h2>
            <p className="text-xs text-gray-500 font-mono mt-0.5">{assetKey}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md disabled:opacity-50"
              title="Re-run the preview"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button onClick={onClose} aria-label="Close">
              <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 bg-gray-50">
          {isLoading && (
            <div className="flex items-center justify-center h-full text-gray-500 text-sm gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading extraction results…
            </div>
          )}

          {!isLoading && (error || data?.error) && (
            <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-gray-500">
              <AlertCircle className="w-8 h-8 text-amber-400" />
              <p className="text-sm max-w-md">
                {data?.error || 'Could not load a preview — materialize this asset first, then review it here.'}
              </p>
            </div>
          )}

          {!isLoading && !error && data?.success && (!data.data || data.data.length === 0) && (
            <div className="flex items-center justify-center h-full text-sm text-gray-400">
              No rows yet — materialize this asset to see results here.
            </div>
          )}

          {!isLoading && data?.success && data.data && data.data.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {data.data.map((row, i) => {
                const imgPath = imageColumn ? row[imageColumn] : null;
                const imgFailed = failedImages.has(i);
                return (
                  <div key={i} className="bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col">
                    <div className="aspect-[4/3] bg-gray-100 flex items-center justify-center overflow-hidden">
                      {imgPath && !imgFailed ? (
                        <img
                          src={`${API_BASE}/assets/${projectId}/local-file?path=${encodeURIComponent(String(imgPath))}`}
                          alt={row.filename || `row ${i}`}
                          className="w-full h-full object-contain"
                          onError={() => setFailedImages((prev) => new Set(prev).add(i))}
                        />
                      ) : (
                        <div className="flex flex-col items-center gap-1 text-gray-300">
                          <ImageOff className="w-6 h-6" />
                          <span className="text-[10px]">no preview</span>
                        </div>
                      )}
                    </div>
                    <div className="p-2.5 space-y-1.5 flex-1 min-w-0">
                      {row.filename && (
                        <div className="text-xs font-medium text-gray-900 truncate" title={row.filename}>
                          {row.filename}
                        </div>
                      )}
                      <div className="space-y-1">
                        {extractedFieldColumns.length === 0 ? (
                          <p className="text-[11px] text-gray-400 italic">No extracted fields yet.</p>
                        ) : (
                          extractedFieldColumns.map((col) => (
                            <div key={col} className="text-[11px]">
                              <span className="text-gray-400">{col}:</span>{' '}
                              <span className="text-gray-700 whitespace-pre-wrap break-words">{formatFieldValue(row[col])}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
