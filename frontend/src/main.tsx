import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { isTauri } from './services/tauri';
// Self-hosted rather than index.css's old `@import url(fonts.googleapis.com/...)`
// -- a desktop app's own text shouldn't silently fall back to a generic
// system font just because a live network fetch to Google Fonts was slow,
// blocked, or failed (corporate network, timing, offline), which reads as
// "dated" for reasons that have nothing to do with the actual UI design.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';
import { applyTheme } from './lib/theme';

// Marks <html> so index.css can drop body's opaque background only in the
// desktop app -- body sits between the (transparent, vibrancy-backed)
// window and everything React renders, so it would otherwise block the
// nav rail's translucency the same way App.tsx's own root div did.
if (isTauri) {
  document.documentElement.classList.add('tauri');
}

// Applies the user's theme preference (light/dark/auto, default auto --
// System Settings > Appearance, same as any other native Mac app) before
// React renders so there's no flash of the wrong theme. See lib/theme.ts
// for the live-update behavior (OS changes while in auto, and instant
// updates when the preference itself is changed from Preferences).
applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
