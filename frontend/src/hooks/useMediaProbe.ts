import { useQuery } from '@tanstack/react-query';
import { assetsApi, type MediaProbeResult } from '@/services/api';

/** Real ffprobe metadata for whichever file MediaPreviewPanel is
 *  currently showing -- feeds the "analyze and suggest" banners in the
 *  video/audio config steps. `path` should come from MediaPreviewPanel's
 *  onActiveFileChange, so this always probes the actual sample file the
 *  user is looking at, not a guess. */
export function useMediaProbe(projectId: string | undefined, path: string | null): { probe: MediaProbeResult | undefined; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['media-probe', projectId, path],
    queryFn: () => assetsApi.mediaProbe(projectId!, path!),
    enabled: !!projectId && !!path,
    staleTime: 60_000,
  });
  return { probe: data, isLoading: isLoading && !!path };
}
