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
