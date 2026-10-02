import { useQuery } from '@tanstack/react-query';
import { assetsApi } from '@/services/api';

/** Real column names for an upstream asset, via the same live-preview
 *  path TextSamplePreviewPanel/ClassifierConfigStep already use -- lets a
 *  "which column has the file path" field be a real dropdown instead of a
 *  blind text guess. file_lister (the upstream every video/audio wizard
 *  creates) outputs `path`/`local_path`/`filename`/`size`/`modified_at`,
 *  never `file_path` -- a plain text default had no way to reflect that. */
export function useUpstreamColumns(projectId: string | undefined, upstreamAssetKey: string | undefined): { columns: string[]; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['upstream-columns-for-path-field', projectId, upstreamAssetKey],
    queryFn: () => assetsApi.previewData(projectId!, upstreamAssetKey!, { sampleLimit: 5 }),
    enabled: !!projectId && !!upstreamAssetKey,
    staleTime: 30_000,
  });
  return { columns: data?.success ? (data.columns || []) : [], isLoading };
}

/** Picks the best real column to pre-select for a "local file path"
 *  field -- prefers file_lister's own `local_path` (the column that's
 *  actually readable by ffmpeg/ffprobe/CLIP, since `path` may be a
 *  remote fsspec URI that was never downloaded), falls back to `path`,
 *  then to whatever fallback the caller's own component default is. */
export function pickBestPathColumn(columns: string[], fallback: string): string {
  if (columns.includes('local_path')) return 'local_path';
  if (columns.includes('path')) return 'path';
  if (columns.includes(fallback)) return fallback;
  return fallback;
}
