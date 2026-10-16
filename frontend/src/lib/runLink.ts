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
