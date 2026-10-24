// A DCA swap the wallet replaced, and a DCA swap whose schedule this tab could not store.
//
// REPLACED. When a wallet replaces a pending swap at its nonce, viem's
// `publicClient.waitForTransactionReceipt` does not fail: it resolves with the
// REPLACEMENT's receipt, and only its `onReplaced` callback says why (pinned against
// the real client in lib/txErrors.direct.test.ts). A wallet cancel is a 0-value send
// to yourself, so that receipt says success, and the keeper counted a swap that never
// ran. A speed-up is the same swap with more gas, so it still counts.
//
// STORAGE THAT WILL NOT TAKE A WRITE. The schedule settled only from storage, and the
// hash written at submission never got there, so the swap that landed was never
// counted and the schedule showed "Confirming" for good. Mirrors #629's fix for limit
// orders: while this tab's writes are failing, it settles from its own list.
//
// Each test that names a pre-fix failure fails on the pre-fix hook.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { TransactionReceiptNotFoundError } from 'viem';

const { toast, writeContract, client, channels } = vi.hoisted(() => {
  // BroadcastChannel is how another tab's write reaches this one. A stand-in that
  // delivers on demand, so a test can say exactly when "another tab" wrote.
  type Listener = (e: { data: unknown }) => void;
  const all: { name: string; listeners: Set<Listener> }[] = [];
  class FakeChannel {
    name: string;
    listeners = new Set<Listener>();
    constructor(name: string) { this.name = name; all.push(this); }
    addEventListener(_type: string, fn: Listener) { this.listeners.add(fn); }
    removeEventListener(_type: string, fn: Listener) { this.listeners.delete(fn); }
    postMessage() { /* this tab's own posts are not delivered back to it */ }
    close() {}
  }
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
  return {
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
    writeContract: vi.fn(),
    client: {
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
      getTransactionReceipt: vi.fn(),
    },
    channels: {
      fromAnotherTab(name: string, data: unknown) {
        for (const c of all) if (c.name === name) c.listeners.forEach((fn) => fn({ data }));
      },
    },
  };
});

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;
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

const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').schedules?.[0];

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const firstPoll = () => flush(POLL_MS);

/**
 * What viem does when the wallet replaced the swap: call onReplaced with the reason,
 * then RESOLVE with the replacement's receipt, which says success.
 */
function replacedWait(reason: 'cancelled' | 'repriced' | 'replaced') {
  return async (args: { hash: `0x${string}`; onReplaced?: (r: unknown) => void }) => {
    args.onReplaced?.({ reason, replacedTransaction: { hash: args.hash }, transaction: { hash: R_HASH }, transactionReceipt: {} });
    return { status: 'success', transactionHash: R_HASH };
  };
}

const failToasts = () => toast.error.mock.calls.map((c) => String(c[0])).filter((m) => /fail/i.test(m));

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContract.mockReset().mockImplementation((_args, opts: { onSuccess: (h: string) => void }) => opts.onSuccess(HASH));
  client.readContract.mockReset().mockResolvedValue([10n ** 16n, 10n ** 21n]);
  client.waitForTransactionReceipt.mockReset();
  client.getTransactionReceipt.mockReset().mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
  seedDueSchedule();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useDCA: a swap the wallet replaced', () => {
  it('asks viem why a replaced swap was replaced (onReplaced on the wait)', async () => {
    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    renderHook(() => useDCA());
    await firstPoll();
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH, onReplaced: expect.any(Function) }),
    );
  });

  it('a wallet CANCEL is not counted as a swap, and says it was cancelled', async () => {
    client.waitForTransactionReceipt.mockImplementation(replacedWait('cancelled'));
    const { result } = renderHook(() => useDCA());
    await firstPoll();

    expect(result.current.schedules[0]?.completedSwaps).toBe(0);
    expect(stored()?.completedSwaps).toBe(0);
    expect(result.current.schedules[0]?.pendingTx).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('Transaction cancelled', expect.objectContaining({
      description: expect.stringContaining(HASH.slice(0, 10)),
    }));
    expect(failToasts()).toEqual([]);
  });

  it('a different transaction at that nonce is not counted either', async () => {
    client.waitForTransactionReceipt.mockImplementation(replacedWait('replaced'));
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    expect(result.current.schedules[0]?.completedSwaps).toBe(0);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('Transaction replaced', expect.anything());
  });

  it('a SPEED-UP is the same swap: it counts once, and the schedule does not swap again', async () => {
    client.waitForTransactionReceipt.mockImplementation(replacedWait('repriced'));
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    await flush(POLL_MS);
    expect(result.current.schedules[0]?.completedSwaps).toBe(1);
    expect(stored()?.completedSwaps).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });
});

describe('useDCA: storage that will not take a write', () => {
  const blockWrites = () =>
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });

  it('a swap that landed is still counted, and the schedule does not stay "Confirming"', async () => {
    blockWrites();
    client.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });
    const { result } = renderHook(() => useDCA());
    await firstPoll();

    expect(result.current.schedules[0]?.pendingTx).toBeUndefined();
    expect(result.current.schedules[0]?.completedSwaps).toBe(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('an unread receipt read later still settles it', async () => {
    blockWrites();
    client.waitForTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: HASH }));
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    expect(result.current.schedules[0]?.pendingTx).toBe(HASH);

    client.getTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH });
    await flush(POLL_MS);
    expect(result.current.schedules[0]?.pendingTx).toBeUndefined();
    expect(result.current.schedules[0]?.completedSwaps).toBe(1);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it("another tab's write does not drop this tab's swap in flight, so it is not sent twice", async () => {
    blockWrites();
    let reject!: (e: unknown) => void;
    client.waitForTransactionReceipt.mockReturnValue(new Promise((_, r) => { reject = r; }));
    const { result } = renderHook(() => useDCA());
    await firstPoll();
    expect(writeContract).toHaveBeenCalledTimes(1);

    // Storage still holds the schedule as it was before this tab's swap: no hash.
    act(() => { channels.fromAnotherTab('tegridy_dca_sync', { type: 'dca_updated', address: ADDRESS }); });
    reject(new TransactionReceiptNotFoundError({ hash: HASH }));
    await flush();
    await flush(POLL_MS);
    await flush(POLL_MS);

    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result.current.schedules[0]?.pendingTx).toBe(HASH);
  });
});
