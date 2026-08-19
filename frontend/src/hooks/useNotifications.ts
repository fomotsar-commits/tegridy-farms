import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  INBOX_STORAGE_KEY,
  dismiss as dismissEntry,
  emptyInbox,
  ingest,
  markAllRead as markAllReadPure,
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
import type { Evaluation } from '../lib/alerts/evaluate';

// The in-app notification inbox.
//
// It aggregates two things and keeps them apart: events (a fact was read and it
// matched a rule) and gaps (a rule could not be evaluated). A bell showing one
// combined number would let an hour of outage look like an hour of alerts, so the
// unread count is always available split as well as summed.
//
// Delivery channels are resolved from the real browser environment, and the plan
// is recorded ON each entry at ingest time. That matters later: an entry that says
// `['in-app']` is a permanent record that nothing was pushed for it, rather than a
// row whose delivery history is inferred from whatever the config happens to be
// when someone looks.

export interface UseNotificationsState {
  entries: InboxEntry[];
  unread: { events: number; gaps: number; total: number };
  channels: ChannelStatus[];
  /** The channels an event ingested right now would be recorded against. */
  plan: ChannelId[];
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
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

  // Resolved once per mount: none of the inputs (VAPID key at build time, API
  // presence, permission) change without a reload or a user action that reloads.
  const channels = useMemo(() => resolveChannels(readPushEnvironment()), []);
  const plan = useMemo(() => deliveryPlan(channels), [channels]);

  // Structural key: labels are rebuilt on every render by callers that derive
  // them from the rule list, and ingesting on identity alone would re-fold the
  // same pass forever.
  const labelsKey = JSON.stringify(ruleLabels);
  const labels = useMemo(() => JSON.parse(labelsKey) as Record<string, string>, [labelsKey]);

  useEffect(() => {
    if (evaluations.length === 0) return;
    setState((prev) => ingest(prev, { evaluations, ruleLabels: labels, channels: plan }));
  }, [evaluations, plan, labels]);

  useEffect(() => {
    try {
      localStorage.setItem(INBOX_STORAGE_KEY, serializeInbox(state));
    } catch {
      /* quota or private mode — the inbox stays in memory for this session */
    }
  }, [state]);

  const markRead = useCallback((id: string) => setState((s) => markReadPure(s, id)), []);
  const markAllRead = useCallback(() => setState((s) => markAllReadPure(s)), []);
  const dismiss = useCallback((id: string) => setState((s) => dismissEntry(s, id)), []);
  const clearAll = useCallback(() => setState(emptyInbox()), []);

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
  };
}
