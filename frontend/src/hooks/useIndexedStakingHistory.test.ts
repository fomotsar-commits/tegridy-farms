// Staking history has two facts that are easy to lose on the way to a screen,
// and losing either one changes what a position appears to have cost:
//
//   `penalty` is set ONLY on earlyWithdraw rows. It is the slashing penalty
//   actually charged, and it must survive the hook intact.
//   `transfer` rows carry amount 0 and record the position NFT changing hands.
//
// Plus the rail every useIndexed* hook shares: no configured indexer, an
// unreachable one, and one still backfilling are three distinct states, none of
// which may render as "this wallet has no staking history".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Hoisted because the mock factory runs during this file's own (hoisted) import
// of the mocked module.
const { indexerQueryMock, isIndexerConfiguredMock } = vi.hoisted(() => ({
  indexerQueryMock: vi.fn(),
  isIndexerConfiguredMock: vi.fn(),
}));

vi.mock('../lib/indexer/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/indexer/client')>();
  return {
    ...actual,
    indexerQuery: indexerQueryMock,
    isIndexerConfigured: isIndexerConfiguredMock,
  };
});

import { IndexerUnavailableError } from '../lib/indexer/client';
import { useIndexedStakingHistory } from './useIndexedStakingHistory';

const WALLET = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';

const EARLY_WITHDRAW = {
  id: '0xbeef-0',
  user: WALLET.toLowerCase(),
  tokenId: 7n,
  type: 'earlyWithdraw',
  amount: 5n * 10n ** 18n,
  penalty: 10n ** 18n,
  timestamp: 1_780_000_000n,
  txHash: `0x${'cd'.repeat(32)}`,
};

const TRANSFER = {
  ...EARLY_WITHDRAW,
  id: '0xbeef-1',
  type: 'transfer',
  amount: 0n,
  penalty: null,
};

function answer(items: unknown[], meta: unknown) {
  return {
    data: { stakingActions: { items, pageInfo: { hasNextPage: false, endCursor: null } } },
    meta,
  };
}

const READY = { ready: true, syncedBlock: 25_300_000, syncedAt: 1_780_000_100 };

beforeEach(() => {
  indexerQueryMock.mockReset();
  isIndexerConfiguredMock.mockReset();
  isIndexerConfiguredMock.mockReturnValue(true);
  vi.stubEnv('VITE_INDEXER_URL', 'https://indexer.example');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useIndexedStakingHistory', () => {
  it('is unavailable, and silent, with no indexer configured', async () => {
    isIndexerConfiguredMock.mockReturnValue(false);
    vi.unstubAllEnvs();

    const { result } = renderHook(() => useIndexedStakingHistory({ user: WALLET }));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.items).toEqual([]);
    expect(result.current.detail).toMatch(/no indexer configured/i);
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });

  it('preserves the slashing penalty and the zero-amount transfer row', async () => {
    indexerQueryMock.mockResolvedValue(answer([EARLY_WITHDRAW, TRANSFER], READY));

    const { result } = renderHook(() => useIndexedStakingHistory({ user: WALLET }));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.items[0]!.penalty).toBe(10n ** 18n);
    // Null rather than 0n: "no penalty was charged" and "this action cannot
    // carry a penalty" are different, and 0n would read as the first.
    expect(result.current.items[1]!.penalty).toBeNull();
    expect(result.current.items[1]!.amount).toBe(0n);
  });

  it('filters by wallet and position, sending the uint256 as a string', async () => {
    indexerQueryMock.mockResolvedValue(answer([], READY));
    renderHook(() => useIndexedStakingHistory({ user: WALLET, tokenId: 7n, limit: 500 }));

    await waitFor(() => expect(indexerQueryMock).toHaveBeenCalled());
    expect(indexerQueryMock.mock.calls[0]![0].variables).toEqual({
      // 500 clamped to MAX_PAGE_LIMIT — no surface here asks for an unbounded
      // page, and an oversized one fails as a too-large response, not cleanly.
      limit: 100,
      where: { user: WALLET.toLowerCase(), tokenId: '7' },
    });
  });

  it('reports a backfilling indexer as incomplete rather than empty', async () => {
    indexerQueryMock.mockResolvedValue(answer([], { ready: false, syncedBlock: 25_000_000, syncedAt: 1_770_000_000 }));
    const { result } = renderHook(() => useIndexedStakingHistory({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('backfilling'));
    expect(result.current.detail).toMatch(/incomplete/i);
  });

  it('surfaces an outage as an outage', async () => {
    indexerQueryMock.mockRejectedValue(
      new IndexerUnavailableError('unreachable', 'The indexer is not answering right now.'),
    );
    const { result } = renderHook(() => useIndexedStakingHistory({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.items).toEqual([]);
    expect(result.current.detail).toMatch(/not answering/i);
  });

  it('re-queries when reload is called', async () => {
    indexerQueryMock.mockResolvedValue(answer([EARLY_WITHDRAW], READY));
    const { result } = renderHook(() => useIndexedStakingHistory({ user: WALLET }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    result.current.reload();
    await waitFor(() => expect(indexerQueryMock).toHaveBeenCalledTimes(2));
  });
});
