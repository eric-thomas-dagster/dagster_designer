import { useEffect, useRef } from 'react';
import { runsApi } from '@/services/api';
import { sendNativeNotification } from '@/services/tauri';
import { notify } from '@/components/Notifications';
import { getNotifyOnRunCompletion } from '@/lib/runNotificationsPref';
import { useProjectStore } from './useProject';

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILURE', 'CANCELED']);
const POLL_MS = 15000;

/**
 * Watches the current project's most recent runs and fires a notification
 * (in-app toast always, native OS notification under Tauri) the moment a
 * run transitions into a terminal state. Only fires on transitions observed
 * during this session -- the first poll after opening a project just
 * records baseline statuses, so we don't notify about runs that finished
 * before anyone was watching.
 */
export function useRunNotifications() {
  const { currentProject } = useProjectStore();
  const lastStatus = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    lastStatus.current = new Map();
  }, [currentProject?.id]);

  useEffect(() => {
    if (!currentProject) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const { runs } = await runsApi.query(currentProject.id, { limit: 10 });
        if (cancelled) return;
        for (const run of runs) {
          const status = run.status.toUpperCase();
          const prevStatus = lastStatus.current.get(run.run_id);
          lastStatus.current.set(run.run_id, status);

          const justFinished =
            prevStatus !== undefined && prevStatus !== status && !TERMINAL_STATUSES.has(prevStatus) && TERMINAL_STATUSES.has(status);
          if (!justFinished) continue;

          const label = run.job_name || run.pipeline_name || 'Run';
          // In-app toast always fires; the native OS notification is
          // gated behind the Preferences toggle (default on).
          const nativeEnabled = getNotifyOnRunCompletion();
          if (status === 'SUCCESS') {
            notify.success(`${label} succeeded`);
            if (nativeEnabled) sendNativeNotification('Run succeeded', label);
          } else if (status === 'FAILURE') {
            notify.error(`${label} failed`);
            if (nativeEnabled) sendNativeNotification('Run failed', label);
          } else if (status === 'CANCELED') {
            notify.warning(`${label} was canceled`);
            if (nativeEnabled) sendNativeNotification('Run canceled', label);
          }
        }
      } catch {
        // Background watcher -- a failed poll just tries again next tick.
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [currentProject?.id]);
}
