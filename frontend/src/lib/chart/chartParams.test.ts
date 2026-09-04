import { describe, it, expect } from 'vitest';
import { TOWELI_MARKET } from './market';
import { chartableMarkets } from './markets';
import { resolveChartParams } from './chartParams';

// Everything here arrives from a URL somebody else wrote. The property under
// test is that a bad value is REFUSED VISIBLY and replaced with a registry
// object — never coerced silently, and never carried forward as a string that
// could reach an outbound URL.

const NONE = { network: null, pool: null, tf: null };

describe('resolveChartParams with no parameters', () => {
  it('lands on the venue\'s own pool at the default frame, quietly', () => {
    const out = resolveChartParams(NONE);
    expect(out.market?.pool).toBe(TOWELI_MARKET.pool);
    expect(out.timeframe).toBe('1h');
    // An empty URL is not a refusal. Mutation: push a refusal for an absent
    // parameter and every first visit opens with an amber warning.
    expect(out.refusals).toEqual([]);
  });
});

describe('?network=', () => {
  it('accepts exactly the three slugs the source offers', () => {
    for (const network of ['eth', 'base', 'solana'] as const) {
      const out = resolveChartParams({ ...NONE, network });
      expect(out.market?.network).toBe(network);
      expect(out.refusals).toEqual([]);
    }
  });

  it('refuses anything else on screen instead of coercing it', () => {
    // 'ethereum' is this app's own word for the chain everywhere else, and it
    // is NOT GeckoTerminal's slug — the most likely wrong value, and one that
    // 404s silently if it ever reaches a URL.
    for (const network of ['ethereum', 'ETH', 'polygon', '../../', '']) {
      const out = resolveChartParams({ ...NONE, network });
      // Empty string is treated as absent; everything else must be refused.
      if (network === '') {
        expect(out.refusals).toEqual([]);
      } else {
        expect(out.refusals.map((r) => r.param)).toContain('network');
        expect(out.refusals[0]?.message).toContain('does not offer');
      }
      // Whatever happened, what came out is a registry market on a real slug.
      expect(['eth', 'base', 'solana']).toContain(out.market?.network);
    }
  });

  it('never echoes the refused value back into the page', () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const out = resolveChartParams({ ...NONE, network: hostile });
    // Mutation: interpolate the caller's string into the sentence and the
    // refusal becomes the delivery mechanism for whatever was in the URL.
    for (const refusal of out.refusals) expect(refusal.message).not.toContain(hostile);
  });
});

describe('?pool=', () => {
  const solana = chartableMarkets().find((m) => m.network === 'solana')!;

  it('accepts a registry pool on its own network', () => {
    const out = resolveChartParams({ network: 'solana', pool: solana.pool, tf: null });
    expect(out.market?.pool).toBe(solana.pool);
    expect(out.refusals).toEqual([]);
  });

  it('refuses a pool this page does not list, and falls back to a market on the SAME network', () => {
    const out = resolveChartParams({
      network: 'base',
      pool: '0x1111111111111111111111111111111111111111',
      tf: null,
    });
    expect(out.refusals.map((r) => r.param)).toEqual(['pool']);
    expect(out.refusals[0]?.message).toContain('does not list');
    // Mutation: fall back to TOWELI regardless of network and a Base link opens
    // an Ethereum pool under a Base heading.
    expect(out.market?.network).toBe('base');
  });

  it('turns a traversal-shaped pool into no market at all — there is nothing to build a URL from', () => {
    for (const pool of ['../../search/pools', '..%2F..%2Fsearch', 'x?query=y', '  ']) {
      const out = resolveChartParams({ network: 'eth', pool, tf: null });
      // The value never survives: what comes out is a registry object whose pool
      // is one of the known strings, so `ohlcvUrlFor` can only ever be handed a
      // pool the registry named.
      const known = chartableMarkets().map((m) => m.pool);
      expect(known).toContain(out.market?.pool);
      expect(out.market?.pool).not.toBe(pool);
    }
  });

  it('refuses a real pool asked for on the wrong network', () => {
    // A Solana mint under ?network=eth. Mutation: match on the pool alone and
    // the page would build an /networks/eth/pools/<solana-account> URL.
    const out = resolveChartParams({ network: 'eth', pool: solana.pool, tf: null });
    expect(out.refusals.map((r) => r.param)).toEqual(['pool']);
    expect(out.market?.network).toBe('eth');
  });
});

describe('?tf=', () => {
  it('accepts each offered frame', () => {
    for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
      expect(resolveChartParams({ ...NONE, tf }).timeframe).toBe(tf);
    }
  });

  it('says so when it falls back, rather than coercing silently', () => {
    const out = resolveChartParams({ ...NONE, tf: '1w' });
    expect(out.timeframe).toBe('1h');
    // Mutation: drop the refusal and a ?tf=1w link shows hourly candles under a
    // heading the reader believes is weekly.
    expect(out.refusals.map((r) => r.param)).toEqual(['tf']);
    expect(out.refusals[0]?.message).toContain('does not offer');
  });
});

describe('several bad parameters at once', () => {
  it('reports every one of them', () => {
    const out = resolveChartParams({ network: 'polygon', pool: '../../etc/passwd', tf: '1w' });
    expect(out.refusals.map((r) => r.param).sort()).toEqual(['network', 'pool', 'tf']);
    expect(out.market?.pool).toBe(TOWELI_MARKET.pool);
    expect(out.timeframe).toBe('1h');
  });
});
