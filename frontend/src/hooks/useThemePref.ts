import { useState } from 'react';
import { getThemePref, setThemePref, type ThemePref } from '@/lib/theme';

/** The user's light/dark/auto preference, backed by lib/theme.ts's
 *  localStorage-persisted setting. Setting it applies immediately --
 *  no restart, no re-render race with <html>'s `dark` class. */
export function useThemePref(): [ThemePref, (v: ThemePref) => void] {
  const [value, setValue] = useState<ThemePref>(getThemePref);
  const set = (v: ThemePref) => {
    setValue(v);
    setThemePref(v);
  };
  return [value, set];
}
