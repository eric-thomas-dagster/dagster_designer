import { useCallback, useEffect, useState } from 'react';
import { previewApi, type RemotePreviewState } from '@/services/api';

/**
 * useRemotePreviews — poll `/preview/remote-status` for BD-backed
 * previews the project has running. Distinct from `usePreviews`
 * (which tracks laptop `dagster dev` subprocesses).
 *
 * Keyed by `(base_deployment, location_name)` for O(1) lookup per draft.
 */
export function useRemotePreviews(projectId: string | null, opts?: { paused?: boolean }) {
  const paused = !!opts?.paused;
  const [previews, setPreviews] = useState<RemotePreviewState[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!projectId || paused) { setPreviews([]); return; }
    let alive = true;
    const poll = () => {
      previewApi.remoteStatus(projectId)
        .then((r) => { if (alive) setPreviews(r.remote_previews); })
        .catch(() => { /* ignore transient errors */ });
    };
    poll();
    const iv = setInterval(poll, 5000);   // slower than laptop poll — nothing streams
    return () => { alive = false; clearInterval(iv); };
  }, [projectId, paused, refreshKey]);

  const byKey = new Map<string, RemotePreviewState>();
  for (const p of previews) {
    byKey.set(`${p.base_deployment}::${p.location_name}`, p);
  }
  const forDraft = (deployment: string | null, location: string): RemotePreviewState | undefined => {
    if (!deployment) return undefined;
    return byKey.get(`${deployment}::${location}`);
  };

  return { previews, forDraft, refresh };
}
