// The signal feed: it asks nothing when nothing is followed, and it re-judges
// staleness on a clock instead of on the mount time.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const { indexerQueryMock, isIndexerConfiguredMock } = vi.hoisted(() => ({
  indexerQueryMock: vi.fn(),
  isIndexerConfiguredMock: vi.fn(),
}));

vi.mock('../lib/indexer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/indexer/client')>();
  return { ...actual, indexerQuery: indexerQueryMock, isIndexerConfigured: isIndexerConfiguredMock };
});

import { useCopySignals, SIGNAL_CLOCK_INTERVAL_MS } from './useCopySignals';
import { MAX_SIGNAL_AGE_SECONDS } from '../lib/copytrade/mirror';
import type { FollowConfig } from '../lib/copytrade/follows';

const LEADER = '0xabcdef0123456789abcdef0123456789abcdef01';
const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const OUT = '0x1111111111111111111111111111111111111111';

const follow: FollowConfig = {
  // A follow is qualified by chain family now, because the same 0x address is a
  // different pool on Ethereum than on Base. Every address in this file is hex,
  // so 'evm' is the venue these fixtures always implied - now written down.
  venue: 'evm',
  leader: LEADER,
  quoteToken: QUOTE,
  maxNotionalWei: 10n ** 18n,
  slippageBps: 100,
  createdAt: 0,
};

function answer(items: unknown[]) {
  return {
    data: { swaps: { items, pageInfo: { hasNextPage: false, endCursor: null } } },
    meta: { ready: true, syncedBlock: 1, syncedAt: 1 },
  };
}

beforeEach(() => {
  indexerQueryMock.mockReset();
  isIndexerConfiguredMock.mockReset();
  isIndexerConfiguredMock.mockReturnValue(true);
  vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('useCopySignals', () => {
  it('asks nothing at all when nothing is followed', async () => {
    // An unfiltered read would be the whole venue's swap feed rendered under the
    // heading "wallets you follow".
    const { result } = renderHook(() => useCopySignals({ follows: [] }));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.candidates).toEqual([]);
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });

  it('names the followed wallets in the filter', async () => {
    indexerQueryMock.mockResolvedValue(answer([]));
    renderHook(() => useCopySignals({ follows: [follow] }));
    await waitFor(() => expect(indexerQueryMock).toHaveBeenCalled());
    const where = indexerQueryMock.mock.calls[0]![0].variables.where as { user_in: string[] };
    expect(where.user_in).toEqual([LEADER]);
  });

  it('carries the indexer’s own unavailable reason and produces no candidates', async () => {
    isIndexerConfiguredMock.mockReturnValue(false);
    vi.unstubAllEnvs();
    const { result } = renderHook(() => useCopySignals({ follows: [follow] }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.candidates).toEqual([]);
    expect(result.current.detail).toMatch(/no indexer configured/i);
  });

  it('re-judges a signal as stale when the clock moves, without re-reading', async () => {
    // ⚠ THE ONE THAT MATTERS. With `now` frozen at mount, a tab left open would
    // keep an hours-old trade labelled "a minute ago" and offer a size for it.
    vi.useFakeTimers();
    const mountedAt = 1_780_000_000_000;
    vi.setSystemTime(mountedAt);

    const fresh = {
      id: 'a',
      user: LEADER,
      tokenIn: QUOTE,
      tokenOut: OUT,
      amountIn: 10n ** 16n,
      fee: 0n,
      timestamp: BigInt(Math.floor(mountedAt / 1000) - 60),
      txHash: `0x${'ab'.repeat(32)}`,
    };
    indexerQueryMock.mockResolvedValue(answer([fresh]));

    const { result } = renderHook(() => useCopySignals({ follows: [follow] }));
    await vi.waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.candidates[0]!.outcome.ok).toBe(true);

    const callsBefore = indexerQueryMock.mock.calls.length;
    await act(async () => {
      vi.setSystemTime(mountedAt + (MAX_SIGNAL_AGE_SECONDS + 120) * 1000);
      await vi.advanceTimersByTimeAsync(SIGNAL_CLOCK_INTERVAL_MS + 10);
    });

    const outcome = result.current.candidates[0]!.outcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('stale-signal');
    // The window the rows were read over is anchored; only the judgement moved.
    expect(indexerQueryMock.mock.calls.length).toBe(callsBefore);
  });
});
