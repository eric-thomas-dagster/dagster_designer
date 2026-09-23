import { useCallback, useEffect, useState } from 'react';
import { draftsApi, SANDBOX_LOCATION_NAME, type Draft } from '@/services/api';

/**
 * useDrafts — light polling hook for a project's drafts list.
 *
 * Callers bump the returned `refresh()` after a create/delete so the
 * count updates immediately without waiting for the poll interval.
 */
export function useDrafts(projectId: string | null) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!projectId) {
      setDrafts([]);
      return;
    }
    let alive = true;
    draftsApi.list(projectId)
      .then((r) => {
        if (!alive) return;
        // Only customer-loc drafts count here — sandbox authorings are
        // real files, not pending-PR items.
        setDrafts(r.drafts.filter((d) => d.location_name !== SANDBOX_LOCATION_NAME));
      })
      .catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [projectId, refreshKey]);

  return { drafts, refresh, refreshKey };
}
