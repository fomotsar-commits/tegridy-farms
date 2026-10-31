import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { PoolListRead } from '../../../lib/solana/lp/poolList';
import { noteResponse } from '../../../lib/solana/lp/rpcBudget';
import { OPTIONAL_READ_FLOOR } from '../../../lib/solana/lp/readFetch';
import type { LpReaders } from './readers';
import { LIST_REFRESH_MS, useLivePoolList } from './usePoolList';

// The list, kept live for the arbitrage board and All pools: read again every 30 seconds
// while the tab is in view and the proxy's budget allows it, kept on screen when a later
// read fails (said as old, never replaced by nothing), and read at once on a press.

const T0 = 1_700_000_000_000;

const ok = (n: number): PoolListRead => ({ kind: 'ok', list: { pools: [], unread: n, truncated: false, chainNow: null, safety: new Map() } });

/** A reader whose list reads answer when the test says: each call is a deferred promise. */
function reader() {
  const pending: { resolve: (r: PoolListRead) => void; reject: (e: Error) => void }[] = [];
  const listPools = vi.fn(() => new Promise<PoolListRead>((resolve, reject) => pending.push({ resolve, reject })));
  const readers = { programId: 'p', listPools } as unknown as LpReaders;
  return { readers, listPools, answer: (i: number, r: PoolListRead) => pending[i]!.resolve(r), fail: (i: number, why: string) => pending[i]!.reject(new Error(why)) };
}

/** Tell the budget how many proxy calls are left in a window ending ten minutes out (past the window the gate knows nothing, and allows). */
const budget = (remaining: number) => noteResponse(new Response('{}', { headers: { 'X-RateLimit-Remaining': String(remaining), 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 600) } }));

const setView = (state: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  setView('visible');
  budget(250);
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = () => act(async () => { await Promise.resolve(); });

describe('useLivePoolList', () => {
  it('reads at mount, then again every 30 seconds, keeping the last list until the new one lands', async () => {
    const r = reader();
    const { result } = renderHook(() => useLivePoolList(r.readers, 0));
    expect(r.listPools).toHaveBeenCalledTimes(1);
    expect(result.current.read).toBeNull();
    expect(result.current.reading).toBe(true);
    await act(async () => { r.answer(0, ok(1)); });
    expect(result.current.read).toEqual(ok(1));
    expect(result.current.readAt).toBe(T0);
    expect(result.current.reading).toBe(false);

    await act(async () => { vi.advanceTimersByTime(LIST_REFRESH_MS - 1); });
    expect(r.listPools).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(r.listPools).toHaveBeenCalledTimes(2);
    // The last list stays while the new one is on its way.
    expect(result.current.read).toEqual(ok(1));
    expect(result.current.readAt).toBe(T0);
    expect(result.current.reading).toBe(true);
    await act(async () => { r.answer(1, ok(2)); });
    expect(result.current.read).toEqual(ok(2));
    expect(result.current.readAt).toBe(T0 + LIST_REFRESH_MS);
    expect(result.current.failed).toBeNull();
  });

  it('a later read that fails keeps the list and its time, and says why; the next answer clears it', async () => {
    const r = reader();
    const { result } = renderHook(() => useLivePoolList(r.readers, 0));
    await act(async () => { r.answer(0, ok(1)); });
    await act(async () => { vi.advanceTimersByTime(LIST_REFRESH_MS); });
    await act(async () => { r.fail(1, 'the chain did not answer in 20 seconds'); });
    await flush();
    expect(result.current.read).toEqual(ok(1));
    expect(result.current.readAt).toBe(T0);
    expect(result.current.failed).toBe('the chain did not answer in 20 seconds');
    expect(result.current.reading).toBe(false);
    // An answer that is itself "unread" is a failed later read too.
    await act(async () => { vi.advanceTimersByTime(LIST_REFRESH_MS); });
    await act(async () => { r.answer(2, { kind: 'unread', detail: 'the pool index answered HTTP 502' }); });
    expect(result.current.read).toEqual(ok(1));
    expect(result.current.failed).toBe('the pool index answered HTTP 502');
    await act(async () => { vi.advanceTimersByTime(LIST_REFRESH_MS); });
    await act(async () => { r.answer(3, ok(3)); });
    expect(result.current.read).toEqual(ok(3));
    expect(result.current.failed).toBeNull();
  });

  it('the first read failing is the list’s state (unread), stamped like any answer', async () => {
    const r = reader();
    const { result } = renderHook(() => useLivePoolList(r.readers, 0));
    await act(async () => { r.fail(0, 'boom'); });
    await flush();
    expect(result.current.read).toEqual({ kind: 'unread', detail: 'boom' });
    expect(result.current.readAt).toBe(T0);
    expect(result.current.failed).toBeNull();
  });

  it('no read while the tab is hidden; back in view with stale figures it reads at once', async () => {
    const r = reader();
    const { result } = renderHook(() => useLivePoolList(r.readers, 0));
    await act(async () => { r.answer(0, ok(1)); });
    setView('hidden');
    await act(async () => { vi.advanceTimersByTime(3 * LIST_REFRESH_MS); });
    expect(r.listPools).toHaveBeenCalledTimes(1);
    setView('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(r.listPools).toHaveBeenCalledTimes(2);
    await act(async () => { r.answer(1, ok(2)); });
    expect(result.current.read).toEqual(ok(2));
    // Back in view with fresh figures: nothing extra is read.
    setView('hidden');
    setView('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(r.listPools).toHaveBeenCalledTimes(2);
  });

  it('under the proxy’s budget floor nothing reads by itself, and a press says it is paused; with budget back, a press reads', async () => {
    const r = reader();
    const { result } = renderHook(() => useLivePoolList(r.readers, 0));
    await act(async () => { r.answer(0, ok(1)); });
    budget(OPTIONAL_READ_FLOOR - 1);
    await act(async () => { vi.advanceTimersByTime(2 * LIST_REFRESH_MS); });
    expect(r.listPools).toHaveBeenCalledTimes(1);
    act(() => result.current.again());
    expect(result.current.paused).toBe(true);
    expect(r.listPools).toHaveBeenCalledTimes(1);
    budget(OPTIONAL_READ_FLOOR);
    act(() => result.current.again());
    expect(result.current.paused).toBe(false);
    expect(r.listPools).toHaveBeenCalledTimes(2);
    // A second press while that read is on its way asks nothing more.
    act(() => result.current.again());
    expect(r.listPools).toHaveBeenCalledTimes(2);
    await act(async () => { r.answer(1, ok(2)); });
    expect(result.current.read).toEqual(ok(2));
  });

  it('a finished liquidity flow (reloadKey) reads again at once, and an answer to the dropped question is ignored', async () => {
    const r = reader();
    const { result, rerender } = renderHook(({ key }) => useLivePoolList(r.readers, key), { initialProps: { key: 0 } });
    await act(async () => { r.answer(0, ok(1)); });
    await act(async () => { vi.advanceTimersByTime(LIST_REFRESH_MS); });
    expect(r.listPools).toHaveBeenCalledTimes(2);
    rerender({ key: 1 });
    expect(r.listPools).toHaveBeenCalledTimes(3);
    // The tick's read (question 2) answers late: dropped. The flow's read (question 3) lands.
    await act(async () => { r.answer(1, ok(9)); });
    expect(result.current.read).toEqual(ok(1));
    await act(async () => { r.answer(2, ok(3)); });
    expect(result.current.read).toEqual(ok(3));
  });

  it('a reader without listPools reads nothing', () => {
    const { result } = renderHook(() => useLivePoolList({ programId: 'p' } as unknown as LpReaders, 0));
    expect(result.current.read).toBeNull();
    expect(result.current.reading).toBe(false);
  });
});
