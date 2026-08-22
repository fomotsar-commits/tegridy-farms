// THE UNAVAILABLE PATH IS THE RESTING STATE.
//
// The indexer is hosted nowhere, so `unavailable` is what every visitor to the
// copy-trading page sees today. These pin that the board is null in that state
// rather than an empty ranking — an empty copy-trading board is a claim that
// nobody is trading the venue.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { indexerQueryMock, isIndexerConfiguredMock } = vi.hoisted(() => ({
  indexerQueryMock: vi.fn(),
  isIndexerConfiguredMock: vi.fn(),
}));

vi.mock('../lib/indexer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/indexer/client')>();
  return { ...actual, indexerQuery: indexerQueryMock, isIndexerConfigured: isIndexerConfiguredMock };
});

import { IndexerUnavailableError } from '../lib/indexer/client';
import { useCopyLeaderboard } from './useCopyLeaderboard';

const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const W1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const W2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function row(user: string, amountIn: bigint, id: string) {
  return {
    id,
    user,
    tokenIn: QUOTE,
    tokenOut: '0x1111111111111111111111111111111111111111',
    amountIn,
    fee: 0n,
    timestamp: 1_780_000_000n,
    txHash: `0x${'ab'.repeat(32)}`,
  };
}

function answer(items: unknown[], hasNextPage = false) {
  return {
    data: { swaps: { items, pageInfo: { hasNextPage, endCursor: null } } },
    meta: { ready: true, syncedBlock: 25_300_000, syncedAt: 1_780_000_100 },
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
});

describe('useCopyLeaderboard', () => {
  it('is unavailable with no board at all when the indexer is not configured', async () => {
    isIndexerConfiguredMock.mockReturnValue(false);
    vi.unstubAllEnvs();

    const { result } = renderHook(() => useCopyLeaderboard({ quoteToken: QUOTE }));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.board).toBeNull();
    expect(result.current.detail).toMatch(/no indexer configured/i);
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });

  it('is unavailable with no board when the read fails', async () => {
    indexerQueryMock.mockRejectedValue(new IndexerUnavailableError('unreachable', 'down right now'));
    const { result } = renderHook(() => useCopyLeaderboard({ quoteToken: QUOTE }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.board).toBeNull();
  });

  it('groups and ranks a ready page', async () => {
    indexerQueryMock.mockResolvedValue(
      answer([row(W1, 10n ** 18n, 'a'), row(W2, 3n * 10n ** 18n, 'b'), row(W1, 10n ** 18n, 'c')]),
    );
    const { result } = renderHook(() => useCopyLeaderboard({ quoteToken: QUOTE }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.board!.rows.map((r) => r.leader)).toEqual([W2, W1]);
    expect(result.current.board!.rows[1]!.trades).toBe(2);
  });

  it('sends a bounded window as a decimal string', async () => {
    indexerQueryMock.mockResolvedValue(answer([]));
    const { result } = renderHook(() => useCopyLeaderboard({ quoteToken: QUOTE, windowSeconds: 3600 }));
    await waitFor(() => expect(indexerQueryMock).toHaveBeenCalled());
    const vars = indexerQueryMock.mock.calls[0]![0].variables as {
      limit: number;
      where: { timestamp_gte: string };
    };
    expect(vars.limit).toBe(100);
    expect(vars.where.timestamp_gte).toBe(String(result.current.since));
    expect(typeof vars.where.timestamp_gte).toBe('string');
  });

  it('does not re-issue the query on every render — the window is anchored once', async () => {
    // A `since` read from the clock inside render would change the variables key
    // every frame and the effect would never settle.
    indexerQueryMock.mockResolvedValue(answer([]));
    const { result, rerender } = renderHook(() => useCopyLeaderboard({ quoteToken: QUOTE }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const callsAfterFirst = indexerQueryMock.mock.calls.length;
    rerender();
    rerender();
    expect(indexerQueryMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('carries a truncated page through as a provisional order', async () => {
    indexerQueryMock.mockResolvedValue(answer([row(W1, 1n, 'a')], true));
    const { result } = renderHook(() => useCopyLeaderboard({ quoteToken: QUOTE }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.board!.truncated).toBe(true);
  });
});
