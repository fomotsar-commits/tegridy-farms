import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { noteResponse } from '../../../lib/solana/lp/rpcBudget';
import { OPTIONAL_READ_FLOOR } from '../../../lib/solana/lp/readFetch';
import { usePoll } from './useRangeData';

/**
 * A card's refresh: one count a period while the page is in view and the chain budget allows
 * an optional read. Card 03's 17 bands (about 235 KB) ride on it, so each gate is held here.
 */

const budget = (left: number) => noteResponse(new Response(null, { headers: { 'X-RateLimit-Remaining': String(left) } }));
const hidden = (on: boolean) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (on ? 'hidden' : 'visible') });

beforeEach(() => {
  vi.useFakeTimers();
  budget(300);
  hidden(false);
});
afterEach(() => {
  vi.useRealTimers();
  budget(300);
  hidden(false);
});

describe('usePoll', () => {
  it('counts once a period while the page is in view', () => {
    const { result } = renderHook(() => usePoll(60_000, true));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(59_999));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(2);
  });

  it('a hidden page does not count, and counts again once shown', () => {
    const { result } = renderHook(() => usePoll(60_000, true));
    hidden(true);
    act(() => vi.advanceTimersByTime(180_000));
    expect(result.current).toBe(0);
    hidden(false);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(1);
  });

  it('under the optional-read floor it does not count, so the live reads keep their calls', () => {
    const { result } = renderHook(() => usePoll(60_000, true));
    budget(OPTIONAL_READ_FLOOR - 1);
    act(() => vi.advanceTimersByTime(180_000));
    expect(result.current).toBe(0);
    budget(OPTIONAL_READ_FLOOR);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(1);
  });

  it('switched off, it never counts', () => {
    const { result } = renderHook(() => usePoll(60_000, false));
    act(() => vi.advanceTimersByTime(600_000));
    expect(result.current).toBe(0);
  });
});
