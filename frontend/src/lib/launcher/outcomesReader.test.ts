import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  buildOutcomeRecord,
  buildLaunchSummary,
  buildOutcomeRecords,
  buildLaunchSummaries,
  type LauncherDataFetcher,
  type LaunchBaseline,
  type TokenMarket,
  type TokenChainStats,
} from './outcomesReader';
import { deriveOutcomeFlags, priceReturn } from './outcomes';
import { orderLaunches, defaultOrderingConfig } from './ordering';

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address;
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address;
const CREATOR = '0x00000000000000000000000000000000000000cc' as Address;

const NOW = 1_800_000_000; // fixed observation time
const DAY = 86_400;

function baseline(overrides: Partial<LaunchBaseline> = {}): LaunchBaseline {
  return {
    token: TOKEN_A,
    tier: 'flagship',
    creator: CREATOR,
    launchedAt: NOW - 5 * DAY,
    launchPriceEth: 0.001,
    launchLiquidityEth: 10,
    ...overrides,
  };
}

/** A configurable mock fetcher recording calls. */
function mockFetcher(opts: {
  market?: TokenMarket | null;
  chain?: TokenChainStats | null;
  throwMarket?: boolean;
  throwChain?: boolean;
}): LauncherDataFetcher & { marketCalls: Address[]; chainCalls: Array<[Address, Address | null]> } {
  const marketCalls: Address[] = [];
  const chainCalls: Array<[Address, Address | null]> = [];
  return {
    marketCalls,
    chainCalls,
    async fetchMarket(token) {
      marketCalls.push(token);
      if (opts.throwMarket) throw new Error('gecko down');
      return opts.market === undefined ? null : opts.market;
    },
    async fetchChainStats(token, creator) {
      chainCalls.push([token, creator]);
      if (opts.throwChain) throw new Error('etherscan rate limit');
      return opts.chain === undefined ? null : opts.chain;
    },
  };
}

describe('buildOutcomeRecord', () => {
  it('assembles a full OutcomeRecord from baseline + live reads', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.002, liquidityEth: 12, uniqueBuyers24h: 40, feeRevenueEth24h: 0.3 },
      chain: { holderCount: 500, lastTeamActivityAt: NOW - DAY },
    });
    const rec = await buildOutcomeRecord(baseline(), f, NOW);

    expect(rec.token).toBe(TOKEN_A);
    expect(rec.tier).toBe('flagship');
    expect(rec.observedAt).toBe(NOW);
    expect(rec.launchedAt).toBe(NOW - 5 * DAY);
    expect(rec.priceEth).toBe(0.002);
    expect(rec.launchPriceEth).toBe(0.001);
    expect(rec.liquidityEth).toBe(12);
    expect(rec.launchLiquidityEth).toBe(10);
    expect(rec.holderCount).toBe(500);
    expect(rec.lastTeamActivityAt).toBe(NOW - DAY);
    expect(rec.unlocks).toEqual([]);

    // fetcher was invoked with the right args
    expect(f.marketCalls).toEqual([TOKEN_A]);
    expect(f.chainCalls).toEqual([[TOKEN_A, CREATOR]]);
  });

  it('carries through disclosed unlock schedule', async () => {
    const unlocks = [{ at: NOW - DAY, amountBps: 1000, soldWithinWindow: true }];
    const f = mockFetcher({
      market: { priceEth: 0.001, liquidityEth: 10, uniqueBuyers24h: 1, feeRevenueEth24h: 0 },
      chain: { holderCount: 10, lastTeamActivityAt: NOW },
    });
    const rec = await buildOutcomeRecord(baseline({ unlocks }), f, NOW);
    expect(rec.unlocks).toEqual(unlocks);
  });

  it('mirrors baseline (no fabricated crash/drain) when the market is UNOBSERVED', async () => {
    const f = mockFetcher({ market: null, chain: null });
    const rec = await buildOutcomeRecord(baseline(), f, NOW);

    expect(rec.marketObserved).toBe(false);
    // unobserved => mirror the baseline so no false -100%/drain signal is derived
    expect(rec.priceEth).toBe(0.001);
    expect(rec.liquidityEth).toBe(10);
    expect(rec.holderCount).toBe(0); // unknown holder count collapses to 0 for the required field
    expect(rec.lastTeamActivityAt).toBeNull(); // unknown activity stays null (not fabricated)
    expect(rec.launchPriceEth).toBe(0.001);
    expect(rec.launchLiquidityEth).toBe(10);
    // and the derived signals stay clean
    expect(deriveOutcomeFlags(rec).liquidityDrained).toBe(false);
    expect(priceReturn(rec)).toBe(0);
  });

  it('mirrors baseline when fetchers THROW (rejection swallowed, marketObserved=false)', async () => {
    const f = mockFetcher({ throwMarket: true, throwChain: true });
    const rec = await buildOutcomeRecord(baseline(), f, NOW);
    expect(rec.marketObserved).toBe(false);
    expect(rec.priceEth).toBe(0.001);
    expect(rec.liquidityEth).toBe(10);
    expect(rec.holderCount).toBe(0);
    expect(rec.lastTeamActivityAt).toBeNull();
  });

  it('sanitizes hostile/negative values on an OBSERVED market (both required fields finite)', async () => {
    const f = mockFetcher({
      market: { priceEth: -5, liquidityEth: -3, uniqueBuyers24h: -3, feeRevenueEth24h: Infinity },
      chain: { holderCount: -1, lastTeamActivityAt: -99 },
    });
    const rec = await buildOutcomeRecord(baseline(), f, NOW);
    expect(rec.marketObserved).toBe(true); // price + liquidity are finite (if hostile) -> observed
    expect(rec.priceEth).toBe(0);
    expect(rec.liquidityEth).toBe(0);
    expect(rec.holderCount).toBe(0);
    expect(rec.lastTeamActivityAt).toBe(0);
  });

  it('a PARTIAL market (a required field non-finite) is UNOBSERVED, not a fabricated drain', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.002, liquidityEth: Number.NaN, uniqueBuyers24h: 5, feeRevenueEth24h: 0.1 },
      chain: null,
    });
    const rec = await buildOutcomeRecord(baseline({ launchLiquidityEth: 10 }), f, NOW);
    expect(rec.marketObserved).toBe(false); // NaN liquidity => not observed
    expect(rec.liquidityEth).toBe(10); // mirrors baseline -> no false drain
    expect(deriveOutcomeFlags(rec).liquidityDrained).toBe(false);
  });

  it('preserves null holder count vs zero distinction at the chain layer but fills 0 in record', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.001, liquidityEth: 10, uniqueBuyers24h: 5, feeRevenueEth24h: 0.1 },
      chain: { holderCount: null, lastTeamActivityAt: NOW - 40 * DAY },
    });
    const rec = await buildOutcomeRecord(baseline(), f, NOW);
    expect(rec.holderCount).toBe(0);
    expect(rec.lastTeamActivityAt).toBe(NOW - 40 * DAY);
  });
});

describe('integration with outcomes.ts helpers', () => {
  it('a drained + dumped + abandoned record derives the expected disclosed flags', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.0002, liquidityEth: 2, uniqueBuyers24h: 0, feeRevenueEth24h: 0 },
      chain: { holderCount: 30, lastTeamActivityAt: NOW - 40 * DAY },
    });
    const rec = await buildOutcomeRecord(
      baseline({
        launchLiquidityEth: 10,
        launchPriceEth: 0.001,
        unlocks: [{ at: NOW - 2 * DAY, amountBps: 2000, soldWithinWindow: true }],
      }),
      f,
      NOW,
    );

    const flags = deriveOutcomeFlags(rec);
    expect(flags.liquidityDrained).toBe(true); // 2 < 10 * 0.5
    expect(flags.unlockDumped).toBe(true);
    expect(flags.likelyAbandoned).toBe(true); // 40d > 30d default
    expect(flags.disclosures.length).toBeGreaterThanOrEqual(3);

    // priceReturn: 0.0002 / 0.001 - 1 = -0.8
    expect(priceReturn(rec)).toBeCloseTo(-0.8, 10);
  });

  it('a healthy record derives no adverse flags', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.003, liquidityEth: 15, uniqueBuyers24h: 60, feeRevenueEth24h: 0.5 },
      chain: { holderCount: 900, lastTeamActivityAt: NOW - DAY },
    });
    const rec = await buildOutcomeRecord(baseline(), f, NOW);
    const flags = deriveOutcomeFlags(rec);
    expect(flags.liquidityDrained).toBe(false);
    expect(flags.unlockDumped).toBe(false);
    expect(flags.likelyAbandoned).toBe(false);
    expect(flags.disclosures).toEqual(['No adverse outcome signals recorded at this observation.']);
    expect(priceReturn(rec)).toBeCloseTo(2, 10); // tripled
  });

  it('an UNOBSERVED market does not fabricate a liquidity-drain flag (disclosure integrity)', async () => {
    // launchLiquidityEth known, live market unobservable. Collapsing to 0 would
    // fabricate a 100% drain for a healthy launch — instead we mirror the baseline.
    const f = mockFetcher({ market: null, chain: null });
    const rec = await buildOutcomeRecord(baseline({ launchLiquidityEth: 10 }), f, NOW);
    expect(rec.marketObserved).toBe(false);
    expect(deriveOutcomeFlags(rec).liquidityDrained).toBe(false);
    expect(priceReturn(rec)).toBe(0);
  });

  it('an OBSERVED near-zero liquidity DOES flag a real drain', async () => {
    // market observed (non-null) with a genuine collapse => the flag is correct.
    const f = mockFetcher({
      market: { priceEth: 0.0001, liquidityEth: 1, uniqueBuyers24h: 0, feeRevenueEth24h: 0 },
      chain: null,
    });
    const rec = await buildOutcomeRecord(baseline({ launchLiquidityEth: 10 }), f, NOW);
    expect(rec.marketObserved).toBe(true);
    expect(deriveOutcomeFlags(rec).liquidityDrained).toBe(true); // 1 < 10*0.5, genuinely observed
  });
});

describe('buildLaunchSummary + ordering integration', () => {
  it('maps baseline + market into a LaunchSummary (no pay-to-rank field exists)', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.002, liquidityEth: 12, uniqueBuyers24h: 40, feeRevenueEth24h: 0.3 },
      chain: { holderCount: 500, lastTeamActivityAt: NOW - DAY },
    });
    const s = await buildLaunchSummary(baseline(), f);
    expect(s).not.toBeNull();
    expect(s).toEqual({
      token: TOKEN_A,
      tier: 'flagship',
      launchedAt: NOW - 5 * DAY,
      uniqueBuyers24h: 40,
      liquidityEth: 12,
      feeRevenueEth24h: 0.3,
      holderCount: 500,
    });
    // structural: summary has no boost/promoted/paid key
    expect(Object.keys(s!).sort()).toEqual(
      ['feeRevenueEth24h', 'holderCount', 'launchedAt', 'liquidityEth', 'tier', 'token', 'uniqueBuyers24h'].sort(),
    );
  });

  it('floors uniqueBuyers24h to an integer', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.002, liquidityEth: 12, uniqueBuyers24h: 40.9, feeRevenueEth24h: 0.3 },
      chain: { holderCount: 500, lastTeamActivityAt: NOW - DAY },
    });
    const s = await buildLaunchSummary(baseline(), f);
    expect(s!.uniqueBuyers24h).toBe(40);
  });

  it('built summaries feed orderLaunches deterministically', async () => {
    const fA = mockFetcher({
      market: { priceEth: 0.002, liquidityEth: 20, uniqueBuyers24h: 100, feeRevenueEth24h: 1 },
      chain: { holderCount: 1000, lastTeamActivityAt: NOW - DAY },
    });
    const fB = mockFetcher({
      market: { priceEth: 0.001, liquidityEth: 1, uniqueBuyers24h: 2, feeRevenueEth24h: 0 },
      chain: { holderCount: 20, lastTeamActivityAt: NOW - DAY },
    });
    const sA = (await buildLaunchSummary(baseline({ token: TOKEN_A, tier: 'flagship' }), fA))!;
    const sB = (await buildLaunchSummary(baseline({ token: TOKEN_B, tier: 'listable' }), fB))!;

    const ranked = orderLaunches([sB, sA], defaultOrderingConfig(NOW));
    expect(ranked.map((r) => r.summary.token)).toEqual([TOKEN_A, TOKEN_B]); // flagship + activity wins
  });

  it('returns null for an UNOBSERVED market (kept out of ranking, not deranked to zero)', async () => {
    const f = mockFetcher({ market: null, chain: null });
    const s = await buildLaunchSummary(baseline({ tier: 'listable' }), f);
    expect(s).toBeNull();
  });
});

describe('batch builders', () => {
  it('buildOutcomeRecords enriches a consumed list independently', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.001, liquidityEth: 10, uniqueBuyers24h: 5, feeRevenueEth24h: 0.1 },
      chain: { holderCount: 100, lastTeamActivityAt: NOW - DAY },
    });
    const recs = await buildOutcomeRecords(
      [baseline({ token: TOKEN_A }), baseline({ token: TOKEN_B })],
      f,
      NOW,
    );
    expect(recs.map((r) => r.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(f.marketCalls).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('buildLaunchSummaries maps a whole list', async () => {
    const f = mockFetcher({
      market: { priceEth: 0.001, liquidityEth: 10, uniqueBuyers24h: 5, feeRevenueEth24h: 0.1 },
      chain: { holderCount: 100, lastTeamActivityAt: NOW - DAY },
    });
    const summaries = await buildLaunchSummaries(
      [baseline({ token: TOKEN_A }), baseline({ token: TOKEN_B })],
      f,
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.liquidityEth === 10)).toBe(true);
  });

  it('buildLaunchSummaries filters out unobserved launches (no false deranking)', async () => {
    const f = mockFetcher({ market: null, chain: null });
    const summaries = await buildLaunchSummaries(
      [baseline({ token: TOKEN_A }), baseline({ token: TOKEN_B })],
      f,
    );
    expect(summaries).toEqual([]);
  });

  it('one launch failing does not abort the batch', async () => {
    // fetcher throws for every call, but each record still degrades independently
    const f = mockFetcher({ throwMarket: true, throwChain: true });
    const recs = await buildOutcomeRecords(
      [baseline({ token: TOKEN_A }), baseline({ token: TOKEN_B })],
      f,
      NOW,
    );
    expect(recs).toHaveLength(2);
    // each degrades to unobserved (mirrors baseline price 0.001, not a fabricated 0)
    expect(recs.every((r) => r.marketObserved === false)).toBe(true);
    expect(recs.every((r) => r.priceEth === 0.001)).toBe(true);
  });
});
