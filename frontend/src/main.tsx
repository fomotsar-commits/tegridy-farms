// Buffer polyfill in the ENTRY chunk, before everything else. Every Solana
// surface imports lib/solanaPolyfill first in its own module, which is enough
// in dev — but the production chunk graph may evaluate vendor-solana via an
// importer that never pulled the polyfill (nakamigos did exactly that:
// "Buffer is not defined" at vendor-solana top-level, prod-only, 2026-08-27).
// The entry chunk is the one thing guaranteed to run before every lazy chunk.
// buffer matches no manualChunks rule, so this does NOT weld vendor-solana
// into the initial bundle — it adds only the small buffer package itself.
import './lib/solanaPolyfill';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { installGlobalHandlers } from './lib/errorReporting';

installGlobalHandlers();

// Import Nakamigos CSS eagerly to prevent Vite CSS preload errors.
// When CSS is imported inside a lazy() chunk, Vite's __vitePreload tries to
// <link rel="modulepreload"> the CSS which fails on some CDNs (Vercel edge).
// Moving it here ensures it's in the main bundle and always available.
import './nakamigos/App.css';

const el = document.getElementById('root');
if (!el) throw new Error('Missing #root element');

createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
