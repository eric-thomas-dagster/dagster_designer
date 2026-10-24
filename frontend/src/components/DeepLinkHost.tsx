import { useEffect, useRef } from 'react';
import { useProjectStore } from '@/hooks/useProject';
import { onDeepLink } from '@/services/tauri';
import { findProjectForLink, parseDeepLink } from '@/lib/deepLink';
import { notify } from './Notifications';

/**
 * Opens `dagster-designer://` links: switches to the named project and, for an asset link, opens that asset. Desktop app only.
 * Projects are matched by name because ids differ between machines.
 */
export function DeepLinkHost({ onOpenAsset }: { onOpenAsset: (nodeId: string) => void }) {
  const openAsset = useRef(onOpenAsset);
  openAsset.current = onOpenAsset;

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;

    const handle = async (raw: string) => {
      const link = parseDeepLink(raw);
      if (!link) {
        notify.warning('That link is not a valid Dagster Designer link.');
        return;
      }
      try {
        const store = useProjectStore.getState();
        if (store.projects.length === 0) await store.loadProjects();
        const { project, ambiguous } = findProjectForLink(useProjectStore.getState().projects, link.project);
        if (!project) {
          notify.warning(
            ambiguous
              ? `More than one project is named "${link.project}", so the link can't tell which to open.`
              : `This link points to a project named "${link.project}", which isn't in this app. Import it first.`,
          );
          return;
        }
        if (useProjectStore.getState().currentProject?.id !== project.id) {
          await useProjectStore.getState().loadProject(project.id);
        }
        if (link.kind !== 'asset') return;
        const nodes = useProjectStore.getState().currentProject?.graph?.nodes ?? [];
        const node = nodes.find((n) => (n.data as any)?.asset_key === link.assetKey || n.id === link.assetKey);
        if (node) openAsset.current(node.id);
        else notify.warning(`Opened "${project.name}", but it has no asset "${link.assetKey}".`);
      } catch (e) {
        notify.error(`Couldn't open the link: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    onDeepLink(handle)
      .then((unsubscribe) => {
        if (cancelled) unsubscribe();
        else off = unsubscribe;
      })
      .catch(() => {}); // a shell built without the plugin just has no links
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return null;
}
