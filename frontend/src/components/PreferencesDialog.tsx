import { useEffect, useState } from 'react';
import { X, SlidersHorizontal } from 'lucide-react';
import { useGroupByCodeLocation } from '@/hooks/useGroupByCodeLocation';
import { GroupByLocationToggle } from './GroupByLocationToggle';

// Same lightweight module-level pub-sub as SettingsDialog.tsx, kept as a
// separate dialog on purpose: Settings holds credentials/config you set
// once and rarely touch again (API keys, projects folder, GitHub) --
// Preferences holds "how do I want this to look/behave" choices you might
// flip often, so they don't belong mixed into the same screen.
type Listener = (open: boolean) => void;
let isOpen = false;
let listeners: Listener[] = [];

function emit() {
  listeners.forEach((l) => l(isOpen));
}

export function openPreferences() {
  isOpen = true;
  emit();
}

function closePreferencesInternal() {
  isOpen = false;
  emit();
}

/** Renders the Preferences modal. Mount once near the app root. */
export function PreferencesHost() {
  const [open, setOpen] = useState(isOpen);
  useEffect(() => {
    listeners.push(setOpen);
    return () => { listeners = listeners.filter((l) => l !== setOpen); };
  }, []);

  if (!open) return null;
  return <PreferencesDialog onClose={closePreferencesInternal} />;
}

function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const [groupByLocationPref, setGroupByLocationPref] = useGroupByCodeLocation();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Preferences</h2>
          </div>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Saved on this Mac and applied everywhere in the app. For API keys, the projects
          folder, and GitHub, see Settings instead.
        </p>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 py-2 border-t border-gray-100">
            <div className="min-w-0">
              <div className="text-sm text-gray-900">Group by code location</div>
              <div className="text-xs text-gray-500 mt-0.5">
                On Catalog, Automation, Insights, Monitors, Ingestions, and Resources: break
                unfiltered lists into one section per code location when a project has more
                than one.
              </div>
            </div>
            <GroupByLocationToggle value={groupByLocationPref} onChange={setGroupByLocationPref} showLabel={false} />
          </div>
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-accent"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
