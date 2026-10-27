const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'CANCELED']);

export interface WatchedRun {
  run_id: string;
  status: string;
  job_name?: string | null;
  pipeline_name?: string | null;
}

export interface FinishedRun {
  runId: string;
  label: string;
  status: 'SUCCESS' | 'FAILURE' | 'CANCELED';
}

/**
 * Compares a fresh list of runs with the statuses seen last time. `seen` is updated in place. Returns the runs that moved from
 * not-finished to finished since then. The first sighting of a run only records it, so opening the app never announces runs that
 * ended before anyone was watching.
 */
export function detectFinishedRuns(seen: Map<string, string>, runs: WatchedRun[]): FinishedRun[] {
  const finished: FinishedRun[] = [];
  for (const run of runs) {
    const status = run.status.toUpperCase();
    const prev = seen.get(run.run_id);
    seen.set(run.run_id, status);
    if (prev === undefined || prev === status || TERMINAL.has(prev) || !TERMINAL.has(status)) continue;
    finished.push({
      runId: run.run_id,
      label: run.job_name || run.pipeline_name || 'Run',
      status: status as FinishedRun['status'],
    });
  }
  return finished;
}

const TITLES: Record<FinishedRun['status'], string> = { SUCCESS: 'Run succeeded', FAILURE: 'Run failed', CANCELED: 'Run canceled' };

/** Native notification text. Names the project, since a notification from a background app has no other context. */
export function describeFinishedRun(run: FinishedRun, projectName?: string): { title: string; body: string } {
  return { title: TITLES[run.status], body: projectName ? `${run.label} · ${projectName}` : run.label };
}
