// Reconciling logged mirrors against real swaps — and refusing to conclude
// anything when the swaps could not be read.

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

import { useCopyFollowerFills } from './useCopyFollowerFills';
import type { MirrorIntent } from '../lib/copytrade/follows';

const LEADER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FOLLOWER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STRANGER = '0xcccccccccccccccccccccccccccccccccccccccc';
const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const OUT = '0x1111111111111111111111111111111111111111';

const NOW = Math.floor(Date.now() / 1000);

const intent: MirrorIntent = {
  // Hex leader, hex follower, hex quote token: an EVM mirror.
  venue: 'evm',
  leader: LEADER,
  leaderTxHash: `0x${'ab'.repeat(32)}`,
  leaderTimestamp: NOW - 400,
  confirmedAt: NOW - 300,
  follower: FOLLOWER,
  quoteToken: QUOTE,
  tokenOut: OUT,
  notionalWei: 10n ** 16n,
  // Null on purpose, not as a stand-in. This hook reconciles against the
  // indexer's router feed - the mocked source above - and an intent from that
  // feed has no pool to name; a poolKey belongs to an intent raised off the
  // island tape, which a different reconciler handles.
  poolKey: null,
};

function fill(over: Record<string, unknown> = {}) {
  return {
    id: 'f1',
    user: FOLLOWER,
    tokenIn: QUOTE,
    tokenOut: OUT,
    amountIn: 10n ** 16n,
    fee: 0n,
    timestamp: BigInt(NOW - 200),
    txHash: `0x${'cd'.repeat(32)}`,
    ...over,
  };
}

function answer(items: unknown[]) {
  return {
    data: { swaps: { items, pageInfo: { hasNextPage: false, endCursor: null } } },
    meta: { ready: true, syncedBlock: 1, syncedAt: NOW },
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

describe('useCopyFollowerFills', () => {
  it('asks nothing without a wallet — an unfiltered read would match a stranger’s trade', async () => {
    const { result } = renderHook(() => useCopyFollowerFills({ follower: null, intents: [intent] }));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(indexerQueryMock).not.toHaveBeenCalled();
    expect(result.current.outcomes).toEqual([]);
  });

  it('asks nothing when no mirror has been logged', async () => {
    const { result } = renderHook(() => useCopyFollowerFills({ follower: FOLLOWER, intents: [] }));
    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(indexerQueryMock).not.toHaveBeenCalled();
  });

  it('pins the read to the connected wallet', async () => {
    indexerQueryMock.mockResolvedValue(answer([]));
    renderHook(() => useCopyFollowerFills({ follower: FOLLOWER.toUpperCase(), intents: [intent] }));
    await waitFor(() => expect(indexerQueryMock).toHaveBeenCalled());
    const where = indexerQueryMock.mock.calls[0]![0].variables.where as { user: string };
    expect(where.user).toBe(FOLLOWER);
  });

  it('reports no outcomes at all when the read failed — unread is not unfilled', async () => {
    // ⚠ The dangerous direction here is the opposite of the rest of the slice:
    // an outage would otherwise read as "none of your mirrors worked".
    isIndexerConfiguredMock.mockReturnValue(false);
    vi.unstubAllEnvs();
    const { result } = renderHook(() => useCopyFollowerFills({ follower: FOLLOWER, intents: [intent] }));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.outcomes).toEqual([]);
    expect(result.current.byLeader).toEqual([]);
  });

  it('measures the lag from the leader’s trade once a matching swap is read', async () => {
    indexerQueryMock.mockResolvedValue(answer([fill()]));
    const { result } = renderHook(() => useCopyFollowerFills({ follower: FOLLOWER, intents: [intent] }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outcomes[0]!.state).toBe('filled');
    expect(result.current.outcomes[0]!.entryLagSeconds).toBe(200);
    expect(result.current.byLeader[0]!.medianEntryLagSeconds).toBe(200);
  });

  it('ignores intents logged by a different wallet in the same browser', async () => {
    indexerQueryMock.mockResolvedValue(answer([fill()]));
    const other = { ...intent, follower: STRANGER };
    const { result } = renderHook(() =>
      useCopyFollowerFills({ follower: FOLLOWER, intents: [intent, other] }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.outcomes).toHaveLength(1);
    expect(result.current.outcomes[0]!.intent.follower).toBe(FOLLOWER);
  });
});
