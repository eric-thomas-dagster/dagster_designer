import { useEffect, useRef } from 'react';
import { runsApi } from '@/services/api';
import { sendNativeNotification } from '@/services/tauri';
import { notify } from '@/components/Notifications';
import { getNotifyOnRunCompletion } from '@/lib/runNotificationsPref';
import { describeFinishedRun, detectFinishedRuns } from '@/lib/runTransitions';
import { useProjectStore } from './useProject';

const POLL_MS = 15000;
/** Dagster+ projects other than the one on screen are checked every this-many polls (about a minute). */
const BACKGROUND_EVERY = 4;

/**
 * Tells you when a run finishes: an in-app toast always, and a native OS notification (if the Preference is on).
 *
 * Watches the open project, plus every Dagster+ project even when it isn't the one on screen. Dagster+ runs happen on Dagster's
 * servers whether or not this window is showing, so with the tray enabled (see useBackgroundMode) the app keeps telling you about
 * them. Open-source projects only run while you're working in them, so only the open one is watched.
 *
 * Only runs seen in progress during this session are announced (see detectFinishedRuns).
 */
export function useRunNotifications() {
  const currentId = useProjectStore((s) => s.currentProject?.id);
  const projects = useProjectStore((s) => s.projects);
  const seen = useRef<Map<string, Map<string, string>>>(new Map());
  const latest = useRef({ currentId, projects });
  latest.current = { currentId, projects };

  useEffect(() => {
    let cancelled = false;
    let tick = 0;

    const watch = async (projectId: string, projectName: string | undefined, showName: boolean) => {
      try {
        const { runs } = await runsApi.query(projectId, { limit: 10 });
        if (cancelled) return;
        let byRun = seen.current.get(projectId);
        if (!byRun) seen.current.set(projectId, (byRun = new Map()));
        for (const finished of detectFinishedRuns(byRun, runs)) {
          const { title, body } = describeFinishedRun(finished, showName ? projectName : undefined);
          const text = showName && projectName ? `${finished.label} (${projectName})` : finished.label;
          if (finished.status === 'SUCCESS') notify.success(`${text} succeeded`);
          else if (finished.status === 'FAILURE') notify.error(`${text} failed`);
          else notify.warning(`${text} was canceled`);
          if (getNotifyOnRunCompletion()) sendNativeNotification(title, body);
        }
      } catch {
        // Background watcher: a failed poll just tries again next time.
      }
    };

    const poll = () => {
      const { currentId: open, projects: all } = latest.current;
      const everyone = tick % BACKGROUND_EVERY === 0;
      tick += 1;
      if (open) watch(open, all.find((p) => p.id === open)?.name, false);
      if (!everyone) return;
      for (const p of all) {
        if (p.id !== open && (p as any).is_dagster_plus) watch(p.id, p.name, true);
      }
    };

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // A different project's history starts fresh: only its in-progress runs are announced.
  useEffect(() => {
    if (currentId) seen.current.delete(currentId);
  }, [currentId]);
}
