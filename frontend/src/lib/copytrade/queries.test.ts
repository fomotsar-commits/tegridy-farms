// The `where` shapes, pinned against the document they are sent with.

import { describe, it, expect } from 'vitest';
import { MAX_LEADERS_PER_QUERY, followerFillsWhere, leaderSignalsWhere, leaderboardWhere } from './queries';
import { INDEXED_SWAPS_QUERY, indexedSwapsDataSchema } from '../indexer/queries';
import { INDEXER_META_SELECTION } from '../indexer/client';

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('the shared document', () => {
  it('is reused rather than re-declared, and still asks for its sync position', () => {
    // Every honesty gate downstream depends on `_meta` travelling with the rows;
    // useIndexedQuery refuses a document without it. Reusing the pinned document
    // is what keeps that true for these three reads without re-arguing it.
    expect(INDEXED_SWAPS_QUERY).toContain(INDEXER_META_SELECTION);
    expect(INDEXED_SWAPS_QUERY).toContain('$where: swapFilter!');
  });

  it('parses the page shape these hooks select from', () => {
    const parsed = indexedSwapsDataSchema.safeParse({
      swaps: { items: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('timestamps travel as decimal strings', () => {
  it('never sends a JSON number for a uint256 column', () => {
    // Ponder coerces the bound variable with BigInt(value); a JSON number would
    // be accepted and would lose precision without complaint.
    expect(leaderboardWhere(1_780_000_000)).toEqual({ timestamp_gte: '1780000000' });
    expect(typeof (leaderboardWhere(1) as { timestamp_gte: unknown }).timestamp_gte).toBe('string');
  });

  it('floors a fractional or negative clock to zero rather than emitting garbage', () => {
    expect(leaderboardWhere(-5)).toEqual({ timestamp_gte: '0' });
    expect(leaderboardWhere(10.9)).toEqual({ timestamp_gte: '10' });
    expect(leaderboardWhere(Number.NaN)).toEqual({ timestamp_gte: '0' });
  });
});

describe('leaderSignalsWhere', () => {
  it('is null with no leaders, so the hook can ask nothing at all', () => {
    // The alternative — an empty `user_in` — would either error inside the
    // server or come back as the whole venue's feed presented as "wallets you
    // follow".
    expect(leaderSignalsWhere([], 0)).toBeNull();
  });

  it('lowercases and de-duplicates the leader list', () => {
    const where = leaderSignalsWhere([A, A.toLowerCase(), B], 100) as { user_in: string[] };
    expect(where.user_in).toEqual([A.toLowerCase(), B]);
  });

  it('caps how many leaders one clause may name', () => {
    const many = Array.from({ length: MAX_LEADERS_PER_QUERY + 5 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    const where = leaderSignalsWhere(many, 0) as { user_in: string[] };
    expect(where.user_in).toHaveLength(MAX_LEADERS_PER_QUERY);
  });
});

describe('followerFillsWhere', () => {
  it('pins the read to one wallet', () => {
    expect(followerFillsWhere(A, 5)).toEqual({ user: A.toLowerCase(), timestamp_gte: '5' });
  });
});
