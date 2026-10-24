/** Helpers for importing a project by dropping its folder onto the window. */

/** The folder to import from a drop. One at a time: the first path is used and the rest are counted so the user can be told. */
export function pickProjectPath(paths: string[]): { path: string | null; ignored: number } {
  const usable = paths.map((p) => p.trim()).filter(Boolean);
  return { path: usable[0] ?? null, ignored: Math.max(0, usable.length - 1) };
}

/** The most useful message for a failed import: the server's explanation when it gave one, else a generic line. */
export function importErrorMessage(error: unknown): string {
  const detail = (error as any)?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') return detail.message;
  return 'Could not import that folder.';
}
