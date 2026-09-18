// A limit order whose receipt could not be read must not be fired again.
//
// viem's `publicClient.waitForTransactionReceipt` RETURNS a reverted receipt; it
// throws only when it could not read one (a 180s timeout, a receipt the node has
// not indexed, a transport error). So its catch knows nothing about the swap. The
// hook used to treat that catch as a failure: it toasted "Limit order failed" and
// put the order back to 'active', and the next 15s price poll, with the price
// still through the target, sent the same swap again.
//
// Each test in the first block fails on the pre-fix hook.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError } from 'viem';

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

function stored() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').orders?.[0];
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

// The first check runs one poll after mount: at mount the poller reads the ref
// before the loaded orders have been synced into it.
const firstPoll = () => flush(POLL_MS);

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

describe('useLimitOrders — a receipt we could not read', () => {
  it('is not called failed: it gets the unconfirmed warning with the hash', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new WaitForTransactionReceiptTimeoutError({ hash: HASH }));
    renderHook(() => useLimitOrders());
    await firstPoll();

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
      description: expect.stringContaining(HASH.slice(0, 10)),
    }));
    const failed = toast.error.mock.calls.map((c) => String(c[0])).filter((m) => /fail/i.test(m));
    expect(failed).toEqual([]);
  });

  it('keeps the order executing: the next polls, with the price still through the target, do not fire it again', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    expect(writeContract).toHaveBeenCalledTimes(1);

    await flush(POLL_MS);
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result.current.orders[0]?.status).toBe('executing');
    expect(result.current.orders[0]?.txHash).toBe(HASH);
  });

  it('holds across a reload: the order and its hash are in storage, so a fresh mount does not fire it', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const first = renderHook(() => useLimitOrders());
    await firstPoll();
    first.unmount();
    expect(stored()?.status).toBe('executing');
    expect(stored()?.txHash).toBe(HASH);

    renderHook(() => useLimitOrders());
    await firstPoll();
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('is settled by a later read: a success marks it filled once', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    await flush(POLL_MS); // still unreadable
    expect(result.current.orders[0]?.status).toBe('executing');

    client.getTransactionReceipt.mockResolvedValue({ status: 'success' });
    await flush(POLL_MS);
    expect(result.current.orders[0]?.status).toBe('filled');
    expect(stored()?.status).toBe('filled');
    expect(toast.success).toHaveBeenCalledTimes(1);

    await flush(POLL_MS);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('is released by a later read of a revert, and only then fires again', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);

    client.getTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    await flush(POLL_MS); // reads the revert, puts the order back
    expect(toast.error).toHaveBeenCalledWith('Limit order transaction reverted on-chain.');
    expect(result.current.orders[0]?.status).not.toBe('filled');
    await flush(POLL_MS); // active again: nothing moved
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
});

describe('useLimitOrders — one receipt, read twice', () => {
  it('fills once when the original waiter returns after a re-read already settled it', async () => {
    let resolveOld!: (r: { status: string }) => void;
    client.waitForTransactionReceipt.mockReturnValue(new Promise((r) => { resolveOld = r; }));
    const first = renderHook(() => useLimitOrders());
    await firstPoll();
    first.unmount();

    client.getTransactionReceipt.mockResolvedValue({ status: 'success' });
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    expect(result.current.orders[0]?.status).toBe('filled');

    resolveOld({ status: 'reverted' }); // a stale answer must not reopen a filled order
    await flush();
    expect(stored()?.status).toBe('filled');
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});

describe('useLimitOrders — receipts we did read (unchanged behaviour)', () => {
  it('a reverted receipt puts the order back to active and says reverted', async () => {
    client.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    expect(toast.error).toHaveBeenCalledWith('Limit order transaction reverted on-chain.');
    expect(result.current.orders[0]?.status).toBe('active');

    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  it('a successful receipt marks the order filled', async () => {
    client.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    const { result } = renderHook(() => useLimitOrders());
    await firstPoll();
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result.current.orders[0]?.status).toBe('filled');
    expect(stored()?.status).toBe('filled');
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
