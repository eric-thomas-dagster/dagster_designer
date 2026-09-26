import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle, FileText } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { assetsApi } from '@/services/api';

/**
 * Text-row counterpart to DocumentPreviewPanel -- for classifiers reading
 * a text column instead of images. Prefers reading the upstream's raw
 * source file directly (dataframe_from_csv's `file_path`, or a generic
 * `path` attribute) via sample-rows, same "works before materialization"
 * reasoning as DocumentPreviewPanel's sample-files -- a freshly-added
 * source has never been materialized yet, so gating on that (as this
 * used to, via previewData alone) meant the FIRST thing you saw after
 * adding a source was a dead end. Falls back to previewData (requires a
 * real materialize) only when no raw file path is resolvable, e.g. the
 * upstream is a dbt model or warehouse table.
 */
export function TextSamplePreviewPanel({
  upstreamAssetKey,
  column,
}: {
  upstreamAssetKey?: string;
  column?: string;
}) {
  const { currentProject } = useProjectStore();
  const resolvedPath = useMemo(() => {
    if (!upstreamAssetKey || !currentProject) return undefined;
    const comp = currentProject.components.find((c) => (c.attributes?.asset_name || c.id) === upstreamAssetKey);
    return (comp?.attributes?.file_path as string | undefined) || (comp?.attributes?.path as string | undefined) || undefined;
  }, [upstreamAssetKey, currentProject]);

  const rawQuery = useQuery({
    queryKey: ['text-sample-preview-raw', currentProject?.id, resolvedPath],
    queryFn: () => assetsApi.sampleRows(currentProject!.id, resolvedPath!, 8),
    enabled: !!currentProject && !!resolvedPath,
  });
  const materializedQuery = useQuery({
    queryKey: ['text-sample-preview', currentProject?.id, upstreamAssetKey],
    queryFn: () => assetsApi.previewData(currentProject!.id, upstreamAssetKey!, { sampleLimit: 8 }),
    enabled: !!currentProject && !!upstreamAssetKey && !resolvedPath,
  });

  const usingRaw = !!resolvedPath;
  const isLoading = usingRaw ? rawQuery.isLoading : materializedQuery.isLoading;
  const rawOk = usingRaw && !rawQuery.error && !rawQuery.data?.error && (rawQuery.data?.rows.length ?? 0) > 0;
  const materializedOk = !usingRaw && materializedQuery.data?.success && (materializedQuery.data.data?.length ?? 0) > 0;
  const rows: Record<string, any>[] = rawOk ? rawQuery.data!.rows : materializedOk ? materializedQuery.data!.data! : [];
  const columns: string[] = rawOk ? rawQuery.data!.columns : materializedOk ? materializedQuery.data!.columns || [] : [];
  const errorMessage = usingRaw
    ? rawQuery.data?.error || (rawQuery.error ? String(rawQuery.error) : undefined)
    : materializedQuery.data?.error;
  const colExists = !!column && columns.includes(column);

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
        ) : rows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-gray-400 px-4 text-center">
            <AlertCircle className="w-6 h-6 text-amber-400" />
            <span className="text-xs">{errorMessage || 'Materialize this source at least once to preview its rows here.'}</span>
          </div>
        ) : !colExists ? (
          <div className="h-full flex flex-col items-center justify-center gap-1.5 text-gray-400 px-4 text-center">
            <AlertCircle className="w-6 h-6 text-amber-400" />
            <span className="text-xs">Column '{column}' not found in this source's columns: {columns.join(', ')}</span>
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
