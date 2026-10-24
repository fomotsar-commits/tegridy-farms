// The market strip's contract: an unread figure stays null so the UI can print
// "—", and a real zero stays 0. Collapsing the two is the exact failure the
// venue's staking-look doc exists to prevent — a dry pool that reads as a
// number nobody funded.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePoolMarket } from './usePoolMarket';

// A trimmed copy of the real BAYLA/SOL response, read 2026-08-28. Note
// `market_cap_usd: null` — that is genuinely what upstream returns for her.
const BAYLA_POOL = {
  data: {
    attributes: {
      name: 'BAYLA / SOL',
      base_token_price_usd: '0.000562939829158353682120908975607251229379824047148198826050424634',
      fdv_usd: '559278.385904484',
      market_cap_usd: null,
      reserve_in_usd: '67300.2682',
      price_change_percentage: { h1: '-2.559', h6: '-0.485', h24: '0.156' },
      volume_usd: { h1: '418.33', h6: '3097.23', h24: '10084.09' },
      transactions: { h24: { buys: 110, sells: 91, buyers: 52, sellers: 47 } },
    },
  },
};

function mockFetch(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  } as Response);
}

beforeEach(() => { vi.stubGlobal('fetch', mockFetch(BAYLA_POOL)); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('usePoolMarket', () => {
  // THE ENDPOINT IS THE FIX, so it is pinned here rather than left to the mock.
  // This hook used to fetch api.geckoterminal.com directly from the browser,
  // twice per bungalow page view with no cache anywhere, and the 2026-09-04
  // field review found the consequence: a reload minutes later showed dashes
  // across the whole strip because each visitor had spent their own keyless
  // budget. What fixes that is the edge cache on the same-origin proxy, and a
  // silent revert to the direct host would restore the bug while every other
  // assertion in this file kept passing — the mock answers any URL.
  it('reads same-origin through the cached proxy, never the upstream host directly', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => BAYLA_POOL } as Response);
    vi.stubGlobal('fetch', spy);
    renderHook(() => usePoolMarket('solana', 'PoolIdHere'));
    await waitFor(() => expect(spy).toHaveBeenCalled());

    const url = String(spy.mock.calls[0]![0]);
    expect(url, 'the browser must not spend its own keyless budget on the upstream')
      .not.toContain('api.geckoterminal.com');
    expect(url).toContain('/api/aggregator?resource=pool-market');
    // The pool identity still has to survive the hop, or the strip reads the
    // wrong pool while looking perfectly healthy.
    expect(url).toContain('network=solana');
    expect(url).toContain('pool=PoolIdHere');
  });

  it('reads the live pool figures', async () => {
    const { result } = renderHook(() => usePoolMarket('solana', 'pool'));
    await waitFor(() => expect(result.current.market).toBeTruthy());
    const m = result.current.market!;
    expect(m.priceUsd).toBeCloseTo(0.00056294, 8);
    expect(m.fdvUsd).toBeCloseTo(559278.39, 1);
    expect(m.liquidityUsd).toBeCloseTo(67300.27, 1);
    expect(m.volume24hUsd).toBeCloseTo(10084.09, 1);
    expect(m.change24hPct).toBeCloseTo(0.156, 3);
    expect(m.buys24h).toBe(110);
    expect(m.sells24h).toBe(91);
  });

  it('keeps an absent market cap NULL instead of substituting FDV', async () => {
    const { result } = renderHook(() => usePoolMarket('solana', 'pool'));
    await waitFor(() => expect(result.current.market).toBeTruthy());
    expect(result.current.market!.marketCapUsd).toBeNull();
    // …and FDV is still there, so the caller has something honest to label.
    expect(result.current.market!.fdvUsd).not.toBeNull();
  });

  it('keeps a negative 24h change negative', async () => {
    vi.stubGlobal('fetch', mockFetch({
      data: { attributes: { ...BAYLA_POOL.data.attributes, price_change_percentage: { h24: '-12.5' } } },
    }));
    const { result } = renderHook(() => usePoolMarket('solana', 'pool'));
    await waitFor(() => expect(result.current.market).toBeTruthy());
    expect(result.current.market!.change24hPct).toBeCloseTo(-12.5);
  });

  it('distinguishes a real zero from an unread field', async () => {
    vi.stubGlobal('fetch', mockFetch({
      data: {
        attributes: {
          name: 'QUIET / SOL',
          base_token_price_usd: '0.5',
          volume_usd: { h24: '0' },   // a real zero: nobody traded
          // reserve_in_usd absent entirely: not read
        },
      },
    }));
    const { result } = renderHook(() => usePoolMarket('solana', 'pool'));
    await waitFor(() => expect(result.current.market).toBeTruthy());
    expect(result.current.market!.volume24hUsd, 'a traded-nothing day is 0').toBe(0);
    expect(result.current.market!.liquidityUsd, 'an absent field is null, not 0').toBeNull();
  });

  it('reports a failed read as an outage', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false));
    const { result } = renderHook(() => usePoolMarket('solana', 'pool'));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toMatch(/outage/i);
  });

  it('issues nothing when the bungalow declares no pool', () => {
    const spy = mockFetch(BAYLA_POOL);
    vi.stubGlobal('fetch', spy);
    renderHook(() => usePoolMarket(null, null));
    expect(spy).not.toHaveBeenCalled();
  });
});

// 2026-10-15: "leave the previous values alone on a failed read" was written for
// a refresh of the SAME pool. A visitor clicking through bungalows reuses this
// hook with a new pool, and a refused read then left the last bungalow's price
// under the next one's ticker.
describe('usePoolMarket across a pool switch', () => {
  it('never shows the previous pool\'s figures under the next pool', async () => {
    const { result, rerender } = renderHook(({ pool }) => usePoolMarket('solana', pool), {
      initialProps: { pool: 'poolA' },
    });
    await waitFor(() => expect(result.current.market).toBeTruthy());

    vi.stubGlobal('fetch', mockFetch({}, false));
    rerender({ pool: 'poolB' });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.market, 'pool A\'s price under pool B\'s ticker').toBeNull();
  });

  it('keeps the same pool\'s figures through a failed refresh', async () => {
    const { result } = renderHook(() => usePoolMarket('solana', 'pool'));
    await waitFor(() => expect(result.current.market).toBeTruthy());
    vi.stubGlobal('fetch', mockFetch({}, false));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.market).not.toBeNull();
  });

  it('asks for a kept copy, passes its age through, and calls a refusal busy', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-Gecko-Fetched-At': '1792000000000', 'X-Gecko-Stale': '1' }),
      json: async () => BAYLA_POOL,
    } as unknown as Response);
    vi.stubGlobal('fetch', spy);
    const { result } = renderHook(() => usePoolMarket('solana', 'pool'));
    await waitFor(() => expect(result.current.market).toBeTruthy());
    expect(new Headers((spy.mock.calls[0] as [string, RequestInit])[1].headers).get('X-Gecko-Stale-Ok')).toBe('1');
    expect(result.current.freshness).toEqual({ fetchedAt: 1_792_000_000_000, stale: true });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) } as Response));
    const busy = renderHook(() => usePoolMarket('solana', 'other'));
    await waitFor(() => expect(busy.result.current.error).toBeTruthy());
    expect(busy.result.current.error).toMatch(/busy/i);
  });
});
