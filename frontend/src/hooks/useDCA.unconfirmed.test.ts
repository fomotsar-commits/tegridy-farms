// A DCA swap whose receipt could not be read must not be swapped again.
//
// viem's `publicClient.waitForTransactionReceipt` RETURNS a reverted receipt; it
// throws only when it could not read one (a 180s timeout, a receipt the node has
// not indexed, a transport error). So its catch knows nothing about the swap. The
// hook used to treat that catch as a failure: it toasted "DCA swap failed" and
// released the schedule, which was still due, so the next 30s poll sent the same
// swap again. If the first one landed, that is two swaps for one interval.
//
// Each test below that names a pre-fix failure fails on the pre-fix hook.

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
const HASH = `0x${'ab'.repeat(32)}` as const;

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
const POLL_MS = 30_000;

function seedDueSchedule() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    schedules: [{
      id: 'sched-1',
      fromToken: { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true },
      toToken: { symbol: 'TOWELI', address: `0x${'2'.repeat(40)}`, decimals: 18 },
      amountPerSwap: '0.01',
      interval: 'daily',
      totalSwaps: 5,
      completedSwaps: 0,
      createdAt: 1,
      lastSwapAt: 0, // due now
      status: 'active',
      slippageBps: 50,
    }],
  }));
}

function stored() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').schedules?.[0];
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

// The first check runs one poll after mount: at mount the poller reads the ref
// before the loaded schedules have been synced into it.
const firstPoll = () => flush(POLL_MS);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContract.mockReset().mockImplementation((_args, opts: { onSuccess: (h: string) => void }) => opts.onSuccess(HASH));
  client.readContract.mockReset().mockResolvedValue([10n ** 16n, 10n ** 21n]);
  client.waitForTransactionReceipt.mockReset();
  client.getTransactionReceipt.mockReset().mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
  seedDueSchedule();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDCA — a receipt we could not read', () => {
  it('is not called failed: it gets the unconfirmed warning with the hash', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new WaitForTransactionReceiptTimeoutError({ hash: HASH }));
    renderHook(() => useDCA());
    await firstPoll();

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("We couldn't confirm this transaction", expect.objectContaining({
      description: expect.stringContaining(HASH.slice(0, 10)),
    }));
    const failed = toast.error.mock.calls.map((c) => String(c[0])).filter((m) => /fail/i.test(m));
    expect(failed).toEqual([]);
  });

  it('does not release the schedule: the next polls do not swap again, and it is not "due"', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    expect(writeContract).toHaveBeenCalledTimes(1);

    await flush(POLL_MS);
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result.current.dueSchedules).toEqual([]);
    expect(result.current.schedules[0]?.pendingTx).toBe(HASH);
  });

  it('holds across a reload: the unread hash is in storage, so a fresh mount does not swap', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const first = renderHook(() => useDCA());
    await firstPoll();
    first.unmount();
    expect(stored()?.pendingTx).toBe(HASH);

    renderHook(() => useDCA());
    await firstPoll();
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('holds when the component unmounts while the receipt is still being waited for', async () => {
    // viem waits up to 180s. A user who leaves the page in that time unmounts the
    // hook, and a functional setState on an unmounted component never runs, so
    // anything the catch wrote only through React state would be lost.
    let reject!: (e: unknown) => void;
    client.waitForTransactionReceipt.mockReturnValue(new Promise((_, r) => { reject = r; }));
    const first = renderHook(() => useDCA());
    await firstPoll();
    first.unmount();
    reject(new WaitForTransactionReceiptTimeoutError({ hash: HASH }));
    await flush();

    renderHook(() => useDCA());
    await firstPoll();
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('is settled by a later read: a success counts the swap once and does not swap again this interval', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    await flush(POLL_MS); // still unreadable
    expect(result.current.schedules[0]?.completedSwaps).toBe(0);

    client.getTransactionReceipt.mockResolvedValue({ status: 'success' });
    await flush(POLL_MS);
    expect(result.current.schedules[0]?.completedSwaps).toBe(1);
    expect(result.current.schedules[0]?.pendingTx).toBeUndefined();
    expect(stored()?.completedSwaps).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);

    await flush(POLL_MS);
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result.current.schedules[0]?.completedSwaps).toBe(1);
  });

  it('is released by a later read of a revert, and only then swaps again', async () => {
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    renderHook(() => useDCA());
    await firstPoll();
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);

    client.getTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    await flush(POLL_MS); // reads the revert, releases
    expect(toast.error).toHaveBeenCalledWith('DCA swap transaction reverted on-chain.');
    await flush(POLL_MS); // due again: nothing moved
    expect(writeContract).toHaveBeenCalledTimes(2);
  });
});

describe('useDCA — one receipt, read twice', () => {
  it('counts the swap once when the original waiter returns after a re-read already settled it', async () => {
    // Leave the page and come back inside viem's 180s wait: the old mount's waiter
    // is still out, and the new mount re-reads the same hash. Both see success.
    let resolveOld!: (r: { status: string }) => void;
    client.waitForTransactionReceipt.mockReturnValue(new Promise((r) => { resolveOld = r; }));
    const first = renderHook(() => useDCA());
    await firstPoll();
    first.unmount();

    client.getTransactionReceipt.mockResolvedValue({ status: 'success' });
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    expect(result.current.schedules[0]?.completedSwaps).toBe(1);

    resolveOld({ status: 'success' });
    await flush();
    expect(stored()?.completedSwaps).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});

describe('useDCA — receipts we did read (unchanged behaviour)', () => {
  it('a reverted receipt releases the schedule and says reverted', async () => {
    client.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    expect(toast.error).toHaveBeenCalledWith('DCA swap transaction reverted on-chain.');
    expect(result.current.schedules[0]?.pendingTx).toBeUndefined();

    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  it('a successful receipt counts the swap once', async () => {
    client.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result.current.schedules[0]?.completedSwaps).toBe(1);
    expect(stored()?.completedSwaps).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
