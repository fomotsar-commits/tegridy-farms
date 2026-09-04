// The notification inbox: a pure store over what evaluation passes produced.
//
// It holds TWO kinds of entry and refuses to blend them:
//
//   event  a fact was read and it matched a rule. Carries provenance and, where
//          the source gave one, an on-chain anchor.
//   gap    a rule could not be evaluated. This is the entry that stops an outage
//          from reading as a quiet market. It is a first-class row, counted
//          separately, and never silently dropped to keep the list tidy.
//
// `quiet` produces no entry — a rule that was read and found nothing is exactly
// what an empty inbox is supposed to mean, and writing a row for it would drown
// the two things that matter.
//
// Dedup is by key, not by content: events key on the underlying fact
// (`idempotencyKey`), gaps key on (rule, reason). A polling loop that re-reads the
// same block, or an indexer that stays down for an hour, therefore produces one
// row, not one per pass.

import type { ChannelId } from './channels';
import type { AlertEvent, Evaluation } from './evaluate';
import type { AlertRuleKind } from './rules';

export type InboxEntryKind = 'event' | 'gap';

export interface InboxEntry {
  /** Dedup key. Stable for the same underlying fact or the same unreadable reason. */
  id: string;
  kind: InboxEntryKind;
  ruleId: string;
  ruleKind: AlertRuleKind;
  title: string;
  body: string;
  /** Who supplied the fact. Empty string only on gaps, where there is no fact. */
  provenance: string;
  /** Unix seconds. Sort key. */
  at: number;
  read: boolean;
  anchor: { chain: string; ref: string } | null;
  /**
   * The channels this entry was actually DELIVERED on.
   *
   * `in-app` is stamped at ingest because ingesting IS the in-app delivery.
   * Nothing else is stamped here: a channel joins this list only after its send
   * returned true (see `markDelivered`), so a row can never claim a notification
   * that a browser refused, threw on, or silently dropped.
   */
  channels: ChannelId[];
  /** Whether `at` is the source's own as-of time or our read clock. Absent means source. */
  observedAtKind?: 'source' | 'read';
}

export interface InboxState {
  entries: InboxEntry[];
}

/**
 * Hard cap. The inbox is a browser-local record, not an archive; past this the
 * oldest rows are dropped. Gaps are dropped on the same terms as events — an
 * eviction policy that preferred one over the other would quietly rewrite what
 * the inbox says happened.
 */
export const MAX_INBOX_ENTRIES = 200;

export function emptyInbox(): InboxState {
  return { entries: [] };
}

function gapId(ruleId: string, detail: string): string {
  // Reason-scoped: a rule whose source comes back with a DIFFERENT problem gets a
  // new row, but the same problem repeating every 60s does not.
  let h = 0;
  for (let i = 0; i < detail.length; i += 1) {
    h = (h * 31 + detail.charCodeAt(i)) | 0;
  }
  return `gap:${ruleId}:${(h >>> 0).toString(36)}`;
}

/**
 * The only channel an entry is born with.
 *
 * Hardcoded rather than taken from the caller's delivery PLAN, and that is the
 * point: the plan says what will be attempted, and stamping it at ingest would
 * label every row "shown as a browser notification" — including the ones whose
 * show threw, was refused, or never ran because the tab was replaced. Any other
 * channel is added by `markDelivered`, after it happened.
 */
const INGEST_CHANNELS: ChannelId[] = ['in-app'];

function entryFromEvent(event: AlertEvent): InboxEntry {
  return {
    id: event.idempotencyKey,
    kind: 'event',
    ruleId: event.ruleId,
    ruleKind: event.kind,
    title: event.title,
    body: event.body,
    provenance: event.provenance,
    at: event.observedAt,
    read: false,
    anchor: event.anchor,
    channels: [...INGEST_CHANNELS],
    observedAtKind: event.observedAtKind ?? 'source',
  };
}

function entryFromGap(evaluation: Evaluation, ruleLabel: string): InboxEntry {
  return {
    id: gapId(evaluation.ruleId, evaluation.detail),
    kind: 'gap',
    ruleId: evaluation.ruleId,
    ruleKind: evaluation.kind,
    title: `Could not evaluate — ${ruleLabel}`,
    body: evaluation.detail,
    // A gap has no fact, so it has no provenance. Leaving this empty rather than
    // naming the source keeps a gap from reading as something the source said.
    provenance: '',
    at: evaluation.evaluatedAt,
    read: false,
    anchor: null,
    channels: [...INGEST_CHANNELS],
    // A gap is stamped with OUR clock by definition — nothing was read, so no
    // source could have supplied a time.
    observedAtKind: 'read',
  };
}

export interface IngestInput {
  evaluations: readonly Evaluation[];
  /** rule id → short label, for gap titles. */
  ruleLabels: Record<string, string>;
}

export interface IngestResult {
  state: InboxState;
  /**
   * The EVENT rows this fold created, in the order they were created. Gaps are
   * deliberately absent: a notification for "a rule could not be evaluated" is
   * how an outage becomes an hour of buzzing, and the gap row in the list is the
   * honest place for it.
   */
  added: InboxEntry[];
}

/**
 * Fold a pass into the inbox. Pure: returns a new state, never mutates.
 *
 * Existing entries win on collision, so re-reading a fact cannot flip a row back
 * to unread or move it up the list — and cannot re-announce it either, which is
 * what makes `added` safe to drive a notification from.
 */
export function ingestWithDelta(state: InboxState, input: IngestInput): IngestResult {
  const byId = new Map(state.entries.map((e) => [e.id, e]));
  const added: InboxEntry[] = [];
  let changed = false;

  for (const evaluation of input.evaluations) {
    if (evaluation.verdict === 'fired') {
      for (const event of evaluation.events) {
        if (byId.has(event.idempotencyKey)) continue;
        const entry = entryFromEvent(event);
        byId.set(entry.id, entry);
        added.push(entry);
        changed = true;
      }
    } else if (evaluation.verdict === 'cannot-evaluate') {
      const label = input.ruleLabels[evaluation.ruleId] ?? evaluation.kind;
      const entry = entryFromGap(evaluation, label);
      if (byId.has(entry.id)) continue;
      byId.set(entry.id, entry);
      changed = true;
    }
  }

  if (!changed) return { state, added };

  const entries = [...byId.values()].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { state: { entries: entries.slice(0, MAX_INBOX_ENTRIES) }, added };
}

export function ingest(state: InboxState, input: IngestInput): InboxState {
  return ingestWithDelta(state, input).state;
}

/**
 * Record that an entry was delivered on a channel. A no-op for an unknown id, and
 * for a channel already recorded.
 *
 * Separate from ingest so the delivery record is written by whoever WATCHED the
 * send finish. An entry evicted past MAX_INBOX_ENTRIES between the show and this
 * call simply has nothing to stamp, which is why an unknown id is not an error.
 */
export function markDelivered(state: InboxState, id: string, channel: ChannelId): InboxState {
  let changed = false;
  const entries = state.entries.map((e) => {
    if (e.id !== id || e.channels.includes(channel)) return e;
    changed = true;
    return { ...e, channels: [...e.channels, channel] };
  });
  return changed ? { entries } : state;
}

export function markRead(state: InboxState, id: string): InboxState {
  let changed = false;
  const entries = state.entries.map((e) => {
    if (e.id !== id || e.read) return e;
    changed = true;
    return { ...e, read: true };
  });
  return changed ? { entries } : state;
}

export function markAllRead(state: InboxState): InboxState {
  if (state.entries.every((e) => e.read)) return state;
  return { entries: state.entries.map((e) => (e.read ? e : { ...e, read: true })) };
}

export function dismiss(state: InboxState, id: string): InboxState {
  const entries = state.entries.filter((e) => e.id !== id);
  return entries.length === state.entries.length ? state : { entries };
}

export function unreadCount(state: InboxState): number {
  return state.entries.filter((e) => !e.read).length;
}

/**
 * Unread counts split by kind. A bell that showed one number would let an hour of
 * outage look like an hour of alerts, so the two are counted apart everywhere.
 */
export function unreadBreakdown(state: InboxState): { events: number; gaps: number } {
  let events = 0;
  let gaps = 0;
  for (const e of state.entries) {
    if (e.read) continue;
    if (e.kind === 'gap') gaps += 1;
    else events += 1;
  }
  return { events, gaps };
}

// ── Persistence ─────────────────────────────────────────────────────────────
// localStorage, per device. Parsing is defensive on every field: a corrupted or
// hand-edited blob must produce an EMPTY inbox, never a partly-trusted one, since
// a half-parsed entry would render as a real alert.

export const INBOX_STORAGE_KEY = 'tegridy-alert-inbox-v1';

const CHANNEL_IDS = new Set<ChannelId>(['in-app', 'web-notification', 'web-push']);

function parseEntry(raw: unknown): InboxEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (r.kind !== 'event' && r.kind !== 'gap') return null;
  if (typeof r.ruleId !== 'string' || typeof r.ruleKind !== 'string') return null;
  if (typeof r.title !== 'string' || typeof r.body !== 'string') return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const anchor =
    r.anchor && typeof r.anchor === 'object'
      ? (() => {
          const a = r.anchor as Record<string, unknown>;
          return typeof a.chain === 'string' && typeof a.ref === 'string'
            ? { chain: a.chain, ref: a.ref }
            : null;
        })()
      : null;
  const channels = Array.isArray(r.channels)
    ? (r.channels.filter((c): c is ChannelId => typeof c === 'string' && CHANNEL_IDS.has(c as ChannelId)))
    : [];
  return {
    id: r.id,
    kind: r.kind,
    ruleId: r.ruleId,
    ruleKind: r.ruleKind as AlertRuleKind,
    title: r.title,
    body: r.body,
    provenance: typeof r.provenance === 'string' ? r.provenance : '',
    at: r.at,
    read: r.read === true,
    anchor,
    channels,
    // A row written before this field existed carries a SOURCE time — every kind
    // that shipped then took its stamp from the source. Defaulting the other way
    // would relabel every historic row's "as of" as "read at".
    observedAtKind: r.observedAtKind === 'read' ? 'read' : 'source',
  };
}

export function serializeInbox(state: InboxState): string {
  return JSON.stringify({ entries: state.entries.slice(0, MAX_INBOX_ENTRIES) });
}

export function parseInbox(raw: string | null): InboxState {
  if (!raw) return emptyInbox();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyInbox();
  }
  if (!parsed || typeof parsed !== 'object') return emptyInbox();
  const list = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(list)) return emptyInbox();
  const entries: InboxEntry[] = [];
  for (const item of list) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { entries: entries.slice(0, MAX_INBOX_ENTRIES) };
}
