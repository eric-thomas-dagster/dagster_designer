const KEY = 'dagsterDesigner.keepRunningInTray';

/** The person's explicit choice, or null if they never made one (then it follows whether they have Dagster+ projects). */
export function getStoredBackgroundPref(): boolean | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? null : raw === 'true';
  } catch {
    return null;
  }
}

export function setStoredBackgroundPref(value: boolean): void {
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // Still applies for this session.
  }
}

/** Keeping the app alive in the tray is only useful for watching Dagster+, which runs somewhere else; open-source projects only
 *  run while the window is open. So it defaults to on exactly when there is a Dagster+ project to watch. */
export function backgroundModeEnabled(stored: boolean | null, hasDagsterPlusProject: boolean): boolean {
  return stored ?? hasDagsterPlusProject;
}
