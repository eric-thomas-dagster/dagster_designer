import { useEffect, useState } from 'react';

// Lightweight module-level pub-sub (same pattern as Notifications.tsx and
// SettingsDialog.tsx) tracking which main-nav tab is currently visible.
// App.tsx's tab state already lives locally there; this is a second,
// read-only broadcast of the same value so any page component can ask "is
// it my turn?" without prop-drilling `activeMainTab` through everything
// that wants to register menu-bar actions. Tabs stay mounted in the
// background here (see the [data-state=inactive] display:none rule in
// index.css), so a page can't infer this just from being mounted.
let currentTab = 'assets';
let listeners: ((tab: string) => void)[] = [];

export function setActiveTabGlobal(tab: string) {
  currentTab = tab;
  listeners.forEach((l) => l(tab));
}

export function useActiveTab(): string {
  const [tab, setTab] = useState(currentTab);
  useEffect(() => {
    listeners.push(setTab);
    return () => { listeners = listeners.filter((l) => l !== setTab); };
  }, []);
  return tab;
}
