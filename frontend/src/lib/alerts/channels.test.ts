// Guard for the delivery channels.
//
// The failure this file exists to prevent is a subscribe button that WORKS —
// registers a real PushSubscription, flips a real toggle — on a deployment where
// nothing will ever send to it. That switch reads as protection and delivers
// none, and the user finds out by missing the alert it was for.
//
// So the assertions are about refusal: with no VAPID key, or with keys but no
// sender, `canSubscribe` must be false, the state must not be `ready`, and the
// reason must be a sentence a person can act on.

import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_DELIVERY_AVAILABLE,
  BACKGROUND_DELIVERY_REQUIREMENTS,
  IN_APP_LIMITATION,
  deliveryPlan,
  inAppChannel,
  resolveChannels,
  resolvePushChannel,
  type PushEnvironment,
} from './channels';

function env(over: Partial<PushEnvironment> = {}): PushEnvironment {
  return {
    vapidPublicKey: 'BKd0-test-public-key',
    hasNotificationApi: true,
    hasServiceWorker: true,
    permission: 'granted',
    subscribed: false,
    ...over,
  };
}

describe('no sender exists, and the surface says so', () => {
  it('background delivery is not available', () => {
    expect(BACKGROUND_DELIVERY_AVAILABLE).toBe(false);
  });

  it('a fully-permitted, fully-keyed browser still cannot subscribe', () => {
    const push = resolvePushChannel(env());
    expect(push.state).toBe('no-sender');
    expect(push.canSubscribe).toBe(false);
  });

  it('says nothing would send, and names what is missing', () => {
    const push = resolvePushChannel(env());
    expect(push.detail).toMatch(/nothing exists yet that would send/i);
    expect(push.operatorStep).toMatch(/worker/i);
  });

  it('lists what has to exist before push may be offered', () => {
    expect(BACKGROUND_DELIVERY_REQUIREMENTS.length).toBeGreaterThan(0);
    for (const req of BACKGROUND_DELIVERY_REQUIREMENTS) expect(req.length).toBeGreaterThan(20);
  });
});

describe('an unset VAPID key degrades to in-app, honestly', () => {
  it('reports unconfigured rather than broken', () => {
    const push = resolvePushChannel(env({ vapidPublicKey: '' }));
    expect(push.state).toBe('unconfigured');
    expect(push.canSubscribe).toBe(false);
  });

  it('says alerts still land in the inbox, so the absence is not read as total failure', () => {
    const push = resolvePushChannel(env({ vapidPublicKey: '' }));
    expect(push.detail).toMatch(/inbox/i);
  });

  it('names every variable the operator must set', () => {
    const step = resolvePushChannel(env({ vapidPublicKey: '' })).operatorStep ?? '';
    for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'VITE_VAPID_PUBLIC_KEY']) {
      expect(step, `operator step must name ${key}`).toContain(key);
    }
  });

  it('the missing key is reported BEFORE the missing sender — it is the first thing to fix', () => {
    expect(resolvePushChannel(env({ vapidPublicKey: '' })).state).toBe('unconfigured');
  });
});

describe('browser-side refusals are distinguished from ours', () => {
  it('no Notification API → unsupported, and no operator step (nothing they could set)', () => {
    const push = resolvePushChannel(env({ hasNotificationApi: false }));
    expect(push.state).toBe('unsupported');
    expect(push.operatorStep).toBeNull();
  });

  it('no service worker → unsupported', () => {
    expect(resolvePushChannel(env({ hasServiceWorker: false })).state).toBe('unsupported');
  });

  it('denied permission → blocked, not unconfigured', () => {
    expect(resolvePushChannel(env({ permission: 'denied' })).state).toBe('blocked');
  });
});

describe('the in-app inbox is the one honest channel, and states its own limit', () => {
  it('is ready unconditionally', () => {
    expect(inAppChannel().state).toBe('ready');
  });

  it('the limitation sentence says evaluation stops when the app is closed', () => {
    expect(IN_APP_LIMITATION).toMatch(/closed/i);
  });

  it('the delivery plan always contains in-app', () => {
    expect(deliveryPlan(resolveChannels(env()))).toContain('in-app');
  });

  it('the delivery plan never contains web-push while nothing sends', () => {
    for (const overrides of [
      {},
      { vapidPublicKey: '' },
      { permission: 'denied' as const },
      { subscribed: true },
      { hasNotificationApi: false },
    ]) {
      expect(deliveryPlan(resolveChannels(env(overrides)))).toEqual(['in-app']);
    }
  });
});

describe('every non-ready channel explains itself', () => {
  it('carries a non-empty detail in every state that is not ready', () => {
    const cases: Partial<PushEnvironment>[] = [
      {},
      { vapidPublicKey: '' },
      { permission: 'denied' },
      { hasNotificationApi: false },
      { hasServiceWorker: false },
      { subscribed: true },
    ];
    for (const overrides of cases) {
      const push = resolvePushChannel(env(overrides));
      if (push.state === 'ready') continue;
      expect(push.detail.length, JSON.stringify(overrides)).toBeGreaterThan(20);
    }
  });

  it('canSubscribe is never true while nothing would send', () => {
    const permissions: PushEnvironment['permission'][] = ['default', 'granted', 'denied', null];
    for (const permission of permissions) {
      for (const subscribed of [false, true]) {
        for (const vapidPublicKey of ['', 'BKd0-test']) {
          expect(resolvePushChannel(env({ permission, subscribed, vapidPublicKey })).canSubscribe).toBe(false);
        }
      }
    }
  });
});
