// Registering the app-shell worker without evicting the push worker.
//
// THE COLLISION THIS FILE EXISTS FOR. A service-worker registration is keyed by
// SCOPE. src/nakamigos/lib/notifications.js registers `/push-sw.js` with no
// scope option, which resolves to "/" — the same scope the app shell needs.
// Registering a different script at a scope that already has one REPLACES it, so
// a naive `navigator.serviceWorker.register('/sw.js')` would silently unregister
// the push worker of every user who had enabled notifications. They would keep
// the toggle switched on and stop receiving anything.
//
// So the app shell yields. Push is a capability a user explicitly asked for and
// cannot tell has broken; an offline notice is a convenience whose absence is
// self-evident (you get the browser's own offline page). Yielding is reported
// rather than swallowed — `deferred-to-push` is a distinct outcome with a
// reason, because "we chose not to" and "it failed" are different facts.
//
// The reverse direction is not defendable from here: if a user enables
// notifications later, notifications.js will replace THIS worker at "/" and the
// offline notice quietly stops working. That is the acceptable half of the
// trade, and fixing it properly means one worker owning "/" and handling both —
// which is an edit to nakamigos' notification path, not to this slice.
//
// src/nakamigos/App.jsx has carried the comment "Service worker disabled when
// embedded in Tegriddy Farms (Tegriddy has its own SW at a different scope)"
// since before any such worker existed. It is true now except for the scope:
// this one owns "/", which CONTAINS /nakamigos rather than sitting beside it.
// The sub-app registers no shell worker of its own, so there is nothing to
// collide with there — only the push worker above.

export const APP_SW_URL = '/sw.js';
export const APP_SW_SCOPE = '/';

/** The nakamigos push worker, by path. Compared on pathname, never on origin. */
export const PUSH_SW_PATH = '/push-sw.js';

/** The subset of ServiceWorkerRegistration this module reasons about. */
export interface ExistingRegistration {
  /** Script URL of active ?? waiting ?? installing, or null when none is set. */
  scriptURL: string | null;
  /** Absolute scope URL, as ServiceWorkerRegistration.scope reports it. */
  scope: string;
}

export type RegistrationDecision =
  | { action: 'register' }
  | { action: 'defer'; reason: string };

function samePath(url: string | null, path: string): boolean {
  if (!url) return false;
  try {
    return new URL(url, 'https://placeholder.invalid').pathname === path;
  } catch {
    return false;
  }
}

function sameScope(a: string, b: string): boolean {
  try {
    return new URL(a, 'https://placeholder.invalid').pathname === new URL(b, 'https://placeholder.invalid').pathname;
  } catch {
    return a === b;
  }
}

/**
 * Pure: given what is already registered, may the app shell take the scope?
 *
 * Exported and tested away from the browser because this is the decision that,
 * if it regresses, breaks something invisible in somebody else's feature.
 */
export function decideRegistration(
  existing: readonly ExistingRegistration[],
  targetScope: string = APP_SW_SCOPE,
): RegistrationDecision {
  for (const reg of existing) {
    if (!sameScope(reg.scope, targetScope)) continue;
    if (samePath(reg.scriptURL, APP_SW_URL)) return { action: 'register' };
    if (samePath(reg.scriptURL, PUSH_SW_PATH)) {
      return {
        action: 'defer',
        reason:
          'The notification worker already owns this scope. Registering the offline shell here would ' +
          'unregister it and silently stop push notifications, so the offline shell is not installed.',
      };
    }
    return {
      action: 'defer',
      reason:
        `Another service worker (${reg.scriptURL ?? 'unknown script'}) already owns this scope. ` +
        'The offline shell is not installed rather than replacing something it did not put there.',
    };
  }
  return { action: 'register' };
}

export type RegistrationOutcome =
  /** No service-worker API — nothing was attempted. */
  | { state: 'unsupported'; reason: string }
  /** Deliberately not registered in this build. */
  | { state: 'disabled'; reason: string }
  /** Another worker owns the scope; see decideRegistration. */
  | { state: 'deferred'; reason: string }
  | { state: 'registered'; scope: string }
  | { state: 'failed'; reason: string };

export interface RegisterOptions {
  /** Injection seam for tests; production uses navigator.serviceWorker. */
  container?: ServiceWorkerContainer;
  /**
   * False skips registration entirely. Defaults to a production build — a
   * worker in dev caches nothing useful and hides module changes behind an
   * asset cache, which is a debugging trap rather than a feature.
   */
  enabled?: boolean;
}

function describe(reg: ServiceWorkerRegistration): ExistingRegistration {
  const worker = reg.active ?? reg.waiting ?? reg.installing;
  return { scriptURL: worker ? worker.scriptURL : null, scope: reg.scope };
}

export async function registerAppServiceWorker(
  opts: RegisterOptions = {},
): Promise<RegistrationOutcome> {
  const enabled = opts.enabled ?? import.meta.env.PROD;
  if (!enabled) {
    return {
      state: 'disabled',
      reason: 'Service workers are not registered in development builds.',
    };
  }

  const container =
    opts.container ??
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined);
  if (!container) {
    return { state: 'unsupported', reason: 'This browser has no service-worker support.' };
  }

  try {
    const existing = await container.getRegistrations();
    const decision = decideRegistration(existing.map(describe));
    if (decision.action === 'defer') return { state: 'deferred', reason: decision.reason };

    const registration = await container.register(APP_SW_URL, { scope: APP_SW_SCOPE });
    return { state: 'registered', scope: registration.scope };
  } catch (err) {
    return {
      state: 'failed',
      reason: err instanceof Error ? err.message : 'The offline shell could not be installed.',
    };
  }
}
