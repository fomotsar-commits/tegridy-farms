// The adapter guard: what the hook must carry out of wagmi, intact.
//
// The pure layer is only as honest as the snapshot handed to it, and there are exactly
// three ways this adapter can corrupt one:
//
//   - flattening a reverted multicall entry to a zero instead of a null
//   - losing `dataUpdatedAt`, which leaves every leg undatable and the total unpublishable
//   - leaving the dependent staking batch "loading" forever for a wallet that owns no
//     staking NFT, which pins a healthy portfolio at PARTIAL and teaches users to ignore
//     the word
//
// Each has its own case below. The wagmi surface is stubbed locally rather than via
// test-utils/wagmi-mocks because this hook needs `useBalance` and `dataUpdatedAt`, which
// that harness does not model.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

interface ReadEntry { status: 'success' | 'failure'; result?: unknown }

const state = {
  address: '0x1111111111111111111111111111111111111111' as `0x${string}` | undefined,
  isConnected: true,
  chainId: 1,
  balance: { data: { value: 2_000_000_000_000_000_000n }, isError: false } as { data?: { value: bigint }; isError: boolean },
  /** Keyed by functionName so a case can revert one call without rebuilding the batch. */
  reads: {} as Record<string, ReadEntry>,
  baseMeta: { dataUpdatedAt: NOW_MS, isLoading: false, isError: false },
  positionMeta: { dataUpdatedAt: NOW_MS, isLoading: false, isError: false },
};

function entry(fn: string): ReadEntry {
  return state.reads[fn] ?? { status: 'failure' };
}

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: state.address, isConnected: state.isConnected }),
  useChainId: () => state.chainId,
  useBalance: () => ({ ...state.balance, refetch: vi.fn() }),
  useReadContracts: (opts: { contracts?: { functionName?: string }[]; query?: { enabled?: boolean } }) => {
    const contracts = opts.contracts ?? [];
    // The dependent batch is the one asking for getPosition.
    const isPositionBatch = contracts.some((c) => c.functionName === 'getPosition');
    const meta = isPositionBatch ? state.positionMeta : state.baseMeta;
    const enabled = opts.query?.enabled !== false;
    return {
      data: enabled ? contracts.map((c) => entry(c.functionName ?? '')) : undefined,
      dataUpdatedAt: enabled ? meta.dataUpdatedAt : 0,
      // wagmi reports a disabled query as not loading; modelling that is the whole point
      // of the "no staking NFT" case.
      isLoading: enabled ? meta.isLoading : false,
      isError: enabled ? meta.isError : false,
      refetch: vi.fn(),
    };
  },
}));

vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({
    priceInUsd: 0.002,
    ethUsd: 3000,
    isLoaded: true,
    priceUnavailable: false,
    displayPriceStale: false,
    oracleStale: false,
  }),
}));

import { usePortfolioSources } from './usePortfolioSources';
import { aggregatePortfolio } from '../lib/portfolio/aggregate';
import type { PortfolioSourceId, PortfolioSourceReport } from '../lib/portfolio/types';

/** Reserves ordered TOWELI-first, matching `token0` below. */
const RESERVES = [1_000_000_000_000_000_000_000_000n, 100_000_000_000_000_000_000n, 0] as const;

function seedHealthyReads() {
  const ok = (result: unknown): ReadEntry => ({ status: 'success', result });
  state.reads = {
    balanceOf: ok(1_000_000_000_000_000_000_000_000n),
    userTokenId: ok(7n),
    unsettledRewards: ok(0n),
    totalSupply: ok(1_000_000_000_000_000_000_000n),
    getReserves: ok(RESERVES),
    token0: ok('0x420698CFdEDdEa6bc78D59bC17798113ad278F9D'),
    rawBalanceOf: ok(0n),
    earned: ok(0n),
    pendingETH: ok(0n),
    getPosition: ok([500_000_000_000_000_000_000_000n, 15_000n, 0n, 0n, false, true]),
  };
}

function byId(sources: PortfolioSourceReport[]): Record<PortfolioSourceId, PortfolioSourceReport> {
  return Object.fromEntries(sources.map((s) => [s.id, s])) as Record<PortfolioSourceId, PortfolioSourceReport>;
}

beforeEach(() => {
  state.address = '0x1111111111111111111111111111111111111111';
  state.isConnected = true;
  state.chainId = 1;
  state.balance = { data: { value: 2_000_000_000_000_000_000n }, isError: false };
  state.baseMeta = { dataUpdatedAt: NOW_MS, isLoading: false, isError: false };
  state.positionMeta = { dataUpdatedAt: NOW_MS, isLoading: false, isError: false };
  seedHealthyReads();
});

describe('the adapter carries read status through as null, not zero', () => {
  it('reports the healthy legs it actually read', () => {
    const { result } = renderHook(() => usePortfolioSources());
    const s = byId(result.current.sources);
    expect(s['wallet-eth'].state).toBe('ok');
    expect(s['wallet-eth'].usd).toBe(6000);
    expect(s['wallet-toweli'].usd).toBeCloseTo(2000, 6);
    expect(s.staking.state).toBe('ok');
  });

  it('turns a reverted entry into unavailable, never into a zero balance', () => {
    state.reads.balanceOf = { status: 'failure' };
    const s = byId(renderHook(() => usePortfolioSources()).result.current.sources);
    expect(s['wallet-toweli'].state).toBe('unavailable');
    expect(s['wallet-toweli'].usd).toBeNull();
  });

  it('turns a failed native-balance query into unavailable, never into 0 ETH', () => {
    state.balance = { data: undefined, isError: true };
    const s = byId(renderHook(() => usePortfolioSources()).result.current.sources);
    expect(s['wallet-eth'].state).toBe('unavailable');
    expect(s['wallet-eth'].usd).toBeNull();
  });

  it('fails the whole LP leg when the reserves read reverts', () => {
    state.reads.getReserves = { status: 'failure' };
    const s = byId(renderHook(() => usePortfolioSources()).result.current.sources);
    expect(s.lp.state).toBe('unavailable');
  });
});

describe('read times survive the trip out of wagmi', () => {
  it('converts dataUpdatedAt to the seconds stamp each leg is dated by', () => {
    const s = byId(renderHook(() => usePortfolioSources()).result.current.sources);
    expect(s['wallet-eth'].asOf).toBe(NOW_S);
  });

  it('treats dataUpdatedAt of 0 as "never read" rather than as the unix epoch', () => {
    // A 0 passed through would date every leg to 1970 and read as catastrophically stale.
    state.baseMeta = { dataUpdatedAt: 0, isLoading: true, isError: false };
    const total = aggregatePortfolio(renderHook(() => usePortfolioSources()).result.current.sources);
    expect(total.asOfOldest).toBeNull();
    expect(total.usd).toBeNull();
  });

  it('keeps the two batches separately dated so the spread stays visible', () => {
    state.positionMeta = { dataUpdatedAt: NOW_MS - 120_000, isLoading: false, isError: false };
    const sources = renderHook(() => usePortfolioSources()).result.current.sources;
    expect(byId(sources).staking.asOf).toBe(NOW_S - 120);
    expect(aggregatePortfolio(sources).mixedFreshness).toBe(true);
  });
});

describe('the dependent batch cannot stall a wallet that has no staking position', () => {
  it('does not hold the portfolio at PARTIAL when there is no staking NFT to read', () => {
    state.reads.userTokenId = { status: 'success', result: 0n };
    const { result } = renderHook(() => usePortfolioSources());
    const s = byId(result.current.sources);
    expect(s.staking.state).toBe('ok');
    expect(s.staking.usd).toBe(0);
    expect(aggregatePortfolio(result.current.sources).omitted.map((o) => o.id)).not.toContain('staking');
  });
});

describe('the adapter refuses to report on a wallet it is not reading', () => {
  it('publishes no total when disconnected', () => {
    state.address = undefined;
    state.isConnected = false;
    const total = aggregatePortfolio(renderHook(() => usePortfolioSources()).result.current.sources);
    expect(total.usd).toBeNull();
    expect(total.completeness).toBe('unavailable');
  });

  it('publishes no total on the wrong network', () => {
    state.chainId = 8453;
    const total = aggregatePortfolio(renderHook(() => usePortfolioSources()).result.current.sources);
    expect(total.usd).toBeNull();
  });
});
