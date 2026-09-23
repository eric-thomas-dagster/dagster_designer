import { useCallback, useEffect, useState } from 'react';
import { previewApi, type PreviewState } from '@/services/api';

/**
 * usePreviews — poll the backend for all preview subprocesses running
 * for a given project. Callers use this to render "preview status per
 * draft" chips + gate boot buttons.
 *
 * Keyed by `(deployment_name, location_name)` in the returned map so
 * a caller can look up state for a specific draft without scanning.
 */
export function usePreviews(projectId: string | null) {
  const [previews, setPreviews] = useState<PreviewState[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!projectId) { setPreviews([]); return; }
    let alive = true;
    const poll = () => {
      previewApi.status(projectId)
        .then((r) => { if (alive) setPreviews(r.previews); })
        .catch(() => { /* ignore transient errors */ });
    };
    poll();
    // Poll every 3s while the tab is visible — cheap; the endpoint is
    // in-memory-map read on the backend.
    const iv = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [projectId, refreshKey]);

  const byKey = new Map<string, PreviewState>();
  for (const p of previews) {
    byKey.set(`${p.deployment_name}::${p.location_name}`, p);
  }
  const forDraft = (deployment: string | null, location: string): PreviewState | undefined => {
    if (!deployment) return undefined;
    return byKey.get(`${deployment}::${location}`);
  };

  return { previews, forDraft, refresh };
}
