import { create } from 'zustand';

// Tracks whether any editor has edits the user hasn't saved yet, so the
// native "quit anyway?" confirmation (see src-tauri/src/main.rs's
// quit-requested event) only fires when there's actually something to
// lose. Editors register a boolean under their own key rather than a
// single global flag so unrelated editors don't clobber each other's state.
interface UnsavedChangesStore {
  dirtyKeys: Set<string>;
  setDirty: (key: string, dirty: boolean) => void;
}

export const useUnsavedChangesStore = create<UnsavedChangesStore>((set, get) => ({
  dirtyKeys: new Set(),
  setDirty: (key, dirty) => {
    const has = get().dirtyKeys.has(key);
    if (dirty === has) return;
    const next = new Set(get().dirtyKeys);
    if (dirty) next.add(key);
    else next.delete(key);
    set({ dirtyKeys: next });
  },
}));

export const hasUnsavedChanges = (): boolean =>
  useUnsavedChangesStore.getState().dirtyKeys.size > 0;
