import { useEffect } from 'react';
import { registerAppServiceWorker } from '../../lib/pwa/serviceWorker';
import { InstallPrompt } from './InstallPrompt';

// Everything the installable app needs at runtime, mounted once.
//
// Two things live here and nothing else: the app-shell worker's registration
// (which may honestly decline — see lib/pwa/serviceWorker.ts) and the install
// banner. Both render or run nothing at all in the common case, so this is safe
// to mount above the router.
//
// The registration result is deliberately NOT surfaced in the UI. Whether an
// offline notice is installed is not a fact about the protocol, and a badge
// claiming "offline ready" would be the one PWA claim that is easy to make
// falsely — a worker can be registered and still have nothing useful cached.
// The outcome is logged in development, where the person who can act on it is.

export function PwaRuntime() {
  useEffect(() => {
    let cancelled = false;
    void registerAppServiceWorker().then((outcome) => {
      if (cancelled) return;
      if (import.meta.env.DEV) {
        console.info('[pwa] service worker:', outcome.state, 'reason' in outcome ? outcome.reason : outcome.scope);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <InstallPrompt />;
}

export default PwaRuntime;
