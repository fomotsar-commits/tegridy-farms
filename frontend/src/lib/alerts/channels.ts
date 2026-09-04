// Where an alert can actually go, and — more often — where it cannot.
//
// Two independent things have to be true before a browser push arrives, and the
// venue currently has neither:
//
//   A KEY PAIR. web-push needs VAPID keys. `api/_lib/push.js` no-ops without
//     them, silently and correctly. The browser half needs VITE_VAPID_PUBLIC_KEY,
//     and without it `pushManager.subscribe` cannot even be called.
//
//   A SENDER. A subscription is an address, not a delivery. Something has to run
//     when the tab is closed, notice the event, and post to the push service.
//     That is the F9 worker (docs/BATTLE_PLAN.md), which is not built. Vercel
//     functions cannot be it: they only run when something calls them.
//
// So a "Enable push notifications" button that registers a subscription would be
// theatre — it would succeed, look enabled, and deliver nothing, and the user
// would discover this by missing the event it was for. `BACKGROUND_DELIVERY_
// AVAILABLE` is a constant rather than an env flag for the same reason
// KEEPER_AVAILABLE is in lib/triggers/armState.ts: an operator cannot make a
// worker exist by setting a variable, and a dial would invite exactly that.
//
// The in-app inbox is the one channel that is honestly available: it is local, it
// needs no key and no worker, and it is filled by evaluation passes that happen
// while the app is open. It is also, therefore, the channel whose limits have to
// be stated — see IN_APP_LIMITATION.

// A THIRD channel sits between those two and must not be confused with either.
// The Web Notification API shows an OS-level notification from a page that is
// already running — no key, no subscription, no worker — so it is honestly
// available today. What it is NOT is push: it can only fire during a pass, and a
// pass only happens while a tab of this site is open. That boundary is in its id,
// its label, its detail and on every inbox row it stamps, because "browser
// notification" is exactly what a user would otherwise read as "it will find me".

export type ChannelId = 'in-app' | 'web-notification' | 'web-push';

export type ChannelState =
  /** Will carry events. */
  | 'ready'
  /** The browser cannot do this at all. */
  | 'unsupported'
  /** This deployment has not been given what the channel needs. */
  | 'unconfigured'
  /** The user refused permission. */
  | 'blocked'
  /** Configured and permitted, but nothing exists that would send. */
  | 'no-sender'
  /** Available and not switched on. */
  | 'off';

export interface ChannelStatus {
  id: ChannelId;
  label: string;
  state: ChannelState;
  /**
   * One sentence, rendered verbatim. Never empty except on a `ready` channel
   * that has nothing left to qualify — `web-notification` is `ready` and still
   * carries one, because being on is not the same as being always-on and the
   * difference is the whole thing a user needs to know about it.
   */
  detail: string;
  /** What the operator must do, or null when no operator action would help. */
  operatorStep: string | null;
  /** True only when pressing a subscribe control would achieve something. */
  canSubscribe: boolean;
}

/**
 * Flips only when a service exists that consumes an event stream and posts to the
 * push service on its own schedule. See BACKGROUND_DELIVERY_REQUIREMENTS.
 */
export const BACKGROUND_DELIVERY_AVAILABLE = false;

/**
 * What that service has to provide before push may be offered. Exported so the
 * surface prints it verbatim: the user asking "why can't I turn this on" gets the
 * same answer as the operator asking "what is left to build".
 */
export const BACKGROUND_DELIVERY_REQUIREMENTS: readonly string[] = [
  'A long-running process — not a Vercel function, which only runs when something calls it — that watches the same sources the rules are evaluated against.',
  'Server-side evaluation of stored rules, so a rule keeps being checked after the tab is closed.',
  'Idempotency per (rule, event), so a restart cannot deliver the same alert twice.',
  'Per-attempt delivery receipts readable back into this UI: an alert that failed to send must be visible as failed, not as never triggered.',
  'A VAPID key pair on both halves — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY on the server, VITE_VAPID_PUBLIC_KEY in the client build.',
];

/**
 * The in-app inbox's honest boundary, rendered wherever the inbox is. Without it
 * an empty inbox reads as "nothing happened" when it may mean "the app was shut".
 */
export const IN_APP_LIMITATION =
  'Rules are evaluated while this app is open. Nothing runs when it is closed, so the inbox is a record of what was read here — not a complete history of what happened.';

export interface PushEnvironment {
  /** VITE_VAPID_PUBLIC_KEY as built into this bundle; empty when unset. */
  vapidPublicKey: string;
  hasNotificationApi: boolean;
  hasServiceWorker: boolean;
  /** The browser's current Notification.permission, or null when unreadable. */
  permission: 'default' | 'granted' | 'denied' | null;
  /** Whether a PushSubscription already exists for this browser. */
  subscribed: boolean;
}

const VAPID_OPERATOR_STEP =
  'Generate a key pair (`npx web-push generate-vapid-keys`) and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT on the deployment, plus VITE_VAPID_PUBLIC_KEY in the client build. Push stays unavailable — not broken — until all four are set.';

/**
 * Resolve the push channel from the environment. Order matters: each branch is a
 * reason the NEXT branch could not be reached, so reporting the first true one
 * gives the user the fact they can act on rather than the last one in the chain.
 */
export function resolvePushChannel(env: PushEnvironment): ChannelStatus {
  const base = { id: 'web-push' as const, label: 'Browser push', canSubscribe: false };

  if (!env.hasNotificationApi || !env.hasServiceWorker) {
    return {
      ...base,
      state: 'unsupported',
      detail:
        'This browser has no Notifications or Service Worker support, so push cannot be registered here. Alerts still land in the inbox.',
      operatorStep: null,
    };
  }

  if (!env.vapidPublicKey) {
    return {
      ...base,
      state: 'unconfigured',
      detail:
        'This deployment has no VAPID public key, so no push subscription can be created. Alerts land in the inbox on this device only.',
      operatorStep: VAPID_OPERATOR_STEP,
    };
  }

  if (env.permission === 'denied') {
    return {
      ...base,
      state: 'blocked',
      detail:
        'Notifications are blocked for this site in your browser settings. Alerts still land in the inbox.',
      operatorStep: null,
    };
  }

  if (!BACKGROUND_DELIVERY_AVAILABLE) {
    return {
      ...base,
      state: 'no-sender',
      detail:
        'A subscription would be created, but nothing exists yet that would send to it — no service watches your rules while this app is closed. Registering one would look enabled and deliver nothing, so it is not offered. Alerts land in the inbox.',
      operatorStep:
        'Stand up the delivery worker described in docs/BATTLE_PLAN.md (F9). Until it runs, push is address-without-a-sender and stays closed.',
    };
  }

  if (!env.subscribed) {
    return {
      ...base,
      state: 'off',
      detail: 'Push is available on this device and not switched on.',
      operatorStep: null,
      canSubscribe: true,
    };
  }

  return { ...base, state: 'ready', detail: '', operatorStep: null };
}

export function inAppChannel(): ChannelStatus {
  return {
    id: 'in-app',
    label: 'In-app inbox',
    state: 'ready',
    detail: '',
    operatorStep: null,
    canSubscribe: false,
  };
}

/** The scope sentence, repeated in every state so it cannot be read past. */
const WHILE_OPEN =
  'A rule that fires during a pass in an open tab is shown as a system notification. Nothing is shown when every tab of this site is closed.';

/**
 * Resolve the OS-notification channel.
 *
 * There is no `unconfigured` branch and no operator step in any state: this
 * channel needs nothing from the deployment. Every state it can be in is a fact
 * about the visitor's own browser, which is why the reasons are addressed to them
 * rather than to whoever runs the site.
 */
export function resolveWebNotificationChannel(env: PushEnvironment): ChannelStatus {
  const base = {
    id: 'web-notification' as const,
    label: 'Browser notifications (while a tab is open)',
    operatorStep: null,
    canSubscribe: false,
  };

  if (!env.hasNotificationApi) {
    return {
      ...base,
      state: 'unsupported',
      detail:
        'This browser has no Notifications API (iOS Safari outside an installed app, for one), so nothing can be shown outside the page. Alerts still land in the inbox.',
    };
  }
  if (env.permission === 'denied') {
    return {
      ...base,
      state: 'blocked',
      detail:
        'Notifications are blocked for this site in your browser settings, so none can be shown. Alerts still land in the inbox.',
    };
  }
  if (env.permission !== 'granted') {
    return {
      ...base,
      state: 'off',
      detail: `Available and not switched on. ${WHILE_OPEN}`,
      canSubscribe: true,
    };
  }
  return {
    ...base,
    state: 'ready',
    detail: `${WHILE_OPEN} Each inbox row records whether its notification was actually shown.`,
  };
}

export function resolveChannels(env: PushEnvironment): ChannelStatus[] {
  return [inAppChannel(), resolveWebNotificationChannel(env), resolvePushChannel(env)];
}

/**
 * The channels an event will be ATTEMPTED on. Not a record of delivery.
 *
 * Always contains `in-app`: the inbox is local and unconditional, and ingesting a
 * row IS the delivery, which is what makes it safe to stamp at ingest time.
 * Nothing else is. `web-notification` joins the plan in `ready`, but a row is
 * only stamped with it once a show has actually returned true (inbox.markDelivered)
 * — the plan says what will be tried, the row says what happened. `web-push` can
 * never join, so an event can never be labelled "pushed" where nothing pushes.
 */
export function deliveryPlan(channels: readonly ChannelStatus[]): ChannelId[] {
  const out: ChannelId[] = ['in-app'];
  for (const c of channels) {
    if (c.id !== 'in-app' && c.state === 'ready') out.push(c.id);
  }
  return out;
}

/** Read the push environment from the running browser. Pure inputs stay in resolve*. */
export function readPushEnvironment(): PushEnvironment {
  const vapid = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined)?.trim() ?? '';
  const hasNotificationApi = typeof window !== 'undefined' && 'Notification' in window;
  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  let permission: PushEnvironment['permission'] = null;
  if (hasNotificationApi) {
    try {
      permission = Notification.permission;
    } catch {
      permission = null;
    }
  }
  return { vapidPublicKey: vapid, hasNotificationApi, hasServiceWorker, permission, subscribed: false };
}
