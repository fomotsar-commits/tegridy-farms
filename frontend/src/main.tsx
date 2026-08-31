// Buffer polyfill in the ENTRY chunk, before everything else. Every Solana
// surface imports lib/solanaPolyfill first in its own module, which is enough
// in dev — but the production chunk graph may evaluate vendor-solana via an
// importer that never pulled the polyfill (nakamigos did exactly that:
// "Buffer is not defined" at vendor-solana top-level, prod-only, 2026-08-27).
// The entry chunk is the one thing guaranteed to run before every lazy chunk.
//
// ⚠️ THE OTHER HALF OF THIS FIX LIVES IN vite.config.ts and is LOAD-BEARING:
// `buffer` (+ base64-js/ieee754) is PINNED into vendor-shared-wallet-plumbing
// there. An earlier version of this comment claimed "buffer matches no
// manualChunks rule" — backwards: UNassigned buffer is exactly what let Rollup
// weld it (and therefore vendor-solana) into first paint on 2026-08-27. Do not
// delete the pin as "redundant", and do not move this import off line one.
// Both halves are enforced by scripts/check-dist-graph.mjs on every build.
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
