// THE UNAVAILABLE PATH IS THE POINT.
//
// No yield feed is configured on this deployment, so `unavailable` is not an edge
// case here — it is the state every consumer is in right now, and the state each
// one falls back to on every outage after that. These tests pin that the hook
// never lets an outage arrive as a table of zeroes.
//
// The second, less obvious rule is the opposite of the indexer hooks' discipline
// and is asserted for it: `rows` stays FULL in every state. The catalogue — who
// the counterparty is, what the loss mode is — is local knowledge that does not
// depend on the feed, and emptying the table during an outage would delete the
// honest half of the page to protect the unread half.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { fetchYieldFeedMock, isYieldFeedConfiguredMock } = vi.hoisted(() => ({
  fetchYieldFeedMock: vi.fn(),
  isYieldFeedConfiguredMock: vi.fn(),
}));

vi.mock('../lib/yield/feed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/yield/feed')>();
  return {
    ...actual,
    fetchYieldFeed: fetchYieldFeedMock,
    isYieldFeedConfigured: isYieldFeedConfiguredMock,
  };
});

import { YieldFeedUnavailableError } from '../lib/yield/feed';
import { marketsForKind, useYieldMarkets } from './useYieldMarkets';
import { yieldVenues } from '../lib/yield/venues';

function document(readings: Record<string, unknown>) {
  return { asOf: Math.floor(Date.now() / 1000), readings };
}

beforeEach(() => {
  fetchYieldFeedMock.mockReset();
  isYieldFeedConfiguredMock.mockReset();
  isYieldFeedConfiguredMock.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an unconfigured deployment asks nothing and claims nothing', () => {
  it('reports unavailable without emitting a request', async () => {
    isYieldFeedConfiguredMock.mockReturnValue(false);
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(fetchYieldFeedMock, 'a request went out with no feed configured').not.toHaveBeenCalled();
    expect(result.current.detail).toMatch(/no yield feed|not a valid http/i);
    expect(result.current.asOf).toBeNull();
  });

  it('still hands back every venue, each with unavailable metrics', async () => {
    isYieldFeedConfiguredMock.mockReturnValue(false);
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));

    expect(result.current.rows).toHaveLength(yieldVenues().length);
    for (const row of result.current.rows) {
      expect(row.apy.state, `${row.venue.id} APY`).toBe('unavailable');
      expect(row.peg.state, `${row.venue.id} peg`).toBe('unavailable');
      expect(row.exitLiquidity.state, `${row.venue.id} exit liquidity`).toBe('unavailable');
    }
  });
});

describe('an outage is an outage, never a rate', () => {
  it('carries the client’s own wording when the fetch throws', async () => {
    fetchYieldFeedMock.mockRejectedValue(
      new YieldFeedUnavailableError('unreachable', 'The yield feed is not answering right now.'),
    );
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.detail).toMatch(/not answering/i);
    expect(result.current.rows.every((r) => r.apy.state === 'unavailable')).toBe(true);
  });

  it('does not leave an unknown throw looking like an answer', async () => {
    fetchYieldFeedMock.mockRejectedValue(new Error('something else entirely'));
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.detail).toMatch(/could not be read/i);
  });
});

describe('a partial answer stays partial', () => {
  it('reads the venues the feed carried and leaves the rest unavailable', async () => {
    fetchYieldFeedMock.mockResolvedValue(
      document({
        'lido-steth': {
          apyPct: { value: 3.1, source: 'stats API' },
          pegRatio: { value: 0.999, source: 'pool mid' },
          exitLiquidityUsd: null,
        },
      }),
    );
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const lido = result.current.rows.find((r) => r.venue.id === 'lido-steth')!;
    expect(lido.apy.state).toBe('read');
    // A metric the feed explicitly could not read stays unavailable even on a
    // successful fetch — the row is partially read, not fully read.
    expect(lido.exitLiquidity.state).toBe('unavailable');

    const missing = result.current.rows.find((r) => r.venue.id === 'renzo-ezeth')!;
    expect(missing.apy.state).toBe('unavailable');
    expect(result.current.detail).toBeNull();
  });
});

describe('the two panels rank through one code path', () => {
  it('scopes rows to the requested kinds and ranks only those', async () => {
    isYieldFeedConfiguredMock.mockReturnValue(false);
    const { result } = renderHook(() => useYieldMarkets());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));

    const staking = marketsForKind(result.current.rows, ['lst', 'lrt']);
    const stables = marketsForKind(result.current.rows, 'stable-lending');
    expect(staking.rows.every((r) => r.venue.kind !== 'stable-lending')).toBe(true);
    expect(stables.rows.every((r) => r.venue.kind === 'stable-lending')).toBe(true);

    // Nothing was read, so nothing ranks — and every scoped row is accounted for
    // in `unranked` rather than dropped out of the comparison.
    for (const slice of [staking, stables]) {
      expect(slice.ranking.best).toBeNull();
      expect(slice.ranking.complete).toBe(false);
      expect(slice.ranking.unranked).toHaveLength(slice.rows.length);
    }
  });
});
