import { useEffect } from 'react';
import { registerAppServiceWorker } from '../../lib/pwa/serviceWorker';

// Everything the installable app needs at runtime, mounted once.
//
// ONE thing lives here now: the app-shell worker's registration (which may
// honestly decline — see lib/pwa/serviceWorker.ts). The install offer used to
// mount here too, as a fixed banner; wave seven element E moved it into the
// footer as a row, because nothing opens over the page unasked.
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

  // WAVE SEVEN, element E: the install offer is NOT mounted here any more.
  // It was a fixed banner that opened itself over the page; it is a row in the
  // footer now (see Footer.tsx), so the visitor finds it rather than wears it.
  // The service-worker registration above is all this runtime still owns.
  return null;
}

export default PwaRuntime;
