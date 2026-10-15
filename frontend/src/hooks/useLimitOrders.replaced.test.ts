// A limit-order swap the wallet replaced.
//
// When a wallet replaces a pending swap at its nonce, viem's
// `publicClient.waitForTransactionReceipt` does not fail: it resolves with the
// REPLACEMENT's receipt, and only its `onReplaced` callback says why (pinned against
// the real client in lib/txErrors.direct.test.ts). A wallet cancel is a 0-value send
// to yourself, so that receipt says success, and the order was marked FILLED with
// nothing swapped. A speed-up is the same swap with more gas: it filled, and the order
// should point at the transaction that mined, not the one that never did.
//
// Each test that names a pre-fix failure fails on the pre-fix hook.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { TransactionReceiptNotFoundError } from 'viem';

const { toast, writeContract, client } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  writeContract: vi.fn(),
  client: {
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(),
  },
}));

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const HASH = `0x${'cd'.repeat(32)}` as const;
const R_HASH = `0x${'ef'.repeat(32)}` as const;

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

function seedTriggeredOrder() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    orders: [{
      id: 'order-1',
      fromToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true },
      toToken: { symbol: 'TOWELI', address: `0x${'2'.repeat(40)}`, decimals: 18 },
      amount: '0.01',
      targetPrice: '1', // the quotes below price it at 1000, so it triggers every poll
      createdAt: 1,
      expiresAt: Date.now() + 7 * 86_400_000,
      status: 'active',
    }],
  }));
}

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').orders?.[0];

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const firstPoll = () => flush(POLL_MS);

/** viem on a replaced tx: onReplaced with the reason, then the REPLACEMENT's success receipt. */
function replacedWait(reason: 'cancelled' | 'repriced' | 'replaced') {
  return async (args: { hash: `0x${string}`; onReplaced?: (r: unknown) => void }) => {
    args.onReplaced?.({ reason, replacedTransaction: { hash: args.hash }, transaction: { hash: R_HASH }, transactionReceipt: {} });
    return { status: 'success', transactionHash: R_HASH };
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContract.mockReset().mockImplementation((_args, opts: { onSuccess: (h: string) => void }) => opts.onSuccess(HASH));
  client.readContract.mockReset().mockResolvedValue([10n ** 16n, 10n ** 19n]);
  client.waitForTransactionReceipt.mockReset();
  client.getTransactionReceipt.mockReset().mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
  seedTriggeredOrder();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLimitOrders: a swap the wallet replaced', () => {
  it('asks viem why a replaced swap was replaced (onReplaced on the wait)', async () => {
    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    renderHook(() => useLimitOrders());
    await firstPoll();
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH, onReplaced: expect.any(Function) }),
    );
  });

  it('a wallet CANCEL is not a fill: the order goes back to active, and says it was cancelled', async () => {
    client.waitForTransactionReceipt.mockImplementationOnce(replacedWait('cancelled'));
    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();

    expect(result.current.orders[0]?.status).not.toBe('filled');
    expect(stored()?.status).not.toBe('filled');
    expect(stored()?.txHash).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('Transaction cancelled', expect.objectContaining({
      description: expect.stringContaining(HASH.slice(0, 10)),
    }));
  });

  it('a different transaction at that nonce is not a fill either', async () => {
    client.waitForTransactionReceipt.mockImplementationOnce(replacedWait('replaced'));
    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    expect(result.current.orders[0]?.status).not.toBe('filled');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('Transaction replaced', expect.anything());
  });

  it('a SPEED-UP filled the order, and the order keeps the hash that actually mined', async () => {
    client.waitForTransactionReceipt.mockImplementation(replacedWait('repriced'));
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    await flush(POLL_MS);

    expect(result.current.orders[0]?.status).toBe('filled');
    expect(stored()?.status).toBe('filled');
    expect(stored()?.txHash).toBe(R_HASH);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});
