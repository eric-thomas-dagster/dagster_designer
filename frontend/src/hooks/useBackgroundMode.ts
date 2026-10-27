import { useEffect, useState } from 'react';
import { useProjectStore } from './useProject';
import { backgroundModeEnabled, getStoredBackgroundPref, setStoredBackgroundPref } from '@/lib/backgroundPref';
import { setBackgroundMode } from '@/services/tauri';

/** The effective setting: the person's choice if they made one, otherwise on exactly when they have a Dagster+ project. */
export function useBackgroundModePref(): [boolean, (v: boolean) => void] {
  const hasDagsterPlus = useProjectStore((s) => s.projects.some((p) => (p as any).is_dagster_plus));
  const [stored, setStored] = useState<boolean | null>(getStoredBackgroundPref);
  const set = (v: boolean) => {
    setStored(v);
    setStoredBackgroundPref(v);
    window.dispatchEvent(new Event('background-pref-changed'));
  };
  useEffect(() => {
    const sync = () => setStored(getStoredBackgroundPref());
    window.addEventListener('background-pref-changed', sync);
    return () => window.removeEventListener('background-pref-changed', sync);
  }, []);
  return [backgroundModeEnabled(stored, hasDagsterPlus), set];
}

/** Keeps the desktop shell's tray / close-to-tray in step with the setting. Mount once, in App. */
export function useBackgroundMode() {
  const [enabled] = useBackgroundModePref();
  useEffect(() => {
    setBackgroundMode(enabled);
  }, [enabled]);
}
