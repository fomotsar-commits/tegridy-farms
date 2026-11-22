// A limit order executes only on our pool, so only where the venue's cut is on (kLast non-zero).
// The old Ethereum factory still opens pools for free with the cut off (leak audit 2026-11-15,
// EVM-3): an order on such a pool, or on one whose kLast did not answer, is not sent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { toast, writeContract, client, cut } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  writeContract: vi.fn(),
  client: { readContract: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransactionReceipt: vi.fn() },
  cut: { kLast: 7n as bigint | 'unread' },
}));

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const PAIR = '0x00000000000000000000000000000000000000a1' as const;

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

import { useLimitOrders } from './useLimitOrders';

const STORAGE_KEY = `tegridy_limit_v1_1_${ADDRESS.toLowerCase()}`;
const POLL_MS = 15_000;
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').orders?.[0];
const firstPoll = () => act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContract.mockReset();
  cut.kLast = 7n;
  client.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getPair') return PAIR;
    if (functionName === 'kLast') {
      if (cut.kLast === 'unread') throw new Error('rpc down');
      return cut.kLast;
    }
    return [10n ** 16n, 10n ** 19n]; // every quote prices it at 1000, through the target of 1
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    orders: [{
      id: 'order-1',
      fromToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true },
      toToken: { symbol: 'TOWELI', address: `0x${'2'.repeat(40)}`, decimals: 18 },
      amount: '0.01',
      targetPrice: '1',
      createdAt: 1,
      expiresAt: Date.now() + 7 * 86_400_000,
      status: 'active',
    }],
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLimitOrders: our pool only with the venue cut on', () => {
  it('CONTROL: with the cut on, the triggered order is sent', async () => {
    renderHook(() => useLimitOrders());
    await firstPoll();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('with the cut off (kLast 0), the order is not sent, it says why, and it stays active', async () => {
    cut.kLast = 0n;
    renderHook(() => useLimitOrders());
    await firstPoll();
    expect(writeContract).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Limit order: our pool for this pair does not pay the venue its cut yet. Not executed.');
    expect(stored()?.status).toBe('active');
  });

  it('with kLast unread, the order is not sent: unread is never taken as on', async () => {
    cut.kLast = 'unread';
    renderHook(() => useLimitOrders());
    await firstPoll();
    expect(writeContract).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Limit order: could not read our pool for this pair. Will retry next tick.');
  });
});
