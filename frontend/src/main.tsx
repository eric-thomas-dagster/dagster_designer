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

// Marks <html> so index.css can drop body's opaque background only in the
// desktop app -- body sits between the (transparent, vibrancy-backed)
// window and everything React renders, so it would otherwise block the
// nav rail's translucency the same way App.tsx's own root div did.
if (isTauri) {
  document.documentElement.classList.add('tauri');
}

// Follow the OS appearance setting (System Settings > Appearance) rather
// than an in-app toggle, same as any other native Mac app. Applied before
// React renders so there's no flash of the wrong theme, and kept in sync
// live if the user changes their system appearance while the app is open.
(() => {
  if (!window.matchMedia) return;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.classList.toggle('dark', media.matches);
  apply();
  media.addEventListener('change', apply);
})();

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
