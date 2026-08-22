// The feed's zeros, pinned.
//
// A discovery feed has three ways to say "nothing here" and only one of them is
// a fact: the window was read and this pair had no events in it. The other two —
// the window ran out before reaching the pair, and no events came back at all —
// are gaps. This file exists because all three produce the same "0" if nobody
// stops them, and a 0 on a trenches feed is read as a quiet market.

import { describe, it, expect } from 'vitest';
import {
  TERMINAL_FEED_QUERY,
  assembleFeed,
  counterToken,
  terminalFeedDataSchema,
  terminalFeedVariables,
  type TerminalFeedData,
} from './feed';
import { INDEXER_META_SELECTION, MAX_PAGE_LIMIT } from '../indexer/client';

const PAIR_A = '0x1111111111111111111111111111111111111111';
const PAIR_B = '0x2222222222222222222222222222222222222222';
const TOKEN_X = '0x3333333333333333333333333333333333333333';
const WETH = '0x4444444444444444444444444444444444444444';

function data(over: {
  pairs?: TerminalFeedData['indexedPairs']['items'];
  pairsNext?: boolean;
  events?: TerminalFeedData['pairEvents']['items'];
  eventsNext?: boolean;
}): TerminalFeedData {
  return {
    indexedPairs: {
      items: over.pairs ?? [],
      pageInfo: { hasNextPage: over.pairsNext ?? false, endCursor: null },
    },
    pairEvents: {
      items: over.events ?? [],
      pageInfo: { hasNextPage: over.eventsNext ?? false, endCursor: null },
    },
  };
}

function pair(id: string) {
  return { id, token0: WETH, token1: TOKEN_X, allowed: true };
}

function event(id: string, p: string, ts: bigint) {
  return { id, type: 'swap', pair: p, timestamp: ts };
}

describe('the document can be freshness-gated at all', () => {
  it('selects _meta, without which useIndexedQuery refuses the result', () => {
    expect(TERMINAL_FEED_QUERY).toContain(INDEXER_META_SELECTION);
  });

  it('asks for both tables in ONE document so half a feed can never render', () => {
    expect(TERMINAL_FEED_QUERY).toMatch(/indexedPairs\(/);
    expect(TERMINAL_FEED_QUERY).toMatch(/pairEvents\(/);
    expect(TERMINAL_FEED_QUERY.match(/^query /m)).toBeTruthy();
  });

  it('never selects totalCount — it doubles the cost of a page nobody counts', () => {
    expect(TERMINAL_FEED_QUERY).not.toContain('totalCount');
  });

  it('sends {} for every where, never null — Ponder 500s on an explicit null', () => {
    const vars = terminalFeedVariables(10, 10);
    expect(vars.pairWhere).toEqual({});
    expect(vars.eventWhere).toEqual({});
  });

  it('clamps both page limits', () => {
    const vars = terminalFeedVariables(10_000, 10_000);
    expect(vars.pairLimit).toBe(MAX_PAGE_LIMIT);
    expect(vars.eventLimit).toBe(MAX_PAGE_LIMIT);
  });

  it('validates the response shape it declares', () => {
    expect(terminalFeedDataSchema.safeParse(data({ pairs: [pair(PAIR_A)] })).success).toBe(true);
    // A bigint arriving as a JSON number is a silently-lossy upstream change.
    expect(
      terminalFeedDataSchema.safeParse({
        indexedPairs: { items: [], pageInfo: { hasNextPage: false, endCursor: null } },
        pairEvents: {
          items: [{ id: 'e', type: 'swap', pair: PAIR_A, timestamp: 123 }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }).success,
    ).toBe(false);
  });
});

describe('a pair with no events is only "quiet" when the window actually covered it', () => {
  const parsed = (d: TerminalFeedData) => terminalFeedDataSchema.parse(JSON.parse(JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));

  it('reports a measured zero when the window was complete', () => {
    const feed = assembleFeed(
      parsed(
        data({
          pairs: [pair(PAIR_A), pair(PAIR_B)],
          events: [event('e1', PAIR_A, 100n)],
          eventsNext: false,
        }),
      ),
    );
    const b = feed.rows.find((r) => r.pair === PAIR_B)!;
    expect(b.activity.state).toBe('measured');
    expect(b.activity.state === 'measured' && b.activity.events).toBe(0);
  });

  it('reports UNKNOWN — not zero — when the window was truncated', () => {
    const feed = assembleFeed(
      parsed(
        data({
          pairs: [pair(PAIR_A), pair(PAIR_B)],
          events: [event('e1', PAIR_A, 100n)],
          eventsNext: true,
        }),
      ),
    );
    const b = feed.rows.find((r) => r.pair === PAIR_B)!;
    expect(b.activity.state).toBe('unknown');
    expect(b.activity.state === 'unknown' && b.activity.reason).toMatch(/gap, not a quiet market/i);
    expect(feed.eventWindowTruncated).toBe(true);
  });

  it('reports UNKNOWN when no events came back at all, even on a complete page', () => {
    const feed = assembleFeed(parsed(data({ pairs: [pair(PAIR_A)], events: [], eventsNext: false })));
    expect(feed.rows[0].activity.state).toBe('unknown');
    expect(feed.eventWindow).toBeNull();
  });

  it('counts and bounds a pair that WAS in the window', () => {
    const feed = assembleFeed(
      parsed(
        data({
          pairs: [pair(PAIR_A)],
          events: [event('e1', PAIR_A, 300n), event('e2', PAIR_A, 100n), event('e3', PAIR_A, 200n)],
        }),
      ),
    );
    const a = feed.rows[0];
    expect(a.activity.state === 'measured' && a.activity.events).toBe(3);
    expect(a.activity.state === 'measured' && a.activity.earliestInWindow).toBe(100n);
    expect(a.activity.state === 'measured' && a.activity.latestInWindow).toBe(300n);
  });

  it('matches pairs case-insensitively — a checksummed event must not orphan its pair', () => {
    const feed = assembleFeed(
      parsed(
        data({
          pairs: [{ id: PAIR_A, token0: WETH, token1: TOKEN_X, allowed: true }],
          events: [event('e1', PAIR_A.toUpperCase().replace('0X', '0x'), 100n)],
        }),
      ),
    );
    expect(feed.rows[0].activity.state).toBe('measured');
  });
});

describe('what the feed withholds, it counts', () => {
  it('drops allowlist-denied pairs from the rows but reports how many', () => {
    const feed = assembleFeed(
      terminalFeedDataSchema.parse(
        data({
          pairs: [pair(PAIR_A), { id: PAIR_B, token0: WETH, token1: TOKEN_X, allowed: false }],
        }),
      ),
    );
    expect(feed.rows.map((r) => r.pair)).toEqual([PAIR_A]);
    expect(feed.excludedPairs).toBe(1);
  });

  it('carries the pair page truncation forward so "N pairs" is never read as "all pairs"', () => {
    const feed = assembleFeed(
      terminalFeedDataSchema.parse(data({ pairs: [pair(PAIR_A)], pairsNext: true })),
    );
    expect(feed.hasMorePairs).toBe(true);
  });
});

describe('the buy target is never guessed', () => {
  it('picks the non-venue leg', () => {
    const row = { pair: PAIR_A, token0: WETH, token1: TOKEN_X, activity: { state: 'unknown' as const, reason: 'x' } };
    expect(counterToken(row, [WETH])).toBe(TOKEN_X);
  });

  it('returns null when NEITHER leg is a venue token — nothing to disambiguate with', () => {
    const row = { pair: PAIR_A, token0: TOKEN_X, token1: PAIR_B, activity: { state: 'unknown' as const, reason: 'x' } };
    expect(counterToken(row, [WETH])).toBeNull();
  });

  it('returns null when BOTH legs are venue tokens rather than picking one', () => {
    const row = { pair: PAIR_A, token0: WETH, token1: TOKEN_X, activity: { state: 'unknown' as const, reason: 'x' } };
    expect(counterToken(row, [WETH, TOKEN_X])).toBeNull();
  });
});
