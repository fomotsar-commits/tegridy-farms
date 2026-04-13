import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { installGlobalHandlers } from './lib/errorReporting';

installGlobalHandlers();

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
