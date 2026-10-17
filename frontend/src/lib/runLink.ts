/**
 * A tiny bridge so non-React code (the API layer) can open a run in the Runs tab.
 * App registers its `handleOpenRun` once; anything can then call `openRun(id)`.
 */
let opener: ((runId: string) => void) | null = null;

export function registerRunOpener(fn: (runId: string) => void): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

export function openRun(runId: string): void {
  opener?.(runId);
}

/** Same bridge for "just take me to the Runs page" (e.g. a backfill, which creates many runs). Optionally
 *  pre-filtered by a run tag -- a Dagster backfill tags every run it launches `dagster/backfill=<id>`. */
export interface RunsListFilter { tagKey?: string; tagValue?: string }
let listOpener: ((filter?: RunsListFilter) => void) | null = null;

export function registerRunsListOpener(fn: (filter?: RunsListFilter) => void): () => void {
  listOpener = fn;
  return () => {
    if (listOpener === fn) listOpener = null;
  };
}

export function openRunsList(filter?: RunsListFilter): void {
  listOpener?.(filter);
}
