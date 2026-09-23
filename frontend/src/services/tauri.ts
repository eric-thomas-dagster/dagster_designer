// Helpers for the optional Tauri desktop shell. Everything here is a no-op
// when the app is running as a plain web page (e.g. `vite dev`, or a normal
// browser deploy) so the rest of the codebase doesn't need to branch on it.

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Shows a native OS notification. Falls back to nothing outside Tauri --
 * callers are expected to also show an in-app toast (via `notify`) for the
 * web case, since that's the only notification a browser tab can show
 * without its own separate permission dance.
 */
export async function sendNativeNotification(title: string, body: string): Promise<void> {
  if (!isTauri) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    if (granted) {
      sendNotification({ title, body });
    }
  } catch {
    // Notification plugin not available for some reason -- the in-app
    // toast the caller also shows is enough of a fallback.
  }
}

/**
 * Opens the native OS folder picker (Finder on macOS, Explorer on Windows,
 * whatever GTK/portal dialog on Linux) and returns the chosen absolute
 * path, or null if the user canceled or this isn't running under Tauri.
 * Browsers can't offer this for arbitrary filesystem paths (the File
 * System Access API is Chromium-only and still won't hand back a plain
 * absolute path), so outside Tauri callers should keep the manual text
 * input as the only option.
 */
export async function pickDirectory(title?: string): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({ directory: true, multiple: false, title });
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

/**
 * Opens a URL in the system's default browser. Outside Tauri, this is
 * just `window.open(url, '_blank')` -- but inside Tauri's WKWebView,
 * `window.open` doesn't reliably open the OS browser (it's swallowed or
 * opens a chromeless in-app window depending on platform), so it needs
 * the opener plugin instead.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, '_blank');
    return;
  }
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank');
  }
}

/**
 * Opens a local path in VS Code via its `vscode://file/` deep link --
 * works identically on macOS and Windows without needing to guess a
 * platform-specific app identifier (VS Code registers this URI scheme on
 * install, the same way Slack's `slack://` or GitHub Desktop's
 * `github-desktop://` do). `line`/`column` are 1-indexed, matching VS
 * Code's own "Go to Line" convention; both optional -- omit for "just
 * open this file/folder".
 */
export async function openInVSCode(absolutePath: string, line?: number, column?: number): Promise<void> {
  let uri = `vscode://file/${absolutePath}`;
  if (line != null) {
    uri += `:${line}`;
    if (column != null) uri += `:${column}`;
  }
  await openExternalUrl(uri);
}

/**
 * The folder new projects are created in (see src-tauri/src/main.rs's
 * resolve_projects_dir) -- defaults to ~/Documents/Dagster Designer, but
 * the user can point it elsewhere from Settings. Outside Tauri there's no
 * such concept (the backend isn't spawned by this process), so this
 * returns null.
 */
export async function getProjectsDir(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('get_projects_dir');
  } catch {
    return null;
  }
}

/**
 * Changes the projects folder and restarts the backend pointed at it --
 * takes a few seconds (the same as a normal app launch) while the backend
 * comes back up. Existing projects aren't moved; they just stop showing up
 * until/unless that folder is pointed back to. Throws on failure (e.g. the
 * chosen folder isn't writable), so callers should catch and surface it.
 */
export async function setProjectsDir(path: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('set_projects_dir', { path });
}

/**
 * Subscribes to "menu-action" events emitted by the native menu bar (see
 * src-tauri/src/main.rs). No-op outside Tauri. Returns an unsubscribe
 * function, mirroring `@tauri-apps/api/event`'s own `listen()`.
 */
export async function onMenuAction(handler: (id: string) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<string>('menu-action', (event) => handler(event.payload));
    return unlisten;
  } catch {
    return () => {};
  }
}

/**
 * Subscribes to "quit-requested" events, fired instead of quitting outright
 * whenever the user closes the window / hits Cmd+Q / picks Dock > Quit (see
 * src-tauri/src/main.rs) so the frontend gets a chance to confirm first when
 * there are unsaved edits. No-op outside Tauri. Returns an unsubscribe
 * function, mirroring `onMenuAction`.
 */
export async function onQuitRequested(handler: () => void): Promise<() => void> {
  if (!isTauri) return () => {};
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen('quit-requested', () => handler());
    return unlisten;
  } catch {
    return () => {};
  }
}

/**
 * Actually tears down the backend and exits -- the other half of
 * quit-requested. Only call this once the frontend has decided it's safe to
 * quit (nothing unsaved, or the user confirmed anyway).
 */
export async function confirmQuit(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('confirm_quit');
}
