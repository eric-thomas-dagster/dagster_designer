import { useEffect, useState } from 'react';
import { minimizeWindow, toggleMaximizeWindow, closeWindow, isWindowMaximized } from '@/services/tauri';

/**
 * Windows' own minimize/maximize/close caption buttons, drawn by us
 * instead of relying on the native title bar -- Windows has no macOS-style
 * "overlay" title bar mode (decorations are either a full native strip, or
 * none at all), so getting one continuous header the way the Mac build
 * already has means going fully undecorated (see tauri.windows.conf.json)
 * and drawing these ourselves, matching how VS Code/Windows Terminal do
 * this. Styled after Windows 11's own Fluent caption buttons: plain glyphs,
 * a light hover fill on minimize/maximize, and red on close specifically
 * (the one universally-recognized Windows convention here).
 */
export function WindowsCaptionButtons() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    isWindowMaximized().then(setIsMaximized);
  }, []);

  const handleMaximize = async () => {
    await toggleMaximizeWindow();
    setIsMaximized(await isWindowMaximized());
  };

  const buttonBase = 'inline-flex items-center justify-center w-11 h-8 text-gray-700 hover:bg-black/[0.06] active:bg-black/[0.09]';

  return (
    <div className="flex items-center h-full titlebar-no-drag" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button onClick={minimizeWindow} className={buttonBase} title="Minimize" aria-label="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor" /></svg>
      </button>
      <button onClick={handleMaximize} className={buttonBase} title={isMaximized ? 'Restore' : 'Maximize'} aria-label={isMaximized ? 'Restore' : 'Maximize'}>
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M0.5 2.5 H7.5 V9.5 H0.5 Z" fill="white" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
        )}
      </button>
      <button
        onClick={closeWindow}
        className="inline-flex items-center justify-center w-11 h-8 text-gray-700 hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/90"
        title="Close"
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
