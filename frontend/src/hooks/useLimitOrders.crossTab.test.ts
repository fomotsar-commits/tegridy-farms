// Two tabs with the same wallet must not both fire one limit order.
//
// Each mounted useLimitOrders keeps its own copy of the order list, and the
// only thing the tabs shared was the per-order lock in localStorage, which is
// released on every terminal outcome. So a second tab (the swap page open
// twice, or the swap page and the dashboard) still held the order as 'active'
// after the first tab had sent it, and with the price still through the target
// it fired the same order once the lock was gone: after a fill, a cancel, or a
// wallet prompt left open past the lock's 60s. Every write also saved the
// writing tab's whole list, so a stale tab put an order the other tab had
// filled back to 'active' in storage.
//
// Both tabs here are hooks mounted in one jsdom window, sharing its
// localStorage. jsdom fires no `storage` event for a write in the same window,
// so these tabs hear nothing from each other unless a test dispatches the
// event itself: the worst case, where only what storage holds can stop a fire.
//
// Every test in the first two blocks fails on the pre-fix hook.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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
const HALF = POLL_MS / 2;
const ETH = { symbol: 'ETH', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, isNative: true };
const TOWELI = { symbol: 'TOWELI', address: `0x${'2'.repeat(40)}`, decimals: 18 };

function order(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    fromToken: ETH,
    toToken: TOWELI,
    amount: '0.01',
    targetPrice: '1', // the quotes below price it at 1000, so it triggers every check
    createdAt: 1,
    expiresAt: Date.now() + 7 * 86_400_000,
    status: 'active',
    ...fields,
  };
}

function seed(...orders: ReturnType<typeof order>[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, orders }));
}

function storedOrders(): Array<{ id: string; status: string }> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').orders ?? [];
}

function storedOrder(id = 'order-1') {
  return storedOrders().find((o) => o.id === id);
}

async function flush(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

// A hook's first price check runs one poll after it mounts (at mount the poller
// reads the ref before the loaded orders are synced into it). Tab B opens half a
// poll after tab A, so the checks alternate A, B, A, B, HALF apart, and between
// a check of A's and B's next one, B holds whatever it last read.
//   t = 7.5s  twoTabs() returns
//   t = 15s   A checks      t = 22.5s  B checks      t = 30s  A checks  ...
async function twoTabs() {
  const a = renderHook(() => useLimitOrders());
  await flush(HALF);
  const b = renderHook(() => useLimitOrders());
  return { a, b };
}
const nextCheck = () => flush(HALF);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.values(toast).forEach((fn) => fn.mockReset());
  writeContract.mockReset().mockImplementation((_args, opts: { onSuccess: (h: string) => void }) => opts.onSuccess(HASH));
  client.readContract.mockReset().mockResolvedValue([10n ** 16n, 10n ** 19n]);
  client.waitForTransactionReceipt.mockReset().mockResolvedValue({ status: 'success' });
  client.getTransactionReceipt.mockReset().mockResolvedValue({ status: 'success' });
  seed(order('order-1'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLimitOrders — an order another tab already moved is not fired again', () => {
  it('filled in one tab: the other tab, price still through the target, does not swap a second time', async () => {
    const { a, b } = await twoTabs();
    await nextCheck(); // A fills it
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(a.result.current.orders[0]?.status).toBe('filled');
    expect(b.result.current.orders[0]?.status).toBe('active'); // B has not heard

    for (let i = 0; i < 4; i++) await nextCheck();
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(storedOrder()?.status).toBe('filled');
  });

  it('waiting in one tab\'s wallet past the lock\'s 60s: the other tab does not send it too', async () => {
    writeContract.mockImplementation(() => {}); // the prompt stays open: no hash, no error
    await twoTabs();
    await nextCheck(); // A sends it to the wallet
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(storedOrder()?.status).toBe('executing');

    for (let i = 0; i < 12; i++) await nextCheck(); // t = 105s: A's lock is long stale
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('cancelled in one tab: the other tab does not fire it', async () => {
    const { a } = await twoTabs();
    act(() => { a.result.current.cancelOrder('order-1'); });
    expect(storedOrder()).toBeUndefined();

    for (let i = 0; i < 4; i++) await nextCheck();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it('put back after a wallet rejection: one tab takes it, and the other does not fire it again', async () => {
    writeContract.mockImplementationOnce((_args, opts: { onError: (e: Error) => void }) => opts.onError(new Error('User rejected')));
    await twoTabs();
    await nextCheck(); // A: rejected, the order is active again
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(storedOrder()?.status).toBe('active');

    await nextCheck(); // B takes it and fills it
    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(storedOrder()?.status).toBe('filled');

    for (let i = 0; i < 4; i++) await nextCheck();
    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  it('a tab that refuses takes storage\'s copy, and stops checking the price', async () => {
    const { b } = await twoTabs();
    await nextCheck(); // A fills it
    await nextCheck(); // B refuses
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(b.result.current.orders[0]?.status).toBe('filled');

    const reads = client.readContract.mock.calls.length;
    for (let i = 0; i < 4; i++) await nextCheck();
    expect(client.readContract).toHaveBeenCalledTimes(reads);
  });
});

describe('useLimitOrders — a stale tab\'s write keeps what the other tab wrote', () => {
  it('creating an order in a stale tab does not put a filled order back to active', async () => {
    const { b } = await twoTabs();
    await nextCheck(); // A fills it; B still holds it as active
    expect(storedOrder()?.status).toBe('filled');

    act(() => {
      b.result.current.createOrder({
        fromToken: ETH, toToken: TOWELI, amount: '0.02',
        targetPrice: '1000000', // out of reach: this one never fires
        expiresAt: Date.now() + 86_400_000,
      });
    });
    expect(storedOrders()).toHaveLength(2);
    expect(storedOrder()?.status).toBe('filled');

    for (let i = 0; i < 4; i++) await nextCheck();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('cancelling an order in a stale tab does not put a filled order back to active', async () => {
    seed(order('order-1'), order('order-2', { targetPrice: '1000000' }));
    const { b } = await twoTabs();
    await nextCheck(); // A fills order-1; B still holds it as active
    expect(storedOrder()?.status).toBe('filled');

    act(() => { b.result.current.cancelOrder('order-2'); });
    expect(storedOrders().map((o) => o.id)).toEqual(['order-1']);
    expect(storedOrder()?.status).toBe('filled');

    for (let i = 0; i < 4; i++) await nextCheck();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fills', () => {}],
    ['is rejected in the wallet', () => {
      writeContract.mockImplementationOnce((_args, opts: { onError: (e: Error) => void }) => opts.onError(new Error('User rejected')));
    }],
  ])('an order cancelled in one tab stays cancelled when the other tab sends an order that %s', async (_outcome, arrange) => {
    arrange();
    seed(order('order-1'), order('order-2', { targetPrice: '1000000' }));
    const { b } = await twoTabs();
    act(() => { b.result.current.cancelOrder('order-2'); }); // A still holds order-2

    await nextCheck(); // A sends order-1 and hears back
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(storedOrders().map((o) => o.id)).toEqual(['order-1']);
  });

  it('expiring an order in a stale tab does not put a filled order back to active', async () => {
    // order-2 is out of reach and runs out between A's fill (t = 15s) and B's
    // first check (t = 22.5s), so B writes its expiry while stale on order-1.
    seed(order('order-1'), order('order-2', { targetPrice: '1000000', expiresAt: Date.now() + 20_000 }));
    await twoTabs();
    await nextCheck(); // A fills order-1
    expect(storedOrder()?.status).toBe('filled');

    await nextCheck(); // B expires order-2
    expect(storedOrder('order-2')?.status).toBe('expired');
    expect(storedOrder()?.status).toBe('filled');
    expect(writeContract).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i++) await nextCheck();
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('a write from another tab reaches this one through the storage event', async () => {
    const { b } = await twoTabs();
    expect(b.result.current.orders[0]?.status).toBe('active');

    seed(order('order-1', { status: 'filled' }));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })); });
    expect(b.result.current.orders[0]?.status).toBe('filled');

    // A change to some other key is not this wallet's list.
    seed(order('order-1', { status: 'expired' }));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'tegridy_something_else' })); });
    expect(b.result.current.orders[0]?.status).toBe('filled');
  });
});

describe('useLimitOrders — one tab (unchanged behaviour)', () => {
  it('fires an active order once and marks it filled', async () => {
    const { result } = renderHook(() => useLimitOrders());
    await flush(POLL_MS);
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(result.current.orders[0]?.status).toBe('filled');
    expect(storedOrder()?.status).toBe('filled');
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('a reverted receipt puts the order back to active, and the next poll fires it again', async () => {
    client.waitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted' });
    const { result } = renderHook(() => useLimitOrders());
    await flush(POLL_MS);
    expect(toast.error).toHaveBeenCalledWith('Limit order transaction reverted on-chain.');
    expect(result.current.orders[0]?.status).toBe('active');
    expect(storedOrder()?.status).toBe('active');

    client.waitForTransactionReceipt.mockReturnValue(new Promise(() => {}));
    await flush(POLL_MS);
    expect(writeContract).toHaveBeenCalledTimes(2);
  });

  it('an order created here is stored and shown, and a cancel removes it from both', async () => {
    localStorage.clear();
    const { result } = renderHook(() => useLimitOrders());
    act(() => {
      result.current.createOrder({
        fromToken: ETH, toToken: TOWELI, amount: '0.02', targetPrice: '1000000',
        expiresAt: Date.now() + 86_400_000,
      });
    });
    const id = result.current.orders[0]?.id;
    expect(storedOrders().map((o) => o.id)).toEqual([id]);

    act(() => { result.current.cancelOrder(id!); });
    expect(result.current.orders).toEqual([]);
    expect(storedOrders()).toEqual([]);
  });
});
