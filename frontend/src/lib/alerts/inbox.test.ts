// Guard for the inbox store.
//
// The inbox is where an outage gets its chance to look like calm, so the tests
// that matter are the ones about GAPS: that an unevaluatable rule produces a row
// at all, that the row is counted separately from real alerts, that a source
// which stays down for an hour produces one row rather than sixty, and that a
// tidy-up (eviction, dedup, parsing) can never quietly prefer events over gaps.

import { describe, it, expect } from 'vitest';
import {
  MAX_INBOX_ENTRIES,
  dismiss,
  emptyInbox,
  ingest,
  markAllRead,
  markRead,
  parseInbox,
  serializeInbox,
  unreadBreakdown,
  unreadCount,
  type InboxState,
} from './inbox';
import type { AlertEvent, Evaluation } from './evaluate';

const NOW = 1_760_000_000;

function event(over: Partial<AlertEvent> = {}): AlertEvent {
  return {
    idempotencyKey: 'whale-move:r1:0xabc:0',
    ruleId: 'r1',
    kind: 'whale-move',
    title: 'Whale move',
    body: '$50,000 moved.',
    provenance: 'the venue’s own Ponder indexer',
    observedAt: NOW,
    anchor: { chain: 'ethereum', ref: '0xabc' },
    ...over,
  };
}

function fired(events: AlertEvent[], ruleId = 'r1'): Evaluation {
  return { ruleId, kind: 'whale-move', verdict: 'fired', events, detail: 'fired', evaluatedAt: NOW };
}

function gap(detail: string, ruleId = 'r1', at = NOW): Evaluation {
  return { ruleId, kind: 'whale-move', verdict: 'cannot-evaluate', events: [], detail, evaluatedAt: at };
}

function quiet(ruleId = 'r1'): Evaluation {
  return { ruleId, kind: 'whale-move', verdict: 'quiet', events: [], detail: 'nothing matched', evaluatedAt: NOW };
}

const LABELS = { r1: 'Transfers of 0x4206…8F9D over $10,000' };
const CHANNELS = ['in-app' as const];

function ingestOnce(state: InboxState, evaluations: Evaluation[]): InboxState {
  return ingest(state, { evaluations, ruleLabels: LABELS, channels: CHANNELS });
}

describe('a rule that could not be evaluated leaves a mark', () => {
  it('cannot-evaluate produces a gap row', () => {
    const state = ingestOnce(emptyInbox(), [gap('The indexer is not configured on this deployment.')]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.kind).toBe('gap');
    expect(state.entries[0]!.body).toBe('The indexer is not configured on this deployment.');
  });

  it('the gap names the rule it belongs to', () => {
    const state = ingestOnce(emptyInbox(), [gap('down')]);
    expect(state.entries[0]!.title).toContain(LABELS.r1);
  });

  it('a gap carries no provenance — there was no fact for a source to have supplied', () => {
    const state = ingestOnce(emptyInbox(), [gap('down')]);
    expect(state.entries[0]!.provenance).toBe('');
  });

  it('an hour of the same outage is one row, not sixty', () => {
    let state = emptyInbox();
    for (let i = 0; i < 60; i += 1) {
      state = ingestOnce(state, [gap('The indexer is unreachable.', 'r1', NOW + i * 60)]);
    }
    expect(state.entries).toHaveLength(1);
  });

  it('a DIFFERENT problem on the same rule is a new row', () => {
    let state = ingestOnce(emptyInbox(), [gap('The indexer is unreachable.')]);
    state = ingestOnce(state, [gap('The indexer is not configured on this deployment.')]);
    expect(state.entries).toHaveLength(2);
  });

  it('gaps and events are counted apart', () => {
    let state = ingestOnce(emptyInbox(), [fired([event()])]);
    state = ingestOnce(state, [gap('down', 'r2')]);
    expect(unreadBreakdown(state)).toEqual({ events: 1, gaps: 1 });
    expect(unreadCount(state)).toBe(2);
  });
});

describe('a quiet rule writes nothing', () => {
  it('produces no row — an empty inbox IS the report for a real negative', () => {
    const state = ingestOnce(emptyInbox(), [quiet()]);
    expect(state.entries).toEqual([]);
  });
});

describe('idempotency', () => {
  it('the same fact re-read is one entry', () => {
    let state = ingestOnce(emptyInbox(), [fired([event()])]);
    state = ingestOnce(state, [fired([event()])]);
    expect(state.entries).toHaveLength(1);
  });

  it('a re-read does not flip a read entry back to unread', () => {
    let state = ingestOnce(emptyInbox(), [fired([event()])]);
    state = markRead(state, 'whale-move:r1:0xabc:0');
    state = ingestOnce(state, [fired([event()])]);
    expect(state.entries[0]!.read).toBe(true);
  });

  it('distinct facts are distinct entries', () => {
    const state = ingestOnce(emptyInbox(), [
      fired([event(), event({ idempotencyKey: 'whale-move:r1:0xdef:0', observedAt: NOW + 5 })]),
    ]);
    expect(state.entries).toHaveLength(2);
  });

  it('a pass that changes nothing returns the identical state object', () => {
    const state = ingestOnce(emptyInbox(), [fired([event()])]);
    expect(ingestOnce(state, [fired([event()])])).toBe(state);
  });
});

describe('read / dismiss', () => {
  it('markAllRead clears both kinds', () => {
    let state = ingestOnce(emptyInbox(), [fired([event()]), gap('down', 'r2')]);
    state = markAllRead(state);
    expect(unreadBreakdown(state)).toEqual({ events: 0, gaps: 0 });
  });

  it('dismiss removes exactly one entry', () => {
    let state = ingestOnce(emptyInbox(), [fired([event()]), gap('down', 'r2')]);
    state = dismiss(state, 'whale-move:r1:0xabc:0');
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.kind).toBe('gap');
  });
});

describe('eviction does not rewrite what the inbox says happened', () => {
  it('caps at MAX_INBOX_ENTRIES and keeps the newest, regardless of kind', () => {
    const evaluations: Evaluation[] = [];
    for (let i = 0; i < MAX_INBOX_ENTRIES + 25; i += 1) {
      evaluations.push(
        fired([event({ idempotencyKey: `k-${i}`, observedAt: NOW + i })], `r${i}`),
      );
    }
    const state = ingestOnce(emptyInbox(), evaluations);
    expect(state.entries).toHaveLength(MAX_INBOX_ENTRIES);
    expect(state.entries[0]!.at).toBe(NOW + MAX_INBOX_ENTRIES + 24);
  });

  it('gaps survive eviction on the same terms as events', () => {
    const evaluations: Evaluation[] = [gap('the newest fact is a gap', 'rgap', NOW + 10_000)];
    for (let i = 0; i < MAX_INBOX_ENTRIES; i += 1) {
      evaluations.push(fired([event({ idempotencyKey: `k-${i}`, observedAt: NOW + i })], `r${i}`));
    }
    const state = ingestOnce(emptyInbox(), evaluations);
    expect(state.entries.some((e) => e.kind === 'gap')).toBe(true);
  });
});

describe('persistence refuses a half-trusted blob', () => {
  it('round-trips', () => {
    const state = ingestOnce(emptyInbox(), [fired([event()]), gap('down', 'r2')]);
    expect(parseInbox(serializeInbox(state))).toEqual(state);
  });

  it('garbage parses to empty, not to a partial inbox', () => {
    expect(parseInbox('not json')).toEqual(emptyInbox());
    expect(parseInbox('{"entries":"nope"}')).toEqual(emptyInbox());
    expect(parseInbox(null)).toEqual(emptyInbox());
  });

  it('a malformed row is dropped rather than rendered as a real alert', () => {
    const raw = JSON.stringify({
      entries: [
        { id: 'ok', kind: 'event', ruleId: 'r', ruleKind: 'whale-move', title: 't', body: 'b', at: NOW },
        { id: 'bad', kind: 'event', ruleId: 'r' },
        { kind: 'gap', ruleId: 'r', ruleKind: 'whale-move', title: 't', body: 'b', at: NOW },
      ],
    });
    const parsed = parseInbox(raw);
    expect(parsed.entries.map((e) => e.id)).toEqual(['ok']);
  });

  it('an unknown channel id is not carried through', () => {
    const raw = JSON.stringify({
      entries: [
        {
          id: 'ok',
          kind: 'event',
          ruleId: 'r',
          ruleKind: 'whale-move',
          title: 't',
          body: 'b',
          at: NOW,
          channels: ['in-app', 'telegram'],
        },
      ],
    });
    expect(parseInbox(raw).entries[0]!.channels).toEqual(['in-app']);
  });
});
