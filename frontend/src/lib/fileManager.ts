/** What this platform calls its file manager, for button labels. `platform` is the value from the OS plugin ('macos', 'windows', 'linux'...). */
export function fileManagerName(platform: string | null | undefined): string {
  if (platform === 'macos') return 'Finder';
  if (platform === 'windows') return 'File Explorer';
  return 'file manager';
}
