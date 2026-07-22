import { describe, it, expect } from 'vitest';
import { mapNewPoolsToBaselines, type GeckoPoolEntry } from './discovery';

// A token / pool address pair in GeckoTerminal's network-prefixed form.
const TOKEN_A = '0x00000000000000000000000000000000000000aa';
const POOL_A = '0x00000000000000000000000000000000000000f1';
const TOKEN_B = '0x00000000000000000000000000000000000000bb';
const POOL_B = '0x00000000000000000000000000000000000000f2';

/**
 * A realistic GeckoTerminal `new_pools` entry. Numbers here reproduce the
 * adapter's ETH derivation: price_native = 0.0005 ETH/token, base_usd = $1.50,
 * so usdPerEth = 1.5 / 0.0005 = $3000/ETH, and reserve $30,000 → 10 ETH.
 */
function poolEntry(overrides: Partial<{
  poolId: string;
  poolAddress: string;
  tokenId: string;
  attrs: Record<string, unknown>;
  dexId: string;
}> = {}): GeckoPoolEntry {
  const {
    poolId = `eth_${POOL_A}`,
    poolAddress = POOL_A,
    tokenId = `eth_${TOKEN_A}`,
    dexId = 'uniswap_v4',
    attrs = {},
  } = overrides;
  return {
    id: poolId,
    type: 'pool',
    attributes: {
      address: poolAddress,
      name: 'TKN / WETH',
      pool_created_at: '2026-07-01T12:00:00Z',
      base_token_price_native_currency: '0.0005',
      base_token_price_usd: '1.5',
      reserve_in_usd: '30000',
      transactions: { h24: { buyers: 42 } },
      ...attrs,
    },
    relationships: {
      base_token: { data: { id: tokenId, type: 'token' } },
      quote_token: { data: { id: 'eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', type: 'token' } },
      dex: { data: { id: dexId, type: 'dex' } },
    },
  };
}

describe('mapNewPoolsToBaselines', () => {
  it('maps a new_pools response to baselines + poolByToken', () => {
    const res = { data: [poolEntry()] };
    const { baselines, poolByToken } = mapNewPoolsToBaselines(res);

    expect(baselines).toHaveLength(1);
    const b = baselines[0]!;
    expect(b.token).toBe(TOKEN_A); // lowercased, prefix stripped
    expect(b.tier).toBe('none'); // unknown at discovery
    expect(b.creator).toBeNull(); // not exposed by new_pools
    expect(b.launchedAt).toBe(Math.floor(Date.parse('2026-07-01T12:00:00Z') / 1000));
    expect(b.launchPriceEth).toBeCloseTo(0.0005, 12);
    // reserve $30,000 / ($3000/ETH) = 10 ETH — same derivation as the adapter.
    expect(b.launchLiquidityEth).toBeCloseTo(10, 9);

    expect(poolByToken[TOKEN_A]).toBe(POOL_A);
  });

  it('accepts a bare data array (not just { data })', () => {
    const { baselines } = mapNewPoolsToBaselines([poolEntry()]);
    expect(baselines).toHaveLength(1);
  });

  it('strips the network prefix and lowercases addresses', () => {
    const res = {
      data: [
        poolEntry({
          tokenId: 'eth_0x00000000000000000000000000000000000000AA',
          poolAddress: '0x00000000000000000000000000000000000000F1',
        }),
      ],
    };
    const { baselines, poolByToken } = mapNewPoolsToBaselines(res);
    expect(baselines[0]!.token).toBe(TOKEN_A);
    expect(poolByToken[TOKEN_A]).toBe(POOL_A);
  });

  it('dedupes by base token, keeping the first (newest) pool', () => {
    const res = {
      data: [
        poolEntry({ poolId: `eth_${POOL_A}`, poolAddress: POOL_A }), // newest
        poolEntry({ poolId: `eth_${POOL_B}`, poolAddress: POOL_B }), // older, same token
      ],
    };
    const { baselines, poolByToken } = mapNewPoolsToBaselines(res);
    expect(baselines).toHaveLength(1);
    expect(poolByToken[TOKEN_A]).toBe(POOL_A);
  });

  it('drops entries without a well-formed base token address', () => {
    const res = {
      data: [
        poolEntry({ tokenId: 'eth_not-an-address' }),
        { id: `eth_${POOL_A}`, attributes: {}, relationships: {} }, // no base_token at all
        poolEntry({ tokenId: `eth_${TOKEN_B}`, poolId: `eth_${POOL_B}`, poolAddress: POOL_B }),
      ],
    };
    const { baselines } = mapNewPoolsToBaselines(res);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.token).toBe(TOKEN_B);
  });

  it('degrades hostile/missing numbers to 0 without throwing', () => {
    const res = {
      data: [
        poolEntry({
          attrs: {
            base_token_price_native_currency: 'not-a-number',
            reserve_in_usd: null,
            base_token_price_usd: undefined,
            pool_created_at: 'garbage',
          },
        }),
      ],
    };
    const { baselines } = mapNewPoolsToBaselines(res);
    const b = baselines[0]!;
    expect(b.launchPriceEth).toBe(0);
    expect(b.launchLiquidityEth).toBe(0);
    expect(b.launchedAt).toBe(0);
  });

  it('never emits negative price or liquidity', () => {
    const res = {
      data: [
        poolEntry({
          attrs: { base_token_price_native_currency: '-0.001', reserve_in_usd: '30000', base_token_price_usd: '-1.5' },
        }),
      ],
    };
    const b = mapNewPoolsToBaselines(res).baselines[0]!;
    expect(b.launchPriceEth).toBe(0);
    expect(b.launchLiquidityEth).toBe(0);
  });

  it('accepts a numeric pool_created_at (already unix seconds)', () => {
    const res = { data: [poolEntry({ attrs: { pool_created_at: 1_800_000_000 } })] };
    expect(mapNewPoolsToBaselines(res).baselines[0]!.launchedAt).toBe(1_800_000_000);
  });

  it('includes a baseline even when the pool address is unusable (poolByToken omits it)', () => {
    const res = {
      data: [poolEntry({ poolId: 'eth_bad', poolAddress: 'nope' })],
    };
    const { baselines, poolByToken } = mapNewPoolsToBaselines(res);
    expect(baselines).toHaveLength(1); // enrichment can still resolve token→deepest pool
    expect(poolByToken[TOKEN_A]).toBeUndefined();
  });

  it('applies an optional factory/integrator filter over raw entries', () => {
    const res = {
      data: [
        poolEntry({ tokenId: `eth_${TOKEN_A}`, dexId: 'uniswap_v4' }),
        poolEntry({ tokenId: `eth_${TOKEN_B}`, poolId: `eth_${POOL_B}`, poolAddress: POOL_B, dexId: 'sushiswap' }),
      ],
    };
    const keepV4 = (p: GeckoPoolEntry) => {
      const dex = (p.relationships as { dex?: { data?: { id?: unknown } } } | undefined)?.dex?.data?.id;
      return dex === 'uniswap_v4';
    };
    const { baselines } = mapNewPoolsToBaselines(res, { filter: keepV4 });
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.token).toBe(TOKEN_A);
  });

  it('handles empty / malformed responses safely', () => {
    expect(mapNewPoolsToBaselines(null)).toEqual({ baselines: [], poolByToken: {} });
    expect(mapNewPoolsToBaselines(undefined)).toEqual({ baselines: [], poolByToken: {} });
    expect(mapNewPoolsToBaselines({})).toEqual({ baselines: [], poolByToken: {} });
    expect(mapNewPoolsToBaselines({ data: 'nope' } as never)).toEqual({ baselines: [], poolByToken: {} });
    expect(mapNewPoolsToBaselines({ data: [null, 7, 'x'] } as never)).toEqual({
      baselines: [],
      poolByToken: {},
    });
  });

  it('produces token keys usable as poolByToken (lowercased) for the adapter', () => {
    const { poolByToken } = mapNewPoolsToBaselines({ data: [poolEntry()] });
    // The enrichment adapter looks up poolByToken[String(token).toLowerCase()].
    for (const key of Object.keys(poolByToken)) {
      expect(key).toBe(key.toLowerCase());
      expect(key).toMatch(/^0x[a-f0-9]{40}$/);
    }
  });
});
