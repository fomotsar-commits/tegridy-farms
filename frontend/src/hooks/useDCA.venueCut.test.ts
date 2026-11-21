// A scheduled DCA buy uses our pool only where the venue's cut is on (kLast non-zero). The old
// Ethereum factory still opens pools for free with the cut off (leak audit 2026-11-15, EVM-3).
// ETH in: such a pool loses to Uniswap. A token in (approved to SwapFeeRouter, our pool only):
// the swap is skipped, and the toast says why.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER } from '../lib/constants';

const { toast, writeContract, client, cut } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  writeContract: vi.fn(),
  client: { readContract: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransactionReceipt: vi.fn() },
  cut: { kLast: 7n as bigint | 'unread' },
}));

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const PAIR = '0x00000000000000000000000000000000000000a1' as const;
const ETH = { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true };
const TOWELI = { symbol: 'TOWELI', address: `0x${'2'.repeat(40)}`, decimals: 18 };

vi.mock('sonner', () => ({ toast }));
vi.mock('../lib/alerts/webNotification', () => ({
  notificationPermission: () => 'denied',
  requestWebNotificationPermission: async () => 'denied',
  showNotification: async () => false,
}));
vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useAccount: () => ({ address: ADDRESS }),
  usePublicClient: () => client,
  useWriteContract: () => ({ writeContract }),
}));

import { useDCA } from './useDCA';

const STORAGE_KEY = `tegridy_dca_v1_1_${ADDRESS.toLowerCase()}`;
const firstPoll = () => act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

function seed(fromToken: object, toToken: object) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    schedules: [{
      id: 'sched-1', fromToken, toToken, amountPerSwap: '0.01', interval: 'daily', totalSwaps: 5,
      completedSwaps: 0, createdAt: 1, lastSwapAt: 0, status: 'active', slippageBps: 50,
    }],
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContract.mockReset();
  cut.kLast = 7n;
  client.readContract.mockReset().mockImplementation(async ({ functionName, address }: { functionName: string; address: string }) => {
    if (functionName === 'getPair') return PAIR;
    if (functionName === 'kLast') {
      if (cut.kLast === 'unread') throw new Error('rpc down');
      return cut.kLast;
    }
    if (functionName === 'allowance') return 10n ** 30n;
    // Our pool pays more than Uniswap, so with its cut on it is the one chosen.
    return address === UNISWAP_V2_ROUTER ? [10n ** 16n, 10n ** 20n] : [10n ** 16n, 10n ** 21n];
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const sentTo = () => writeContract.mock.calls.map((c) => (c[0] as { address: string }).address);

describe('useDCA: our pool only with the venue cut on', () => {
  it('CONTROL: ETH in, cut on: the better-paying pool of ours is used', async () => {
    seed(ETH, TOWELI);
    renderHook(() => useDCA());
    await firstPoll();
    expect(sentTo()).toEqual([SWAP_FEE_ROUTER_ADDRESS]);
  });

  it.each([0n, 'unread'] as const)('ETH in, cut %s: Uniswap, never our pool', async (kLast) => {
    cut.kLast = kLast;
    seed(ETH, TOWELI);
    renderHook(() => useDCA());
    await firstPoll();
    expect(sentTo()).toEqual([UNISWAP_V2_ROUTER]);
  });

  it('a token in, cut off: the swap is skipped, and the toast says why', async () => {
    cut.kLast = 0n;
    seed(TOWELI, ETH);
    renderHook(() => useDCA());
    await firstPoll();
    expect(writeContract).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('DCA: our TOWELI → ETH pool does not pay the venue its cut yet. Swap skipped.');
  });

  it('a token in, cut unread: the swap is skipped as unread, never sent', async () => {
    cut.kLast = 'unread';
    seed(TOWELI, ETH);
    renderHook(() => useDCA());
    await firstPoll();
    expect(writeContract).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('DCA: could not read our TOWELI → ETH pool. Swap skipped.');
  });
});
