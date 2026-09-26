import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle, FileText } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi } from '@/services/api';

/**
 * Text-row counterpart to DocumentPreviewPanel -- for classifiers reading
 * a text column instead of images. Requires the upstream asset to already
 * be materialized (previewData reads from run history, not a live
 * execution), unlike DocumentPreviewPanel's sample-files endpoint which
 * lists raw files directly -- there's no equivalent "peek at a column's
 * values" without Dagster having actually produced the DataFrame at least
 * once, so this degrades to a clear placeholder instead when it hasn't.
 */
export function TextSamplePreviewPanel({
  upstreamAssetKey,
  column,
}: {
  upstreamAssetKey?: string;
  column?: string;
}) {
  const { currentProject } = useProjectStore();
  const { data, isLoading, error } = useQuery({
    queryKey: ['text-sample-preview', currentProject?.id, upstreamAssetKey],
    queryFn: () => assetsApi.previewData(currentProject!.id, upstreamAssetKey!, { sampleLimit: 8 }),
    enabled: !!currentProject && !!upstreamAssetKey,
  });

  const rows = data?.success ? data.data || [] : [];
  const colExists = !!column && (data?.columns || []).includes(column);

  return (
    <div className="flex flex-col min-w-0 border-r border-gray-100 bg-gray-50">
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
        {!upstreamAssetKey ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-gray-300 px-3 text-center">
            <FileText className="w-8 h-8" />
            <span className="text-xs">pick a source to preview its rows</span>
          </div>
        ) : isLoading ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-gray-300 animate-spin" />
          </div>
        ) : error || !data?.success || rows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-gray-400 px-4 text-center">
            <AlertCircle className="w-6 h-6 text-amber-400" />
            <span className="text-xs">{data?.error || 'Materialize this source at least once to preview its rows here.'}</span>
          </div>
        ) : !colExists ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-gray-400 px-4 text-center">
            <AlertCircle className="w-6 h-6 text-amber-400" />
            <span className="text-xs">Column '{column}' not found in this source's columns: {(data?.columns || []).join(', ')}</span>
          </div>
        ) : (
          rows.map((row, i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-md p-2.5 text-xs text-gray-700 whitespace-pre-wrap break-words">
              {String(row[column!] ?? '—')}
            </div>
          ))
        )}
      </div>
      <p className="flex-shrink-0 text-[11px] text-gray-400 text-center py-1.5 border-t border-gray-100 bg-white">
        {rows.length > 0 ? `${rows.length} real row(s) from your source` : 'Preview'}
      </p>
    </div>
  );
}
