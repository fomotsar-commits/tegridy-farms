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
  ingestWithDelta,
  markAllRead,
  markDelivered,
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

function ingestOnce(state: InboxState, evaluations: Evaluation[]): InboxState {
  return ingest(state, { evaluations, ruleLabels: LABELS });
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

describe('delivery is recorded after it happens, never when it is planned', () => {
  it('an entry is born carrying in-app and nothing else', () => {
    // Ingesting IS the in-app delivery, which is what makes it safe to stamp
    // here. Every other channel is a SEND that can fail, and stamping the plan
    // would label a row "shown as a browser notification" whose show threw.
    const state = ingestOnce(emptyInbox(), [fired([event()])]);
    expect(state.entries[0]!.channels).toEqual(['in-app']);
  });

  it('markDelivered adds a channel exactly once, and ignores an unknown id', () => {
    const state = ingestOnce(emptyInbox(), [fired([event()])]);
    const id = state.entries[0]!.id;
    const once = markDelivered(state, id, 'web-notification');
    expect(once.entries[0]!.channels).toEqual(['in-app', 'web-notification']);
    expect(markDelivered(once, id, 'web-notification')).toBe(once);
    // An entry evicted between the show and the stamp simply has nothing to
    // mark; that is not an error worth throwing inside a notification loop.
    expect(markDelivered(once, 'no-such-id', 'web-notification')).toBe(once);
  });

  it('ingestWithDelta returns the new EVENT rows, and never a gap', () => {
    const first = ingestWithDelta(emptyInbox(), {
      evaluations: [fired([event()]), gap('the indexer is down')],
      ruleLabels: LABELS,
    });
    // Gaps are excluded on purpose: a notification per "could not evaluate" is
    // how one outage becomes an hour of buzzing.
    expect(first.added.map((e) => e.kind)).toEqual(['event']);
    expect(first.state.entries).toHaveLength(2);

    // Re-folding the same pass announces nothing — the guard that stops a 60s
    // loop re-notifying the same fact forever.
    const second = ingestWithDelta(first.state, {
      evaluations: [fired([event()]), gap('the indexer is down')],
      ruleLabels: LABELS,
    });
    expect(second.added).toEqual([]);
    expect(second.state).toBe(first.state);
  });
});

describe('a stored row survives the round trip with what it claims', () => {
  it('keeps a web-notification stamp and a read-clock time', () => {
    const state = markDelivered(
      ingestOnce(emptyInbox(), [fired([event({ observedAtKind: 'read' })])]),
      'whale-move:r1:0xabc:0',
      'web-notification',
    );
    const parsed = parseInbox(serializeInbox(state));
    expect(parsed.entries[0]!.channels).toEqual(['in-app', 'web-notification']);
    expect(parsed.entries[0]!.observedAtKind).toBe('read');
  });

  it('a row written before observedAtKind existed reads back as a SOURCE time', () => {
    // Defaulting the other way would relabel every historic row's "as of" as
    // "read at", which is a claim about provenance nobody made.
    const raw = JSON.stringify({
      entries: [
        { id: 'old', kind: 'event', ruleId: 'r', ruleKind: 'whale-move', title: 't', body: 'b', at: NOW },
      ],
    });
    expect(parseInbox(raw).entries[0]!.observedAtKind).toBe('source');
  });
});
