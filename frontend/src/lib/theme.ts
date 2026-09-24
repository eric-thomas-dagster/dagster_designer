export type ThemePref = 'light' | 'dark' | 'auto';

const KEY = 'dagsterDesigner.theme';

export function getThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // Private browsing / blocked storage -- fall through to the default.
  }
  return 'auto';
}

let mediaListenerAttached = false;

/**
 * Toggles <html>'s `dark` class to match the given (or currently stored)
 * preference. Call with no argument on startup / after any external
 * change; call with an explicit value right after writing a new one so
 * the UI updates without waiting for a re-render to read storage back.
 *
 * 'auto' follows the OS appearance setting, same as before this
 * preference existed -- and stays live: the very first call wires up a
 * one-time OS-change listener that re-applies whenever the stored
 * preference is 'auto', so flipping System Settings while the app is
 * open still works exactly like it always did.
 */
export function applyTheme(pref: ThemePref = getThemePref()): void {
  const prefersDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const isDark = pref === 'auto' ? prefersDark : pref === 'dark';
  document.documentElement.classList.toggle('dark', isDark);

  if (!mediaListenerAttached && window.matchMedia) {
    mediaListenerAttached = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getThemePref() === 'auto') applyTheme('auto');
    });
  }
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Toggle still works for the rest of this session either way.
  }
  applyTheme(pref);
}
