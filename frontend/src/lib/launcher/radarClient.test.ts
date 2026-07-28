import { describe, it, expect, vi } from 'vitest';
import { coerceRadar, fetchLaunchRadar, LAUNCH_RADAR_ENDPOINT } from './radarClient';

// A minimal GeckoTerminal `new_pools` fixture (JSON:API shape). Values are chosen so
// the derived ETH liquidity is checkable by hand: usdPerEth = baseUsd / priceEth
// = 3 / 0.001 = 3000, so reserve 6000 USD => 2 ETH.
const entry = (token: string, over: Record<string, unknown> = {}) => ({
  id: `eth_0xpool${token.slice(-2)}`,
  attributes: {
    address: `0xpo0l${'0'.repeat(33)}${token.slice(-2)}`,
    name: `TKN${token.slice(-2)} / WETH`,
    base_token_price_native_currency: '0.001',
    base_token_price_usd: '3',
    reserve_in_usd: '6000',
    pool_created_at: '2026-07-27T00:00:00Z',
    ...over,
  },
  relationships: { base_token: { data: { id: `eth_${token}` } } },
});

const TOKEN_A = '0x00000000000000000000000000000000000000aa';
const TOKEN_B = '0x00000000000000000000000000000000000000bb';

describe('coerceRadar — market-wide new-pool normalisation', () => {
  it('maps entries, derives ETH price/liquidity, and carries the display name', () => {
    const r = coerceRadar({ data: [entry(TOKEN_A)], observedAt: 1_700_000_000 }, 12);
    expect(r.observedAt).toBe(1_700_000_000);
    expect(r.entries).toHaveLength(1);
    const [e] = r.entries;
    expect(e.token).toBe(TOKEN_A);
    expect(e.priceEth).toBeCloseTo(0.001);
    expect(e.liquidityEth).toBeCloseTo(2); // 6000 USD / (3/0.001 USD per ETH)
    expect(e.name).toBe('TKNaa / WETH');
    expect(e.launchedAt).toBeGreaterThan(0);
  });

  it('respects the display limit and stays distinct by token', () => {
    const data = [entry(TOKEN_A), entry(TOKEN_B), entry(TOKEN_A)]; // dup A
    expect(coerceRadar({ data }, 12).entries.map((e) => e.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(coerceRadar({ data }, 1).entries).toHaveLength(1);
    expect(coerceRadar({ data }, 0).entries).toHaveLength(0);
  });

  it('NEVER fabricates numbers: unparseable price/liquidity collapse to 0, bad time to 0', () => {
    const r = coerceRadar(
      { data: [entry(TOKEN_A, { base_token_price_native_currency: 'not-a-number', reserve_in_usd: null, pool_created_at: 'nonsense' })] },
      12,
    );
    // The row survives (it is still a real pool) but every unmeasurable field reads 0,
    // which the UI renders as "—" rather than inventing a price.
    expect(r.entries[0].priceEth).toBe(0);
    expect(r.entries[0].liquidityEth).toBe(0);
    expect(r.entries[0].launchedAt).toBe(0);
  });

  it('tolerates hostile/missing bodies instead of throwing', () => {
    for (const bad of [null, undefined, {}, { data: 'nope' }, { data: [null, 42, {}] }]) {
      expect(() => coerceRadar(bad, 12)).not.toThrow();
      expect(coerceRadar(bad, 12).entries).toEqual([]);
    }
    expect(coerceRadar({ data: [] }, 12).observedAt).toBe(0);
  });

  // DOCTRINE PIN: the radar is market-wide and must stay structurally separate from
  // the Tegridy cohort ledger. Its entries carry NO tier and NO creator, so they can
  // never be mistaken for (or silently promoted into) a "launched on our rail" record.
  it('carries no tier/creator — it cannot masquerade as a Tegridy-rail launch', () => {
    const [e] = coerceRadar({ data: [entry(TOKEN_A)] }, 12).entries;
    expect(e).not.toHaveProperty('tier');
    expect(e).not.toHaveProperty('creator');
  });
});

describe('fetchLaunchRadar', () => {
  it('GETs the catchall resource route and returns typed entries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [entry(TOKEN_A)], observedAt: 5 }),
    }) as unknown as typeof fetch;
    const r = await fetchLaunchRadar({ fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(LAUNCH_RADAR_ENDPOINT);
    expect(r.entries[0].token).toBe(TOKEN_A);
    expect(r.observedAt).toBe(5);
  });

  it('throws on non-2xx so the caller can degrade to an honest empty state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch;
    await expect(fetchLaunchRadar({ fetchImpl })).rejects.toThrow(/502/);
  });
});
