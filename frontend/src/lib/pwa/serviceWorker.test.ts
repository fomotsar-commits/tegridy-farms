// The scope collision, pinned.
//
// Registering a service worker at a scope that already has a different one
// REPLACES it. /push-sw.js registers at "/" and the app shell wants "/", so a
// careless registration silently unregisters the push worker of everybody who
// turned notifications on — and they keep the toggle switched on while nothing
// arrives. Nothing in the app would surface that; only this file stands between
// the two.

import { describe, it, expect, vi } from 'vitest';
import {
  APP_SW_SCOPE,
  APP_SW_URL,
  PUSH_SW_PATH,
  decideRegistration,
  registerAppServiceWorker,
  type ExistingRegistration,
} from './serviceWorker';

const ORIGIN = 'https://app.test';

function reg(scriptPath: string | null, scope = '/'): ExistingRegistration {
  return { scriptURL: scriptPath === null ? null : `${ORIGIN}${scriptPath}`, scope: `${ORIGIN}${scope}` };
}

describe('decideRegistration', () => {
  it('registers when nothing owns the scope', () => {
    expect(decideRegistration([])).toEqual({ action: 'register' });
  });

  it('yields to the push worker rather than evicting it', () => {
    const decision = decideRegistration([reg(PUSH_SW_PATH)]);
    expect(decision.action).toBe('defer');
    if (decision.action !== 'defer') throw new Error('unreachable');
    // The reason has to name the consequence, because the consequence is
    // invisible: notifications stop while the toggle still reads "on".
    expect(decision.reason).toMatch(/push notification/i);
  });

  it('re-registers over itself — an existing app shell is not a blocker', () => {
    expect(decideRegistration([reg(APP_SW_URL)])).toEqual({ action: 'register' });
  });

  it('yields to an unrecognised worker too, rather than assuming it is disposable', () => {
    const decision = decideRegistration([reg('/some-other-sw.js')]);
    expect(decision.action).toBe('defer');
    if (decision.action !== 'defer') throw new Error('unreachable');
    expect(decision.reason).toContain('some-other-sw.js');
  });

  it('ignores registrations at a different scope', () => {
    // A worker scoped to /nakamigos/ does not conflict with "/" — replacing
    // nothing means there is nothing to protect.
    expect(decideRegistration([reg('/nakamigos/other-sw.js', '/nakamigos/')])).toEqual({ action: 'register' });
  });

  it('treats a registration with no worker attached as occupying the scope', () => {
    // A registration mid-teardown reports null for active/waiting/installing.
    // Claiming its scope on the strength of "we could not tell what it was" is
    // exactly the move this whole file exists to prevent.
    const decision = decideRegistration([reg(null)]);
    expect(decision.action).toBe('defer');
  });
});

function container(existing: ExistingRegistration[], register = vi.fn()) {
  return {
    getRegistrations: vi.fn(async () =>
      existing.map((e) => ({
        scope: e.scope,
        active: e.scriptURL ? { scriptURL: e.scriptURL } : null,
        waiting: null,
        installing: null,
      })),
    ),
    register,
  } as unknown as ServiceWorkerContainer;
}

describe('registerAppServiceWorker', () => {
  it('does nothing in a development build', async () => {
    const register = vi.fn();
    const outcome = await registerAppServiceWorker({ container: container([], register), enabled: false });
    expect(outcome.state).toBe('disabled');
    expect(register).not.toHaveBeenCalled();
  });

  it('registers at the root scope when the scope is free', async () => {
    const register = vi.fn(async () => ({ scope: `${ORIGIN}/` }) as ServiceWorkerRegistration);
    const outcome = await registerAppServiceWorker({ container: container([], register), enabled: true });
    expect(outcome).toEqual({ state: 'registered', scope: `${ORIGIN}/` });
    expect(register).toHaveBeenCalledWith(APP_SW_URL, { scope: APP_SW_SCOPE });
  });

  it('never calls register when the push worker holds the scope', async () => {
    const register = vi.fn();
    const outcome = await registerAppServiceWorker({
      container: container([reg(PUSH_SW_PATH)], register),
      enabled: true,
    });
    expect(outcome.state).toBe('deferred');
    expect(register).not.toHaveBeenCalled();
  });

  it('reports a rejected registration as failed rather than throwing into the render', async () => {
    const register = vi.fn(async () => {
      throw new Error('SecurityError: insecure origin');
    });
    const outcome = await registerAppServiceWorker({ container: container([], register), enabled: true });
    expect(outcome.state).toBe('failed');
    if (outcome.state !== 'failed') throw new Error('unreachable');
    expect(outcome.reason).toContain('insecure origin');
  });

  it('reports an absent API as unsupported without pretending it registered', async () => {
    const outcome = await registerAppServiceWorker({ container: undefined, enabled: true });
    // jsdom has no serviceWorker on navigator, which is exactly the shape of a
    // browser that does not support it.
    expect(outcome.state).toBe('unsupported');
  });
});
