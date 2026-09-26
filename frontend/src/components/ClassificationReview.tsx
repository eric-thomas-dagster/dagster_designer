import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Loader2, AlertCircle, RefreshCw, BrainCircuit } from 'lucide-react';
import { assetsApi, API_BASE } from '@/services/api';

const BADGE_COLORS = ['bg-violet-50 text-violet-700 border-violet-100', 'bg-blue-50 text-blue-700 border-blue-100', 'bg-emerald-50 text-emerald-700 border-emerald-100'];
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

function formatValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Review UI for a classifier's materialized output -- each row next to
 * whatever it got classified as, mirroring DocumentExtractionReview's "does
 * this actually work" moment but for classifiers. Deliberately generic
 * across text_classifier/zero_shot_classifier/image_classifier instead of
 * hardcoding each one's own output column names (category+confidence /
 * predicted_label+scores / predicted_class+score): anything that isn't the
 * known INPUT column is treated as a predicted output and shown as a badge.
 */
export function ClassificationReview({
  projectId,
  assetKey,
  inputColumn,
  isImage = false,
  onClose,
}: {
  projectId: string;
  assetKey: string;
  inputColumn?: string;
  isImage?: boolean;
  onClose: () => void;
}) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['classification-review', projectId, assetKey],
    queryFn: () => assetsApi.previewData(projectId, assetKey, { sampleLimit: 50, noCache: true }),
  });

  const outputColumns = useMemo(
    () => (data?.columns || []).filter((c) => c !== inputColumn),
    [data, inputColumn],
  );

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <BrainCircuit className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">Classification results</h2>
              <p className="text-xs text-gray-500 font-mono mt-0.5">{assetKey}</p>
            </div>
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
              <Loader2 className="w-4 h-4 animate-spin" /> Loading classification results…
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
            <div className="space-y-2">
              {data.data.map((row, i) => (
                <div key={i} className="bg-white border border-gray-200 rounded-lg p-3 flex gap-3 items-start">
                  {isImage && inputColumn && IMAGE_EXTENSIONS.test(String(row[inputColumn] || '')) ? (
                    <img
                      src={`${API_BASE}/assets/${projectId}/local-file?path=${encodeURIComponent(String(row[inputColumn]))}`}
                      alt=""
                      className="w-16 h-16 object-cover rounded border border-gray-200 flex-shrink-0"
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    {inputColumn && (
                      <p className="text-sm text-gray-700 whitespace-pre-wrap break-words mb-1.5">
                        {isImage ? String(row[inputColumn]).split('/').pop() : formatValue(row[inputColumn])}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {outputColumns.map((col, ci) => (
                        <span
                          key={col}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border font-mono ${BADGE_COLORS[ci % BADGE_COLORS.length]}`}
                        >
                          <span className="opacity-60">{col}:</span> {formatValue(row[col])}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
