// Guard for the one notification site.
//
// The bug this module exists for is invisible in a browser that works: on
// Android Chrome `new Notification()` throws TypeError no matter the permission,
// so the old private `try { … } catch { }` copies showed nothing while their
// callers carried on as if they had. The contract tested here is that the
// fallback runs, that it never registers a worker of its own, and above all that
// the return value is TRUE only when something was actually shown — because the
// alerts inbox stamps a delivery record from it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hasNotificationApi, notificationPermission, requestWebNotificationPermission, showNotification } from './webNotification';

/** What the module is expected to pass `new Notification(...)`. */
type NotificationCall = (title: string, options?: NotificationOptions) => void;

/** jsdom ships no Notification, so every test builds the browser it wants. */
function stubNotification(permission: NotificationPermission, impl?: () => void) {
  // The spy carries the constructor's argument list, so the title/tag/body
  // assertions read real arguments. Left untyped it would spy on a zero-argument
  // call, and the checks below could only be written as casts.
  const ctor = vi.fn<NotificationCall>(impl ?? (() => undefined));
  const Fake = function (this: unknown, title: string, options?: NotificationOptions) {
    ctor(title, options);
  } as unknown as typeof Notification;
  Object.defineProperty(Fake, 'permission', { value: permission, configurable: true });
  Object.defineProperty(Fake, 'requestPermission', {
    value: vi.fn(async () => 'granted' as NotificationPermission),
    configurable: true,
  });
  vi.stubGlobal('Notification', Fake);
  return ctor;
}

function stubServiceWorker(registration: unknown) {
  const getRegistration = vi.fn<() => Promise<unknown>>(async () => registration);
  const register = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration, register } });
  return { getRegistration, register };
}

const realNavigator = globalThis.navigator;

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('navigator', realNavigator);
  vi.unstubAllGlobals();
});

describe('the page-context path, when the browser allows it', () => {
  it('constructs once, tags with the id, and reports true', () => {
    const ctor = stubNotification('granted');
    return showNotification('Title', 'Body', 'event-key-1').then((shown) => {
      expect(shown).toBe(true);
      expect(ctor).toHaveBeenCalledTimes(1);
      // The call is guaranteed by the assertion above, but the compiler cannot
      // see that under noUncheckedIndexedAccess, and a cast here would hide a
      // real regression instead of failing on one.
      const call = ctor.mock.calls[0];
      if (!call) throw new Error('the Notification constructor was not called');
      const [title, options] = call;
      expect(title).toBe('Title');
      // The tag is the event's idempotency key, so the OS tray's dedup and the
      // inbox's dedup agree instead of stacking duplicates. Reading through `?.`
      // still fails the assertion if the module ever stops passing options.
      expect(options?.tag).toBe('event-key-1');
      expect(options?.body).toBe('Body');
    });
  });

  it('shows nothing without permission, and does not ask at fire time', async () => {
    // Asking here is asking without a user gesture: browsers deny it, and Chrome
    // penalises the origin for having asked at all.
    const ctor = stubNotification('default');
    expect(await showNotification('T', 'B', 'k')).toBe(false);
    expect(ctor).not.toHaveBeenCalled();
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it('shows nothing when the browser has no API at all', async () => {
    vi.stubGlobal('window', {});
    expect(hasNotificationApi()).toBe(false);
    expect(await showNotification('T', 'B', 'k')).toBe(false);
  });
});

describe('the Android Chrome path', () => {
  it('falls back to the registered worker when the constructor throws', async () => {
    // "Failed to construct 'Notification': Illegal constructor" — the whole
    // reason this module is not four inline try/catches.
    const ctor = stubNotification('granted', () => {
      throw new TypeError('Illegal constructor');
    });
    const showViaWorker = vi.fn<(title: string, options?: NotificationOptions) => Promise<void>>(
      async () => undefined,
    );
    const sw = stubServiceWorker({ showNotification: showViaWorker });

    expect(await showNotification('Title', 'Body', 'tag-1')).toBe(true);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(showViaWorker).toHaveBeenCalledTimes(1);
    expect(showViaWorker.mock.calls[0]?.[1]?.tag).toBe('tag-1');
    // Registering one here would collide with the app's own worker scope
    // (lib/pwa/serviceWorker.ts), so this path only ever USES an existing one.
    expect(sw.register).not.toHaveBeenCalled();
  });

  it('returns FALSE when neither path worked', async () => {
    // The value the inbox believes. A `true` here would stamp a row "shown as a
    // browser notification" for a notification nobody saw.
    stubNotification('granted', () => {
      throw new TypeError('Illegal constructor');
    });
    stubServiceWorker(undefined);
    expect(await showNotification('T', 'B', 'k')).toBe(false);
  });

  it('returns false when the worker exists but cannot show', async () => {
    stubNotification('granted', () => {
      throw new TypeError('Illegal constructor');
    });
    stubServiceWorker({});
    expect(await showNotification('T', 'B', 'k')).toBe(false);
  });
});

describe('permission is read and requested defensively', () => {
  it('reads null when there is no API', () => {
    vi.stubGlobal('window', {});
    expect(notificationPermission()).toBeNull();
  });

  it('requests through the browser and returns its answer', async () => {
    stubNotification('default');
    expect(await requestWebNotificationPermission()).toBe('granted');
  });

  it('a browser that throws on request yields null rather than an unhandled rejection', async () => {
    stubNotification('default');
    Object.defineProperty(Notification, 'requestPermission', {
      value: () => {
        throw new Error('nope');
      },
      configurable: true,
    });
    expect(await requestWebNotificationPermission()).toBeNull();
  });
});
