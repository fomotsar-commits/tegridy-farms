import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  isRunningInstalled,
  isSubAppRoute,
  persistInstallDismissed,
  readInstallDismissed,
  shouldOfferInstall,
} from '../../lib/pwa/install';

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
  const [dismissed, setDismissed] = useState(readInstallDismissed);
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

  const dismiss = useCallback(() => {
    setDismissed(true);
    persistInstallDismissed();
  }, []);

  const offer = shouldOfferInstall({
    promptAvailable: deferred !== null,
    dismissed,
    installed,
    onSubAppRoute: isSubAppRoute(pathname),
  });

  if (!offer) return null;

  return (
    <div
      className="fixed inset-x-3 bottom-20 z-[9500] mx-auto flex max-w-md items-center gap-3 rounded-xl border border-white/20 bg-[#0b1226]/95 px-4 py-3 shadow-2xl backdrop-blur sm:bottom-6"
      role="dialog"
      aria-label="Install Tegridy Farms"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">Install Tegridy Farms</p>
        {/* No offline-trading claim here, and none anywhere else in this banner.
            The installed app is the same app: it reads the chain live and shows
            nothing when it cannot. Promising an offline experience would be
            promising cached prices. */}
        <p className="mt-0.5 text-xs leading-snug text-white/65">
          Adds it to your home screen. It still needs a connection to read anything on-chain.
        </p>
      </div>
      <button
        type="button"
        onClick={install}
        className="shrink-0 rounded-lg border border-white/25 bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
      >
        Install
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="shrink-0 rounded-md px-1.5 py-1 text-lg leading-none text-white/55 hover:text-white"
      >
        {'×'}
      </button>
    </div>
  );
}

export default InstallPrompt;
