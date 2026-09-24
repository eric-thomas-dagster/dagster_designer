import { useState } from 'react';

const KEY = 'dagsterDesigner.groupByCodeLocation';

/**
 * Whether Catalog/Automation/Insights/Monitors/Ingestions/Resources should
 * break into one section per code location when no location filter is
 * picked. Only meaningful for Dagster+ orgs with more than one code
 * location -- most users only ever have one, so this defaults to true
 * (grouped) and is a single shared, remembered toggle rather than a
 * per-page setting: it's one "how do I want this to look" preference,
 * not something that should vary page to page.
 */
export function useGroupByCodeLocation(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw === null ? true : raw === 'true';
    } catch {
      return true;
    }
  });

  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      // Private browsing / blocked storage -- toggle still works for
      // the rest of this session, just won't be remembered next launch.
    }
  };

  return [value, set];
}
