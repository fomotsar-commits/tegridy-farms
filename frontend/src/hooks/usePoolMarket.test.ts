// The market strip's contract: an unread figure stays null so the UI can print
// "—", and a real zero stays 0. Collapsing the two is the exact failure the
// venue's staking-look doc exists to prevent — a dry pool that reads as a
// number nobody funded.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
