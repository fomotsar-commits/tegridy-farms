// The swap form's read of our pools: one search per pair for a while, a fresh read of the
// pools for each amount after a pause, and an answer kept only for the request it answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { OwnPoolReaders, OwnQuotesRead, OwnSearchRead } from '../../lib/solana/swap/ownPools';

const h = vi.hoisted(() => ({ search: vi.fn(), quote: vi.fn() }));
vi.mock('../../lib/solana/swap/ownPools', async (orig) => ({
  ...(await orig<typeof import('../../lib/solana/swap/ownPools')>()),
  searchOwnPools: h.search,
  quoteOwnPools: h.quote,
}));
// The browser readers are never built here: every case passes its own.
vi.mock('../solana/lp/readers', () => ({ browserOwnPoolReaders: () => null }));

import { OWN_QUOTE_DEBOUNCE_MS, forgetOwnPoolSearches, useOwnPoolRoute } from './useOwnPoolRoute';

const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = '9ppyE7Bp4D2pCaAyKG4C11LsrZmTaGzbTiTtxQSor1wM';
const OTHER = 'E1H9ZbDbYpNmDBpeVVXPtX6P4bCao6xUgky1nRxHBwQk';
const readers = {} as OwnPoolReaders;
const SEARCH: OwnSearchRead = { kind: 'ok', search: { pair: { quote: {} as never, tokenMint: TOKEN }, addresses: ['P'], gaps: [], token: { kind: 'unread', mint: TOKEN, detail: '' } } };
const quoted = (n: number): OwnQuotesRead => ({ kind: 'ok', quotes: { found: n, gaps: [], best: null, excluded: [] } });

beforeEach(() => {
  vi.useFakeTimers();
  forgetOwnPoolSearches();
  h.search.mockReset().mockResolvedValue(SEARCH);
  h.quote.mockReset().mockImplementation(async (_r, _s, _in, amount: bigint) => quoted(Number(amount)));
});
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(OWN_QUOTE_DEBOUNCE_MS); });

describe('useOwnPoolRoute', () => {
  it('reads after the pause, and an answer for an amount since changed is never shown', async () => {
    const { result, rerender } = renderHook((p: { amountIn: bigint }) => useOwnPoolRoute({ inputMint: SOL, outputMint: TOKEN, amountIn: p.amountIn, readers }), { initialProps: { amountIn: 5n } });
    expect(result.current.own).toEqual({ kind: 'pending' });
    // Each keystroke would otherwise be two chain reads.
    await act(async () => { await vi.advanceTimersByTimeAsync(OWN_QUOTE_DEBOUNCE_MS - 1); });
    expect(h.quote).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.own).toMatchObject({ kind: 'ok', quotes: { found: 5 } });
    rerender({ amountIn: 7n });
    // The 5's answer is not the 7's.
    expect(result.current.own).toEqual({ kind: 'pending' });
    await settle();
    expect(result.current.own).toMatchObject({ kind: 'ok', quotes: { found: 7 } });
  });

  it('searches a pair once for 30 seconds, whatever the amount, and again after', async () => {
    const { rerender } = renderHook((p: { amountIn: bigint }) => useOwnPoolRoute({ inputMint: SOL, outputMint: TOKEN, amountIn: p.amountIn, readers }), { initialProps: { amountIn: 1n } });
    await settle();
    rerender({ amountIn: 2n });
    await settle();
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.quote).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    rerender({ amountIn: 3n });
    await settle();
    expect(h.search).toHaveBeenCalledTimes(2);
  });

  it('a search that could not be read is tried again after 15 seconds, not 30', async () => {
    h.search.mockResolvedValueOnce({ kind: 'unread', detail: 'HTTP 502' });
    const { result, rerender } = renderHook((p: { amountIn: bigint }) => useOwnPoolRoute({ inputMint: SOL, outputMint: TOKEN, amountIn: p.amountIn, readers }), { initialProps: { amountIn: 1n } });
    await settle();
    expect(result.current.own).toEqual({ kind: 'unread' });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    rerender({ amountIn: 2n });
    await settle();
    expect(h.search).toHaveBeenCalledTimes(2);
    expect(result.current.own).toMatchObject({ kind: 'ok' });
  });

  it('a pair with no pairing coin is never searched, and a build with no pool program reads nothing', async () => {
    const pair = renderHook(() => useOwnPoolRoute({ inputMint: TOKEN, outputMint: OTHER, amountIn: 1n, readers }));
    const none = renderHook(() => useOwnPoolRoute({ inputMint: SOL, outputMint: TOKEN, amountIn: 1n, readers: null }));
    await settle();
    expect(pair.result.current.own).toEqual({ kind: 'not-a-pair' });
    expect(none.result.current.own).toEqual({ kind: 'absent' });
    expect(h.search).not.toHaveBeenCalled();
  });

  it('quoteNow reads the pools again, fresh, through the cached search', async () => {
    const { result } = renderHook(() => useOwnPoolRoute({ inputMint: SOL, outputMint: TOKEN, amountIn: 9n, readers }));
    await settle();
    await act(async () => { expect(await result.current.quoteNow()).toEqual(quoted(9)); });
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.quote).toHaveBeenCalledTimes(2);
  });
});
