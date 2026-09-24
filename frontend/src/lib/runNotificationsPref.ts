const KEY = 'dagsterDesigner.notifyOnRunCompletion';

/** Whether a run finishing (success/failure/canceled) should also pop a
 *  native OS notification, on top of the in-app toast (which always
 *  fires regardless -- this only gates the native one). Defaults to true,
 *  matching the behavior before this was a preference. Plain functions
 *  rather than a hook so useRunNotifications' non-component poll loop can
 *  read the current value at each check without a stale closure. */
export function getNotifyOnRunCompletion(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? true : raw === 'true';
  } catch {
    return true;
  }
}

export function setNotifyOnRunCompletion(value: boolean): void {
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // Toggle still works for the rest of this session either way.
  }
}
