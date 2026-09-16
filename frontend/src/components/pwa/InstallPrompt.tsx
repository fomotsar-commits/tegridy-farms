import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  isRunningInstalled,
  isSubAppRoute,
  readInstallDismissed,
  shouldOfferInstall,
} from '../../lib/pwa/install';
import { getConsent } from '../../lib/consent';

// The install offer for the main app.
//
// It renders only when the browser has handed us a real, unfired
// `beforeinstallprompt`. Every other path renders nothing: already installed,
// previously dismissed, on the sub-app route that has its own banner, or on a
// platform that never offers the event. lib/pwa/install.ts holds that decision
// and its reasoning, including why iOS deliberately gets no banner rather than a
// button that cannot install.

/** Chromium's non-standard install event. Not in lib.dom, so it is named here. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  const { pathname } = useLocation();
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  // Still honoured, so anyone who dismissed the old banner is not re-offered.
  const [dismissed] = useState(readInstallDismissed);
  const [installed, setInstalled] = useState(isRunningInstalled);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    // Fires when the install completes by ANY route, including the browser's own
    // menu. Without it the banner would keep offering an install that already
    // happened, on a window that has not been relaunched yet.
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      // prompt() is single-use and throws InvalidStateError on a second call.
      // Swallowed rather than left as an unhandled rejection on a double click.
    } finally {
      // Cleared whatever the outcome: the event object is spent. Chromium may
      // fire a fresh one later, which re-arms the banner honestly.
      setDeferred(null);
    }
  }, [deferred]);

  // Read during render (not cached in state) so the offer returns by itself on
  // the next render once the visitor answers the consent banner.
  let consentPending = false;
  try { consentPending = getConsent() === 'pending'; } catch { /* storage denied — treat as answered */ }

  const offer = shouldOfferInstall({
    promptAvailable: deferred !== null,
    dismissed,
    installed,
    onSubAppRoute: isSubAppRoute(pathname),
    firstRunPending: consentPending,
  });

  if (!offer) return null;

  // WAVE SEVEN, element E: A FOOTER ROW, NEVER A BANNER.
  //
  // This was a `position: fixed`, `z-[9500]`, `role="dialog"` panel that put
  // itself over the page the moment Chromium fired `beforeinstallprompt` —
  // nobody asked for it, and at `bottom-20` it sat on top of the very buttons a
  // visitor was reaching for. That is the class element E removes.
  //
  // Nothing about the OFFER changes: the decision in lib/pwa/install.ts still
  // rules, so this appears only when the browser handed us a real, unfired
  // event and the visitor is not already installed, not on the sub-app route,
  // and has answered consent. It simply waits in the footer now, and the tap
  // that spends the deferred prompt is the visitor's.
  //
  // The dismiss control went with the banner: a quiet row in the footer does
  // not nag, so there is nothing to dismiss. Anyone who dismissed the old
  // banner stays dismissed — `readInstallDismissed` is still honoured above.
  //
  // The honesty line goes too, because it belonged to a panel with room for it.
  // The row promises exactly what it does: add it to your home screen. It never
  // said, and still must never say, anything about working offline.
  return (
    <button
      type="button"
      onClick={install}
      className="text-[12px] underline underline-offset-4 decoration-white/30 transition-colors hover:decoration-white"
      style={{ color: 'rgba(255,255,255,0.75)' }}
    >
      Add to home screen
    </button>
  );
}

export default InstallPrompt;
