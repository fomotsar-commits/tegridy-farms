// Owner, 2026-11-01: the dashboard "sometimes has troubles showing the positions and tokens in
// wallet ... so it never does that". A Solana part that fails is asked again on its own before it
// says so, and a part that still could not be read is read again until it is.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const sol = vi.hoisted(() => ({ holdings: vi.fn() }));
const ok = { status: 'ok', rows: [] } as const;

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useBalance: () => ({ isLoading: false, isError: false, data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ isLoading: false, data: undefined, refetch: vi.fn() }),
}));
vi.mock('./useUserPosition', () => ({ useUserPosition: () => ({ isDeployed: false, refetchAll: vi.fn() }) }));
vi.mock('./useMarketFeed', () => ({ useMarketFeed: () => ({ state: { status: 'loading' }, reload: vi.fn() }) }));
vi.mock('../contexts/PriceContext', () => ({ useTOWELIPriceOptional: () => null }));
vi.mock('../lib/solanaSurface', () => ({ useSolanaSurface: () => ({ surface: { address: OWNER } }) }));
vi.mock('../lib/wallet/readSolanaWallet', () => ({
  readSolanaHoldings: sol.holdings,
  readSolanaOtherCoins: async () => ok,
  readSolanaLadder: async () => ok,
  readSolanaPoolShares: async () => ok,
  readSolanaStakes: async () => ok,
}));

import { HEAL_MS, useWalletBoard } from './useWalletBoard';

const holdings = (r: { current: ReturnType<typeof useWalletBoard> }) => r.current.holdings.find((l) => l.key === 'sol-holdings')!.leg;
const fail = { status: 'unread', detail: 'the RPC proxy did not answer' } as const;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  sol.holdings.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useWalletBoard: a Solana part heals itself', () => {
  it('asks again after a failure, and never shows the failure when the next read answers', async () => {
    sol.holdings.mockResolvedValueOnce(fail).mockResolvedValue(ok);
    const { result } = renderHook(() => useWalletBoard());
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(holdings(result).status).toBe('loading');
    await act(() => vi.advanceTimersByTimeAsync(1_600));
    expect(holdings(result)).toEqual(ok);
    expect(sol.holdings).toHaveBeenCalledTimes(2);
  });

  it('says it could not be read only after three tries, then reads it again on its own', async () => {
    sol.holdings.mockResolvedValue(fail);
    const { result } = renderHook(() => useWalletBoard());
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(holdings(result).status).toBe('unread');
    expect(sol.holdings).toHaveBeenCalledTimes(3);
    sol.holdings.mockResolvedValue(ok);
    await act(() => vi.advanceTimersByTimeAsync(HEAL_MS + 10));
    expect(holdings(result)).toEqual(ok);
  });

  it('reads a failed part again the moment the device is back online', async () => {
    sol.holdings.mockResolvedValue(fail);
    const { result } = renderHook(() => useWalletBoard());
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(holdings(result).status).toBe('unread');
    sol.holdings.mockResolvedValue(ok);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(holdings(result)).toEqual(ok);
  });
});
