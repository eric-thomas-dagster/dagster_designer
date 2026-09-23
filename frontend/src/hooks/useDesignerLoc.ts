import { useEffect, useRef, useState } from 'react';
import { designerLocApi, type DesignerLocStatus } from '@/services/api';

/**
 * useDesignerLoc — lifecycle hook for the per-Dagster+-project
 * Designer-managed code location subprocess.
 *
 * When mounted with a Dagster+ project id, kicks off /ensure (which
 * scaffolds + installs + boots the subprocess on first run). Polls
 * status while the loc is transitioning to `ready`. Once ready,
 * polling backs off — we only re-check on tab focus.
 *
 * Peer-data-source model: this hook does NOT gate any UI mode. Callers
 * treat the loc as one data source among many; when status !== 'ready'
 * they simply render nothing (or an error toast).
 */
export function useDesignerLoc(projectId: string | null, isDagsterPlus: boolean) {
  const [status, setStatus] = useState<DesignerLocStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const ensureRunning = useRef(false);

  useEffect(() => {
    if (!projectId || !isDagsterPlus) {
      setStatus(null);
      return;
    }

    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const doEnsure = async () => {
      if (ensureRunning.current) return;
      ensureRunning.current = true;
      setStarting(true);
      try {
        const s = await designerLocApi.ensure(projectId);
        if (alive) setStatus(s);
      } catch (err) {
        if (alive) {
          setStatus({
            status: 'error',
            pid: null,
            port: null,
            error: err instanceof Error ? err.message : String(err),
            graphql_url: null,
            scaffolded: false,
            installed: false,
            log_tail: [],
          });
        }
      } finally {
        ensureRunning.current = false;
        if (alive) setStarting(false);
      }
    };

    const pollOnce = async () => {
      try {
        const s = await designerLocApi.status(projectId);
        if (!alive) return;
        setStatus(s);
        // Keep polling only while transitioning.
        if (s.status !== 'ready' && s.status !== 'error') {
          pollTimer = setTimeout(pollOnce, 2000);
        }
      } catch {
        // ignore
      }
    };

    // Kick off ensure once per (project, dagster+ flag) combo.
    doEnsure().then(() => {
      if (alive) pollOnce();
    });

    return () => {
      alive = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [projectId, isDagsterPlus]);

  const ready = status?.status === 'ready' && !!status.port;

  return { status, starting, ready };
}
