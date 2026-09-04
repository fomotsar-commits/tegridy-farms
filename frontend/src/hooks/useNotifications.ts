import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  INBOX_STORAGE_KEY,
  dismiss as dismissEntry,
  emptyInbox,
  ingestWithDelta,
  markAllRead as markAllReadPure,
  markDelivered,
  markRead as markReadPure,
  parseInbox,
  serializeInbox,
  unreadBreakdown,
  type InboxEntry,
  type InboxState,
} from '../lib/alerts/inbox';
import {
  deliveryPlan,
  readPushEnvironment,
  resolveChannels,
  type ChannelId,
  type ChannelStatus,
} from '../lib/alerts/channels';
import { requestWebNotificationPermission, showNotification } from '../lib/alerts/webNotification';
import type { Evaluation } from '../lib/alerts/evaluate';

// The in-app notification inbox, plus the one channel that can leave the page.
//
// It aggregates two things and keeps them apart: events (a fact was read and it
// matched a rule) and gaps (a rule could not be evaluated). A bell showing one
// combined number would let an hour of outage look like an hour of alerts, so the
// unread count is always available split as well as summed.
//
// DELIVERY IS RECORDED AFTER IT HAPPENS, NOT WHEN IT IS PLANNED. An entry is
// ingested carrying `['in-app']` only — ingesting IS the in-app delivery — and
// `web-notification` is added to a row only once `showNotification` has returned
// true. A browser that refused, threw (Android Chrome's illegal constructor) or
// silently dropped the notification therefore leaves a row that says no
// notification was shown, which is the true thing.
//
// THE FOLD HAPPENS OUTSIDE THE STATE UPDATER. React runs updaters twice under
// StrictMode, and the previous shape computed the newly-added rows inside one —
// which is how usePriceAlerts.ts:329 came to document double-fired OS
// notifications. The delta is computed from a ref, once, and the shows are driven
// off it in a separate effect guarded by a Set of ids already announced.

export interface UseNotificationsState {
  entries: InboxEntry[];
  unread: { events: number; gaps: number; total: number };
  channels: ChannelStatus[];
  /** The channels an event ingested right now would be ATTEMPTED on. */
  plan: ChannelId[];
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
  /** Ask the browser for notification permission. Call from a click handler only. */
  requestNotificationPermission: () => void;
}

function loadInbox(): InboxState {
  try {
    return parseInbox(localStorage.getItem(INBOX_STORAGE_KEY));
  } catch {
    return emptyInbox();
  }
}

export function useNotifications(
  evaluations: readonly Evaluation[],
  ruleLabels: Record<string, string>,
): UseNotificationsState {
  const [state, setState] = useState<InboxState>(loadInbox);
  const stateRef = useRef(state);
  stateRef.current = state;

  // State rather than a memo: the permission can change mid-session, from our own
  // button. Memoised once per mount, a grant would leave the panel saying "off"
  // until the next reload while notifications were already arriving.
  const [channels, setChannels] = useState<ChannelStatus[]>(() => resolveChannels(readPushEnvironment()));
  const plan = useMemo(() => deliveryPlan(channels), [channels]);

  // Structural key: labels are rebuilt on every render by callers that derive
  // them from the rule list, and ingesting on identity alone would re-fold the
  // same pass forever.
  const labelsKey = JSON.stringify(ruleLabels);
  const labels = useMemo(() => JSON.parse(labelsKey) as Record<string, string>, [labelsKey]);

  const [pending, setPending] = useState<InboxEntry[]>([]);
  const announcedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (evaluations.length === 0) return;
    const { state: next, added } = ingestWithDelta(stateRef.current, { evaluations, ruleLabels: labels });
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
    if (added.length > 0) setPending((queue) => [...queue, ...added]);
  }, [evaluations, labels]);

  useEffect(() => {
    if (pending.length === 0) return;
    if (!plan.includes('web-notification')) {
      // Nothing will be attempted, so the queue is dropped rather than held: a
      // row that waits for a channel that is off would be announced later, out of
      // context, if the user ever switched it on.
      setPending([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const entry of pending) {
        if (announcedRef.current.has(entry.id)) continue;
        // Claimed BEFORE the await, so a StrictMode double-invoke cannot both
        // pass the check and both show.
        announcedRef.current.add(entry.id);
        const shown = await showNotification(entry.title, entry.body, entry.id);
        if (shown && !cancelled) setState((s) => markDelivered(s, entry.id, 'web-notification'));
      }
      if (!cancelled) setPending([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, plan]);

  useEffect(() => {
    try {
      localStorage.setItem(INBOX_STORAGE_KEY, serializeInbox(state));
    } catch {
      /* quota or private mode — the inbox stays in memory for this session */
    }
  }, [state]);

  // Another tab writing the inbox is the same inbox. Adopting it keeps a row
  // marked read in one tab from looking unread in the other.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== INBOX_STORAGE_KEY) return;
      setState(parseInbox(event.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const markRead = useCallback((id: string) => setState((s) => markReadPure(s, id)), []);
  const markAllRead = useCallback(() => setState((s) => markAllReadPure(s)), []);
  const dismiss = useCallback((id: string) => setState((s) => dismissEntry(s, id)), []);
  const clearAll = useCallback(() => setState(emptyInbox()), []);

  const requestNotificationPermission = useCallback(() => {
    void (async () => {
      await requestWebNotificationPermission();
      setChannels(resolveChannels(readPushEnvironment()));
    })();
  }, []);

  const breakdown = unreadBreakdown(state);

  return {
    entries: state.entries,
    unread: { ...breakdown, total: breakdown.events + breakdown.gaps },
    channels,
    plan,
    markRead,
    markAllRead,
    dismiss,
    clearAll,
    requestNotificationPermission,
  };
}
