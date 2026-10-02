import { useQuery } from '@tanstack/react-query';
import { X, Loader2, AlertCircle, RefreshCw, Gauge } from 'lucide-react';
import { assetsApi } from '@/services/api';
import { hasModelMetrics } from '@/lib/modelMetrics';
import { ModelMetricsView } from './ModelMetricsView';

/**
 * Modal wrapper around ModelMetricsView -- fetches the asset's latest
 * materialization metadata and hands it to the shared, component-agnostic
 * renderer (see AssetDetailPage's Model tab for the same view used
 * inline, gated on any asset rather than just automl_asset).
 */
export function ModelEvaluationPanel({
  projectId,
  assetKey,
  onClose,
}: {
  projectId: string;
  assetKey: string;
  onClose: () => void;
}) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['model-evaluation', projectId, assetKey],
    queryFn: () => assetsApi.getAssetEvents(projectId, assetKey, 1),
  });

  const latest = data?.events?.[0];
  const entries = latest?.metadata || [];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Gauge className="w-5 h-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">Model evaluation</h2>
              <p className="text-xs text-gray-500 font-mono mt-0.5">{assetKey}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md disabled:opacity-50"
              title="Re-fetch the latest materialization"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button onClick={onClose} aria-label="Close">
              <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 bg-gray-50 space-y-6">
          {isLoading && (
            <div className="flex items-center justify-center h-40 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
            </div>
          )}

          {!isLoading && error && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-100 rounded-md p-3">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              Couldn't load materialization history.
            </div>
          )}

          {!isLoading && !error && !latest && (
            <div className="flex items-center gap-2 text-sm text-gray-500 bg-white border border-gray-200 rounded-md p-4">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              No materializations yet — run this asset to see its evaluation.
            </div>
          )}

          {!isLoading && !error && latest && !hasModelMetrics(entries) && (
            <div className="flex items-center gap-2 text-sm text-gray-500 bg-white border border-gray-200 rounded-md p-4">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              This materialization has no model metrics attached yet — re-run the asset after updating to a version that emits them.
            </div>
          )}

          {!isLoading && !error && latest && <ModelMetricsView entries={entries} />}
        </div>
      </div>
    </div>
  );
}
