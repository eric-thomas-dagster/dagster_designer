import { FolderOpen } from 'lucide-react';
import { isTauri, pickDirectory, pickFile } from '@/services/tauri';

/**
 * Native OS file/folder picker button (Finder on macOS, Explorer on
 * Windows) -- renders nothing outside Tauri, since a browser can't hand
 * back a real absolute path. Meant to sit next to a plain text path
 * input, not replace it: several of these fields take a glob pattern or
 * a remote URI ("s3://..."), so picking only fills in the local file or
 * folder part -- the text input stays editable either way.
 */
export function PathPickerButton({
  mode,
  title,
  filters,
  onPicked,
}: {
  mode: 'file' | 'directory';
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  onPicked: (path: string) => void;
}) {
  if (!isTauri) return null;

  const handleClick = async () => {
    const picked = mode === 'directory' ? await pickDirectory(title) : await pickFile({ title, filters });
    if (picked) onPicked(picked);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={mode === 'directory' ? 'Browse for a folder…' : 'Browse for a file…'}
      className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 flex-shrink-0"
    >
      <FolderOpen className="w-3.5 h-3.5" />
    </button>
  );
}
