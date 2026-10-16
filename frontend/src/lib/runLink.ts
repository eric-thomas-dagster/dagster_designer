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

/** Same bridge for "just take me to the Runs page" (e.g. a backfill, which creates many runs). */
let listOpener: (() => void) | null = null;

export function registerRunsListOpener(fn: () => void): () => void {
  listOpener = fn;
  return () => {
    if (listOpener === fn) listOpener = null;
  };
}

export function openRunsList(): void {
  listOpener?.();
}
