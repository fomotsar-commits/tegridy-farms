import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { orderLaunches, scoreLaunch, defaultOrderingConfig, type LaunchSummary } from './ordering';

const NOW = 1_800_000_000;
const DAY = 86_400;
const cfg = defaultOrderingConfig(NOW);

function launch(over: Partial<LaunchSummary> & { token: Address }): LaunchSummary {
  return {
    tier: 'flagship',
    launchedAt: NOW - DAY,
    uniqueBuyers24h: 0,
    liquidityEth: 0,
    feeRevenueEth24h: 0,
    holderCount: 0,
    ...over,
  };
}

describe('orderLaunches — structural guarantees', () => {
  it('flagship always outranks listable regardless of activity (published structural rule)', () => {
    const busyListable = launch({ token: '0x01' as Address, tier: 'listable', uniqueBuyers24h: 100_000, liquidityEth: 10_000, feeRevenueEth24h: 100, holderCount: 50_000 });
    const quietFlagship = launch({ token: '0x02' as Address, tier: 'flagship', uniqueBuyers24h: 1 });
    const ranked = orderLaunches([busyListable, quietFlagship], cfg);
    expect(ranked[0].summary.tier).toBe('flagship');
  });

  it('excludes tier "none" launches from the flagship surface entirely', () => {
    const ranked = orderLaunches([launch({ token: '0x03' as Address, tier: 'none', uniqueBuyers24h: 99_999 })], cfg);
    expect(ranked).toHaveLength(0);
  });

  it('is deterministic: same input in any order yields the same ranking', () => {
    const a = launch({ token: '0x0a' as Address, uniqueBuyers24h: 50 });
    const b = launch({ token: '0x0b' as Address, uniqueBuyers24h: 50 });
    const c = launch({ token: '0x0c' as Address, uniqueBuyers24h: 50 });
    const r1 = orderLaunches([a, b, c], cfg).map((x) => x.summary.token);
    const r2 = orderLaunches([c, a, b], cfg).map((x) => x.summary.token);
    expect(r1).toEqual(r2);
  });

  it('breaks exact score ties by token address ascending', () => {
    const hi = launch({ token: '0xff' as Address, uniqueBuyers24h: 10 });
    const lo = launch({ token: '0x01' as Address, uniqueBuyers24h: 10 });
    const ranked = orderLaunches([hi, lo], cfg);
    expect(ranked[0].summary.token).toBe('0x01');
  });
});

describe('scoreLaunch — anti-gaming properties', () => {
  it('activity is log-scaled: 100x the buyers is not 100x the score', () => {
    const small = scoreLaunch(launch({ token: '0x01' as Address, uniqueBuyers24h: 100 }), cfg);
    const huge = scoreLaunch(launch({ token: '0x02' as Address, uniqueBuyers24h: 10_000 }), cfg);
    // 100x buyers => +2 decades of log => a bounded, sub-linear bump, not 100x
    expect(huge.breakdown.activity - small.breakdown.activity).toBeLessThan(10);
  });

  it('activity is capped so it can never dominate the tier ordering', () => {
    const whale = scoreLaunch(launch({ token: '0x01' as Address, uniqueBuyers24h: 1e9, liquidityEth: 1e9, feeRevenueEth24h: 1e9, holderCount: 1e9 }), cfg);
    expect(whale.breakdown.activity).toBeLessThanOrEqual(cfg.activityCap);
  });

  it('recency decays to zero past the window', () => {
    const fresh = scoreLaunch(launch({ token: '0x01' as Address, launchedAt: NOW }), cfg);
    const old = scoreLaunch(launch({ token: '0x02' as Address, launchedAt: NOW - 30 * DAY }), cfg);
    expect(fresh.breakdown.recency).toBeGreaterThan(0);
    expect(old.breakdown.recency).toBe(0);
  });

  it('a fresh flagship outranks an older flagship with equal activity', () => {
    const fresh = launch({ token: '0xaa' as Address, launchedAt: NOW - DAY });
    const old = launch({ token: '0xab' as Address, launchedAt: NOW - 10 * DAY });
    const ranked = orderLaunches([old, fresh], cfg);
    expect(ranked[0].summary.token).toBe('0xaa');
  });
});
