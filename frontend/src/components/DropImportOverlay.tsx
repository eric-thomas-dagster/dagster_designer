import { useEffect, useState } from 'react';
import { FolderInput, Loader2 } from 'lucide-react';
import { useProjectStore } from '@/hooks/useProject';
import { isTauri, onFileDrop } from '@/services/tauri';
import { importErrorMessage, pickProjectPath } from '@/lib/dropImport';
import { notify } from './Notifications';

/**
 * Drag a Dagster project folder from Finder / Explorer onto the window to import it. Desktop app only: a browser page can't see
 * where a dropped folder lives, but the shell can. Renders nothing until something is being dragged over the window.
 */
export function DropImportOverlay() {
  const importProject = useProjectStore((s) => s.importProject);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    onFileDrop({
      onEnter: () => setDragging(true),
      onLeave: () => setDragging(false),
      onDrop: async (paths) => {
        const { path, ignored } = pickProjectPath(paths);
        if (!path) return;
        setImporting(true);
        try {
          await importProject(path);
          notify.success('Project imported.');
          if (ignored > 0) notify.info(`Imported the first folder. One project at a time, so ${ignored} other item${ignored === 1 ? ' was' : 's were'} skipped.`);
        } catch (e) {
          notify.error(importErrorMessage(e));
        } finally {
          setImporting(false);
        }
      },
    }).then((unsubscribe) => {
      if (cancelled) unsubscribe();
      else off = unsubscribe;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [importProject]);

  if (!dragging && !importing) return null;
  return (
    <div className="fixed inset-0 z-[70] pointer-events-none flex items-center justify-center bg-blue-50/70">
      <div className="rounded-xl border-2 border-dashed border-blue-400 bg-white px-10 py-8 shadow-lg text-center">
        {importing ? <Loader2 className="w-8 h-8 mx-auto text-blue-500 animate-spin" /> : <FolderInput className="w-8 h-8 mx-auto text-blue-500" />}
        <div className="mt-3 text-sm font-medium text-gray-900">{importing ? 'Importing…' : 'Drop a Dagster project folder to import it'}</div>
      </div>
    </div>
  );
}
