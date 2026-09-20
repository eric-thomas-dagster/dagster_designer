import { useEffect, useState } from 'react';

function computeIsDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

/**
 * Tracks whether dark mode is currently active. main.tsx toggles the
 * `dark` class on <html> from the OS appearance setting (and keeps it live
 * if the user changes System Settings while the app is open) -- this just
 * observes that class rather than re-deriving it, so it stays in sync with
 * the same source of truth everywhere. Needed anywhere a library has its
 * own separate theming system that doesn't read Tailwind's `dark:`
 * classes, like Monaco Editor's `theme` prop.
 */
export function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(computeIsDark);

  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(computeIsDark()));
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}
