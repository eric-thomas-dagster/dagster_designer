/**
 * Dagster's definitions build is all-or-nothing: one bad component write
 * (a duplicate asset key, a dangling upstream reference, an invalid field)
 * fails the ENTIRE project load -- not just the thing that was just
 * written. Every write path that can introduce that kind of breakage
 * should validate the result and undo itself if the project no longer
 * loads, rather than leaving a silently broken project for the user to
 * discover later (via "Project validation failed" on next open, or a
 * confusing unrelated error elsewhere in the app).
 *
 * Extracted from applyGeniePicks.ts's original inline version (the first
 * place this pattern was needed, after a real incident: an Agent Builder
 * plan's two picks got applied in a way that produced a duplicate asset
 * key, and the project silently stopped loading until the user noticed).
 * Reused by every other write path that adds/changes component instances
 * (ComponentConfigModal, PropertyPanel/AssetDetailPage's attach-to-existing,
 * TemplateBuilder's new schedule/job/sensor) so a fix to this mechanism
 * applies everywhere at once instead of needing to be re-implemented per
 * call site.
 */
export interface ValidateOrRollbackResult {
  ok: boolean;
  /** Set only when ok is false -- the validation error that caused the
   *  rollback, suitable for showing directly to the user. */
  error?: string;
}

/**
 * Validates `projectId`'s current on-disk component definitions. If they
 * fail to load, calls `rollback()` (the caller's own "undo whatever I just
 * wrote" callback -- deleting a just-added component, or restoring a
 * just-edited one's prior attributes) and returns `{ ok: false, error }`.
 * If validation itself can't be reached (network hiccup, backend busy),
 * fails OPEN -- returns `{ ok: true }` rather than rolling back a write
 * that, for all we know, is perfectly fine; we only ever undo something on
 * a CONFIRMED failure, never on an inconclusive one.
 */
export async function validateProjectOrRollback(
  projectId: string,
  rollback: () => Promise<void>,
): Promise<ValidateOrRollbackResult> {
  const { projectsApi } = await import('@/services/api');
  try {
    const validation = await projectsApi.validate(projectId);
    if (validation.valid === false) {
      try {
        await rollback();
      } catch (e) {
        console.error('[validateProjectOrRollback] Rollback itself failed -- project may still be broken:', e);
      }
      return {
        ok: false,
        error:
          validation.error ||
          validation.details?.validation_error ||
          'The resulting project failed to validate (Dagster rejected the combined definitions). The change was undone.',
      };
    }
    // `valid === null` (pending/dependencies-still-installing) is
    // inconclusive, not a pass -- still ok: true, since there's nothing
    // confirmed-broken to roll back.
    return { ok: true };
  } catch (e) {
    console.warn('[validateProjectOrRollback] Validation call failed; proceeding without it:', e);
    return { ok: true };
  }
}
