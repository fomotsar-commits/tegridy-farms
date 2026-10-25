// The dashboard's Ethereum and Base reads (owner, 2026-10-22). A read that failed is a part that
// could not be read, never a zero and never "no positions": useUserPosition reads 0 on a failure
// and flags it, wagmi marks a failed multicall entry, and both must reach the board as unread.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { BUNGALOWS } from '../lib/bungalows';
import { evmLadderRooms, islandCoinsOn } from '../lib/wallet/walletRows';

const USER = '0x1111111111111111111111111111111111111111' as const;
type Entry = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
type Contract = { address: string; functionName: string; args?: readonly unknown[]; chainId: number };

const chain = vi.hoisted(() => ({
  native: {} as Record<number, bigint | 'fail'>,
  read: (_c: Contract): Entry => ({ status: 'failure', error: new Error('unset') }),
  toweli: {} as Record<string, unknown>,
  prices: [] as { token: string; priceUsd: number | null; withheld: boolean }[],
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: USER }),
  useBalance: ({ chainId }: { chainId: number }) => {
    const v = chain.native[chainId];
    return v === 'fail'
      ? { isLoading: false, isError: true, data: undefined, refetch: vi.fn() }
      : { isLoading: false, isError: false, data: { value: v ?? 0n }, refetch: vi.fn() };
  },
  useReadContracts: ({ contracts, query }: { contracts: Contract[]; query?: { enabled?: boolean } }) => ({
    isLoading: false,
    data: query?.enabled === false ? undefined : contracts.map((c) => chain.read(c)),
    refetch: vi.fn(),
  }),
}));
vi.mock('./useUserPosition', () => ({ useUserPosition: () => chain.toweli }));
vi.mock('./useMarketFeed', () => ({ useMarketFeed: () => ({ state: { status: 'ready', rows: chain.prices, dropped: 0, fetchedAt: 0 }, reload: vi.fn() }) }));
vi.mock('../contexts/PriceContext', () => ({ useTOWELIPriceOptional: () => ({ ethUsdForDisplay: 2000 }) }));
vi.mock('../lib/solanaSurface', () => ({ useSolanaSurface: () => ({ surface: null }) }));

import { useWalletBoard } from './useWalletBoard';

const ok = (result: unknown): Entry => ({ status: 'success', result });
const fail: Entry = { status: 'failure', error: new Error('execution reverted') };
const legOf = (legs: { key: string; leg: unknown }[], key: string) => legs.find((l) => l.key === key)!.leg as { status: string; rows?: { title?: string; symbol?: string; amount?: string; usd?: number | null; facts?: string[] }[] };

const pepe = BUNGALOWS.find((b) => b.id === 'pepe')!;
const qr = BUNGALOWS.find((b) => b.id === 'qr')!;
const LOCK_END = BigInt(Math.floor(Date.UTC(2031, 5, 1, 12) / 1000));

beforeEach(() => {
  chain.native = { 1: 10n ** 18n, 8453: 0n };
  chain.prices = [{ token: pepe.address!.toLowerCase(), priceUsd: 0.00001, withheld: false }];
  chain.toweli = { isDeployed: true, isLoading: false, positionUnread: false, hasPosition: false, stakedAmount: 0n, refetchAll: vi.fn() };
  chain.read = (c) => {
    if (c.functionName === 'decimals') return ok(18);
    if (c.functionName === 'balanceOf') return ok(c.address.toLowerCase() === pepe.address!.toLowerCase() ? 5_000_000n * 10n ** 18n : 0n);
    if (c.functionName === 'earned') return ok(0n);
    if (c.functionName === 'positionsOf') return ok([]);
    return fail;
  };
});

describe('useWalletBoard on Ethereum and Base', () => {
  it('lists ETH and the island coins the wallet holds, priced where a price was read', () => {
    const { result } = renderHook(() => useWalletBoard());
    const eth = legOf(result.current.holdings, 'eth-holdings');
    expect(eth.status).toBe('ok');
    expect(eth.rows!.map((r) => [r.symbol, r.amount])).toEqual([['ETH', '1'], ['PEPE', '5,000,000']]);
    expect(eth.rows![0]!.usd).toBe(2000);
    expect(eth.rows![1]!.usd).toBeCloseTo(50, 6);
    // Base was read, and holds nothing: a read empty list.
    expect(legOf(result.current.holdings, 'base-holdings')).toEqual({ status: 'ok', rows: [] });
    expect(islandCoinsOn('base').length, 'precondition: Base has island coins to read').toBeGreaterThan(0);
  });

  it('is not read when a coin’s balance fails, never a list without that coin', () => {
    const base = chain.read;
    chain.read = (c) => (c.functionName === 'balanceOf' && c.chainId === 8453 ? fail : base(c));
    const { result } = renderHook(() => useWalletBoard());
    expect(legOf(result.current.holdings, 'base-holdings').status).toBe('unread');
    expect(legOf(result.current.holdings, 'eth-holdings').status).toBe('ok');
  });

  it('is not read when a chain’s ETH balance fails', () => {
    chain.native = { 1: 'fail', 8453: 0n };
    const { result } = renderHook(() => useWalletBoard());
    expect(legOf(result.current.holdings, 'eth-holdings').status).toBe('unread');
  });

  it('reads the TOWELI stake as not read when the staking contract did not answer, though its amounts read 0', () => {
    chain.toweli = { isDeployed: true, isLoading: false, positionUnread: true, hasPosition: false, stakedAmount: 0n, refetchAll: vi.fn() };
    const { result } = renderHook(() => useWalletBoard());
    expect(legOf(result.current.positions, 'toweli-stake').status).toBe('unread');
  });

  it('lists the TOWELI stake: amount, unlock, multiplier and earned', () => {
    chain.toweli = {
      isDeployed: true, isLoading: false, positionUnread: false, accrualInputsUnread: false, hasPosition: true,
      stakedAmount: 50_000n * 10n ** 18n, lockEnd: Number(LOCK_END), boostBps: 25_000, pendingReward: 12n * 10n ** 18n, refetchAll: vi.fn(),
    };
    const { result } = renderHook(() => useWalletBoard());
    const leg = legOf(result.current.positions, 'toweli-stake');
    expect(leg.rows!.map((r) => [r.title, ...r.facts!])).toEqual([['TOWELI stake', '50,000 TOWELI', 'unlocks 1 Jun 2031', '2.50×', 'earned 12 TOWELI']]);
  });

  it('lists each Ethereum and Base lock from its own pool, with that pool’s earned on its first lock', () => {
    const base = chain.read;
    chain.read = (c) => {
      if (c.address === qr.stakePool && c.functionName === 'positionsOf') return ok([7n, 8n]);
      if (c.address === qr.stakePool && c.functionName === 'earned') return ok(3n * 10n ** 18n);
      if (c.address === qr.stakePool && c.functionName === 'positions') {
        const amount = c.args![0] === 7n ? 1000n * 10n ** 18n : 500n * 10n ** 18n;
        return ok([USER, LOCK_END, amount, amount * 4n]);
      }
      return base(c);
    };
    const { result } = renderHook(() => useWalletBoard());
    const leg = legOf(result.current.positions, 'evm-ladders');
    expect(evmLadderRooms().some((b) => b.id === 'qr'), 'precondition: QR runs a lock ladder').toBe(true);
    expect(leg.rows!.map((r) => [r.title, ...r.facts!])).toEqual([
      ['QR lock', '1,000 QR', 'unlocks 1 Jun 2031', '4.00×', 'earned 3 QR across these locks'],
      ['QR lock', '500 QR', 'unlocks 1 Jun 2031', '4.00×'],
    ]);
  });

  it('is not read when a pool’s list of locks fails, never "no locks"', () => {
    const base = chain.read;
    chain.read = (c) => (c.address === pepe.stakePool && c.functionName === 'positionsOf' ? fail : base(c));
    const { result } = renderHook(() => useWalletBoard());
    expect(legOf(result.current.positions, 'evm-ladders').status).toBe('unread');
  });
});
