// THE ONE PLACE THIS APP SHOWS AN OS NOTIFICATION.
//
// It exists because `new Notification()` is an ILLEGAL CONSTRUCTOR in page
// context on Android Chrome — it throws TypeError, always, no matter the
// permission. Four hooks (DCA, limit orders, price alerts, and now the alert
// engine) each had their own `try { new Notification(...) } catch { }`, which on
// Android meant four features silently showing nothing while their code paths
// reported success. The nakamigos surface already learned this and routes through
// a service-worker registration (nakamigos/lib/notifications.js); this brings the
// main venue to the same behaviour in one place, pinned by a source-grep test.
//
// IT RETURNS A BOOLEAN AND THE CALLER IS EXPECTED TO BELIEVE IT. `false` means
// nothing was shown, and the alerts inbox uses that to keep a row saying "no
// notification was shown" rather than stamping a delivery that did not happen.
//
// IT NEVER REGISTERS A SERVICE WORKER. It uses one only if the app already
// registered it (lib/pwa/serviceWorker.ts owns that, and registering a second at
// a different scope collides with the first).

/** True when this browser has the API at all — false on iOS Safari outside an installed app. */
export function hasNotificationApi(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** The browser's current permission, or null when it cannot be read. */
export function notificationPermission(): NotificationPermission | null {
  if (!hasNotificationApi()) return null;
  try {
    return Notification.permission;
  } catch {
    return null;
  }
}

/**
 * Ask for permission. FROM A CLICK HANDLER ONLY.
 *
 * Browsers refuse — and in Chrome permanently penalise the origin for — a
 * permission prompt that was not user-initiated, so a request fired at the moment
 * an alert fires does not just fail, it can poison the site's ability to ask
 * later. The alerts surface therefore only calls this from its own button.
 */
export async function requestWebNotificationPermission(): Promise<NotificationPermission | null> {
  if (!hasNotificationApi()) return null;
  try {
    return await Notification.requestPermission();
  } catch {
    return null;
  }
}

/**
 * Show one notification. Resolves TRUE only if something was actually shown.
 *
 * `tag` de-duplicates at the OS level: two passes that somehow produce the same
 * event replace one another in the tray instead of stacking. Callers pass the
 * event's idempotency key, so the OS dedup and the inbox dedup agree.
 */
export async function showNotification(title: string, body: string, tag: string): Promise<boolean> {
  if (notificationPermission() !== 'granted') return false;

  const options: NotificationOptions = { body, tag, icon: '/apple-touch-icon.png' };

  try {
    new Notification(title, options);
    return true;
  } catch {
    // TypeError on Android Chrome ("Failed to construct 'Notification':
    // Illegal constructor"), and anything else a hardened browser throws. Either
    // way the page-context path did not work; try the worker that is already
    // registered, and never register one here.
  }

  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration || typeof registration.showNotification !== 'function') return false;
    await registration.showNotification(title, options);
    return true;
  } catch {
    return false;
  }
}
