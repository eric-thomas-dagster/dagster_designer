import { useEffect, useRef } from 'react';
import { isTauri, onMenuAction } from '@/services/tauri';
import { useActiveTab } from '@/services/activeTab';

export interface PageAction {
  /** Short and unique within this page only -- e.g. "refresh", "new". */
  id: string;
  label: string;
  /** Tauri accelerator syntax, e.g. "CmdOrCtrl+R". Optional. */
  accelerator?: string;
  handler: () => void;
}

/**
 * Publishes a page's own header actions (Monitors' Refresh / Generate with
 * AI / New Monitor, and similar elsewhere) into the native macOS menu bar
 * as a submenu named after the page, so they're reachable from the menu
 * bar exactly like the in-page buttons -- but only while `tabId` is the
 * tab actually showing. No-op outside Tauri.
 *
 * Tabs in this app stay mounted while inactive (see index.css's
 * [data-state=inactive] rule), so every page using this hook is mounted
 * simultaneously; `tabId`/useActiveTab is what keeps their menus from
 * fighting over the menu bar.
 */
export function usePageActions(title: string, tabId: string, actions: PageAction[]) {
  const activeTab = useActiveTab();
  const active = activeTab === tabId;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Rebuild the native menu when this page becomes active, or when the
  // set of actions it wants to show changes shape (not on every render --
  // handlers are read fresh from actionsRef regardless).
  const shape = actions.map((a) => `${a.id}:${a.label}:${a.accelerator ?? ''}`).join('|');
  useEffect(() => {
    if (!isTauri || !active) return;
    let cancelled = false;
    import('@tauri-apps/api/core').then(({ invoke }) => {
      if (cancelled) return;
      invoke('set_page_menu', {
        title,
        actions: actionsRef.current.map(({ id, label, accelerator }) => ({
          id,
          label,
          accelerator: accelerator ?? null,
        })),
      }).catch(() => {});
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, title, shape]);

  useEffect(() => {
    if (!isTauri) return;
    // Look up in actionsRef.current at call time (not a snapshot captured
    // when this effect ran) so a re-render that gives a page's action a
    // fresh handler closure -- without changing its id/label/accelerator
    // shape -- can't leave this listener holding a stale one.
    const unlistenPromise = onMenuAction((id) => {
      if (!active) return;
      const action = actionsRef.current.find((a) => `page:${title}:${a.id}` === id);
      if (action) action.handler();
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, title]);
}
