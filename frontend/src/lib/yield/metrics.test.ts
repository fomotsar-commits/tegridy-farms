// The ranking is a CLAIM, and this file holds it to the claim's own standard.
//
// "Best rate" is a statement about a complete comparison. A table that could not
// read three of its eight rows cannot make it, and the difference between "the
// best" and "the best of the five we could read" is the difference between a
// router and an advert.

import { describe, it, expect } from 'vitest';
import {
  PEG_DISCOUNT_FLAG_PCT,
  bestRateClaim,
  isCurrentRead,
  pegAssessment,
  rankByRate,
  type MetricRead,
  type VenueMetrics,
} from './metrics';
import { yieldVenue } from './venues';

const cell = (over: Partial<Extract<MetricRead, { state: 'read' }>> = {}): MetricRead => ({
  state: 'read',
  value: 3,
  unit: 'pct',
  source: 'Aave v3 Pool.getReserveData(USDC).currentLiquidityRate at block 25888268',
  asOf: 1_788_335_951,
  block: 25_888_268,
  stale: false,
  ageSeconds: 0,
  maxAgeS: 3_600,
  ...over,
});

const row = (id: string, rate: MetricRead): VenueMetrics => ({
  venue: yieldVenue(id)!,
  rate,
  nav: cell(),
  market: cell(),
  vsNav: cell({ unit: 'ratio' }),
  exit: cell(),
  block: 25_888_268,
  asOf: 1_788_335_951,
});

describe('a venue nothing could be read for is not ranked at all', () => {
  it('excludes unavailable and not-applicable rows instead of putting them last', () => {
    // "Last" is a position on a leaderboard and carries the claim that the row
    // was measured and lost — which is the fabricated zero this slice refuses.
    const ranking = rankByRate([
      row('aave-v3-usdc', cell({ value: 3.44 })),
      row('lido-steth', { state: 'unavailable', reason: 'no growth rate for stETH' }),
      row('coinbase-cbeth', { state: 'not-applicable', reason: 'published off-chain' }),
    ]);
    expect(ranking.ranked.map((r) => r.venue.id)).toEqual(['aave-v3-usdc']);
    expect(ranking.unranked.map((r) => r.venue.id).sort()).toEqual(['coinbase-cbeth', 'lido-steth']);
    expect(ranking.unreadCount).toBe(2);
    expect(ranking.complete).toBe(false);
  });

  it('ranks descending and keeps a negative rate as a real position', () => {
    const ranking = rankByRate([
      row('renzo-ezeth', cell({ value: -1.65 })),
      row('compound-v3-usdc', cell({ value: 5.64 })),
      row('sky-susds', cell({ value: 3.52 })),
    ]);
    expect(ranking.ranked.map((r) => r.ratePct)).toEqual([5.64, 3.52, -1.65]);
    expect(ranking.best?.venue.id).toBe('compound-v3-usdc');
  });
});

describe('staleness is judged per source, not against one global window', () => {
  it('counts a row stale by its OWN maxAgeS', () => {
    // A Chainlink feed with a 24h heartbeat and a lending rate recomputed every
    // block do not go stale on the same schedule. One window would have called
    // the first broken or the second fresh.
    const ranking = rankByRate([
      row('etherfi-weeth', cell({ value: 2.08, stale: true, ageSeconds: 200_000, maxAgeS: 172_800 })),
      row('aave-v3-usdc', cell({ value: 3.44, stale: false, ageSeconds: 100_000, maxAgeS: 604_800 })),
    ]);
    expect(ranking.staleCount).toBe(1);
    expect(ranking.complete).toBe(false);
  });

  it('isCurrentRead is true only for a fresh read', () => {
    expect(isCurrentRead(cell())).toBe(true);
    expect(isCurrentRead(cell({ stale: true }))).toBe(false);
    expect(isCurrentRead({ state: 'unavailable', reason: 'x' })).toBe(false);
    expect(isCurrentRead({ state: 'not-applicable', reason: 'x' })).toBe(false);
  });
});

describe('rows annualised differently must say so', () => {
  it('flags mixed bases and puts the caveat in the claim', () => {
    // A lending APY and a trailing NAV change are not the same kind of number
    // even though both print as a percent.
    const ranking = rankByRate([
      row('aave-v3-usdc', cell({ value: 3.44, basis: 'supply APR compounded per second' })),
      row('etherfi-weeth', cell({ value: 2.08, basis: 'trailing change in the published rate' })),
    ]);
    expect(ranking.mixedBases).toBe(true);
    expect(bestRateClaim(ranking)).toContain('different bases');
  });

  it('does not add the caveat when every row was annualised the same way', () => {
    const ranking = rankByRate([
      row('aave-v3-usdc', cell({ value: 3.44, basis: 'supply APR compounded per second' })),
      row('compound-v3-usdc', cell({ value: 5.64, basis: 'supply APR compounded per second' })),
    ]);
    expect(ranking.mixedBases).toBe(false);
    expect(bestRateClaim(ranking)).not.toContain('different bases');
  });
});

describe('the best-rate sentence never overstates what was compared', () => {
  it('refuses to rank anything when nothing was read, and says that is not a low rate', () => {
    const claim = bestRateClaim(rankByRate([row('lido-steth', { state: 'unavailable', reason: 'x' })]));
    expect(claim).toMatch(/nothing to rank/);
    expect(claim).toMatch(/not a statement that the rates are low/);
  });

  it('names the count of rows it could not read', () => {
    const claim = bestRateClaim(
      rankByRate([
        row('aave-v3-usdc', cell({ value: 3.44 })),
        row('lido-steth', { state: 'unavailable', reason: 'x' }),
        row('rocketpool-reth', { state: 'unavailable', reason: 'y' }),
      ]),
    );
    expect(claim).toContain('2 venues could not be read');
    expect(claim).toContain('not "the best rate available"');
  });

  it('always states that token incentives are excluded', () => {
    // AAVE / COMP / EIGEN emissions and points are real yield this page does not
    // read. Ranking without saying so would understate every incentivised row.
    for (const rows of [[row('aave-v3-usdc', cell({ value: 3.44 }))], [row('aave-v3-usdc', cell({ value: 3.44 })), row('lido-steth', { state: 'unavailable', reason: 'x' })]]) {
      expect(bestRateClaim(rankByRate(rows))).toContain('Token incentives are excluded');
    }
  });
});

describe('the vs-NAV assessment has three branches and no default', () => {
  it('returns the cell\'s own reason when nothing was read', () => {
    expect(pegAssessment({ state: 'unavailable', reason: 'no market price' })).toEqual({
      state: 'unknown',
      reason: 'no market price',
    });
  });

  it('flags only a discount past the display threshold', () => {
    const small = pegAssessment(cell({ value: 1 - (PEG_DISCOUNT_FLAG_PCT / 100) / 2, unit: 'ratio' }));
    expect(small.state).toBe('below-nav');
    expect(small.state === 'below-nav' && small.notable).toBe(false);
    const big = pegAssessment(cell({ value: 0.99, unit: 'ratio' }));
    expect(big.state === 'below-nav' && big.notable).toBe(true);
    expect(big.state === 'below-nav' && big.discountPct).toBeCloseTo(1, 6);
  });

  it('treats exactly 1.0000 as at-or-above rather than as a discount of zero', () => {
    expect(pegAssessment(cell({ value: 1, unit: 'ratio' })).state).toBe('at-or-above-nav');
  });
});
