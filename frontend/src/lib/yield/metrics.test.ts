// THE THREE SILENCES, kept apart.
//
// A component receives "no number" in three different situations and only one of
// them is a fact about a protocol. These tests pin that the classification never
// collapses them — and, in the peg's case, that the collapse cannot happen even
// by omission, because there is no default value anywhere on the path.
//
// The ranking assertions are the other half. "Best-yielding" is a claim about a
// COMPLETE comparison; a table with an unread row is entitled to say which of the
// rows it could read is highest, and nothing more. The wording is asserted as a
// string here rather than left to each panel, because a claim that lives in JSX
// is a claim that drifts.

import { describe, it, expect } from 'vitest';
import {
  PEG_DISCOUNT_FLAG_PCT,
  bestRateClaim,
  isCurrentRead,
  pegAssessment,
  rankByApy,
  venueMetrics,
  type MetricRead,
  type VenueMetrics,
} from './metrics';
import { YIELD_READING_MAX_AGE_S } from './feed';
import { yieldVenue, yieldVenues } from './venues';

const NOW = 1_780_000_000;
const LIDO = yieldVenue('lido-steth')!;
const RETH = yieldVenue('rocketpool-reth')!;

function reading(over: Partial<{ apyPct: unknown; pegRatio: unknown; exitLiquidityUsd: unknown }> = {}) {
  return {
    apyPct: { value: 3.1, source: 'stats API' },
    pegRatio: { value: 0.9994, source: 'pool mid' },
    exitLiquidityUsd: { value: 1_000_000, source: 'pool balances' },
    ...over,
  } as Parameters<typeof venueMetrics>[1];
}

describe('an unread figure never becomes a figure', () => {
  it('marks all three columns unavailable when the feed answered for nothing', () => {
    const m = venueMetrics(LIDO, null, null, NOW);
    for (const metric of [m.apy, m.peg, m.exitLiquidity]) {
      expect(metric.state).toBe('unavailable');
      expect(metric.state === 'unavailable' && metric.reason.length).toBeGreaterThan(20);
    }
  });

  it('marks one column unavailable when only that metric was missing', () => {
    const m = venueMetrics(LIDO, reading({ apyPct: null }), NOW, NOW);
    expect(m.apy.state).toBe('unavailable');
    // The other two are untouched: a partially-read row is a partially-read row,
    // not an unavailable one, and hiding the figures that DID arrive is its own
    // kind of understatement.
    expect(m.peg.state).toBe('read');
    expect(m.exitLiquidity.state).toBe('read');
  });

  it('says "not a rate of zero" in as many words when the APY is missing', () => {
    // The sentence is asserted because it is the whole defence. A reader who sees
    // an em dash and no explanation supplies their own, and the one they supply
    // is usually "nothing".
    const m = venueMetrics(LIDO, reading({ apyPct: null }), NOW, NOW);
    expect(m.apy.state === 'unavailable' && m.apy.reason).toMatch(/not a rate of zero/i);
  });

  it('reads a genuine zero APY as zero — the rule is about absence, not about small numbers', () => {
    const m = venueMetrics(LIDO, reading({ apyPct: { value: 0, source: 'stats API' } }), NOW, NOW);
    expect(m.apy.state).toBe('read');
    expect(m.apy.state === 'read' && m.apy.value).toBe(0);
  });

  it('refuses a reading stamped in the future rather than calling it brand new', () => {
    const m = venueMetrics(LIDO, reading(), NOW + 500, NOW);
    expect(m.apy.state).toBe('unavailable');
    expect(m.apy.state === 'unavailable' && m.apy.reason).toMatch(/future/i);
  });
});

describe('staleness is disclosed, not hidden and not suppressed', () => {
  it('keeps an old reading as a read, and flags it', () => {
    const m = venueMetrics(LIDO, reading(), NOW - YIELD_READING_MAX_AGE_S - 1, NOW);
    expect(m.apy.state).toBe('read');
    expect(m.apy.state === 'read' && m.apy.stale).toBe(true);
    expect(isCurrentRead(m.apy)).toBe(false);
  });

  it('treats a reading inside the window as current', () => {
    const m = venueMetrics(LIDO, reading(), NOW - 60, NOW);
    expect(isCurrentRead(m.apy)).toBe(true);
  });
});

describe('the peg is read or unknown — it is never 1.00 by default', () => {
  it('returns unknown, with its reason, when nothing was read', () => {
    const m = venueMetrics(LIDO, reading({ pegRatio: null }), NOW, NOW);
    const assessment = pegAssessment(m.peg, LIDO.pegReference);
    expect(assessment.state).toBe('unknown');
    expect(assessment.state === 'unknown' && assessment.reason).toMatch(/NOT assumed to be 1\.00/i);
  });

  it('has no branch that produces a ratio without a reading behind it', () => {
    // The whole failure mode in one assertion: for every shape of missing input,
    // the assessment must come back `unknown`. If any of these ever produced a
    // ratio, some row on the page would be asserting a peg nobody measured.
    const missing: MetricRead[] = [
      { state: 'unavailable', reason: 'no feed' },
      venueMetrics(LIDO, null, null, NOW).peg,
      venueMetrics(LIDO, reading({ pegRatio: null }), NOW, NOW).peg,
    ];
    for (const metric of missing) {
      expect(pegAssessment(metric, 'ETH')).toMatchObject({ state: 'unknown' });
    }
  });

  it('reports a discount as a measurement, and flags one worth noticing', () => {
    const m = venueMetrics(LIDO, reading({ pegRatio: { value: 0.97, source: 'pool mid' } }), NOW, NOW);
    const assessment = pegAssessment(m.peg, 'ETH');
    expect(assessment.state).toBe('below-reference');
    expect(assessment.state === 'below-reference' && assessment.discountPct).toBeCloseTo(3);
    expect(assessment.state === 'below-reference' && assessment.notable).toBe(true);
  });

  it('does not flag noise below the display threshold', () => {
    const ratio = 1 - (PEG_DISCOUNT_FLAG_PCT / 100) / 2;
    const m = venueMetrics(LIDO, reading({ pegRatio: { value: ratio, source: 'pool mid' } }), NOW, NOW);
    const assessment = pegAssessment(m.peg, 'ETH');
    expect(assessment.state).toBe('below-reference');
    expect(assessment.state === 'below-reference' && assessment.notable).toBe(false);
  });

  it('treats at-or-above the reference as an observation, carrying no verdict word', () => {
    const m = venueMetrics(LIDO, reading({ pegRatio: { value: 1.02, source: 'pool mid' } }), NOW, NOW);
    expect(pegAssessment(m.peg, 'ETH').state).toBe('at-or-above-reference');
  });
});

describe('ranking excludes what it could not read, and says how many', () => {
  const rows = (): VenueMetrics[] => [
    venueMetrics(LIDO, reading({ apyPct: { value: 3.1, source: 's' } }), NOW, NOW),
    venueMetrics(RETH, reading({ apyPct: { value: 4.4, source: 's' } }), NOW, NOW),
  ];

  it('orders by read rate, highest first', () => {
    const ranking = rankByApy(rows());
    expect(ranking.ranked.map((r) => r.venue.id)).toEqual(['rocketpool-reth', 'lido-steth']);
    expect(ranking.best!.venue.id).toBe('rocketpool-reth');
    expect(ranking.complete).toBe(true);
  });

  it('does NOT rank an unread venue last — it does not rank it at all', () => {
    // Last place is a position on a leaderboard and carries the claim that the
    // row was measured and lost. That is the fabricated zero with a rosette on it.
    const withGap = [...rows(), venueMetrics(yieldVenue('renzo-ezeth')!, null, null, NOW)];
    const ranking = rankByApy(withGap);
    expect(ranking.ranked.map((r) => r.venue.id)).not.toContain('renzo-ezeth');
    expect(ranking.unranked.map((u) => u.venue.id)).toEqual(['renzo-ezeth']);
    expect(ranking.unreadCount).toBe(1);
    expect(ranking.complete).toBe(false);
  });

  it('keeps an unrankable venue visible with its reason, rather than dropping it', () => {
    const ranking = rankByApy([venueMetrics(LIDO, null, null, NOW)]);
    expect(ranking.unranked).toHaveLength(1);
    expect(ranking.unranked[0]!.reason.length).toBeGreaterThan(20);
  });

  it('counts a stale reading as incomplete even with nothing missing', () => {
    const stale = [
      venueMetrics(LIDO, reading({ apyPct: { value: 3.1, source: 's' } }), NOW - YIELD_READING_MAX_AGE_S - 1, NOW),
    ];
    const ranking = rankByApy(stale);
    expect(ranking.staleCount).toBe(1);
    expect(ranking.complete).toBe(false);
  });

  it('has no best and is not complete when nothing at all was read', () => {
    const ranking = rankByApy(yieldVenues().map((v) => venueMetrics(v, null, null, NOW)));
    expect(ranking.best).toBeNull();
    expect(ranking.ranked).toEqual([]);
    expect(ranking.complete).toBe(false);
  });
});

describe('the "best rate" claim is sized to the evidence', () => {
  it('refuses to rank at all when nothing was read, and refuses to imply low rates', () => {
    const claim = bestRateClaim(rankByApy([venueMetrics(LIDO, null, null, NOW)]));
    expect(claim).toMatch(/nothing to rank/i);
    expect(claim).toMatch(/not a statement that the rates are low/i);
  });

  it('claims a plain highest only on a complete comparison', () => {
    const complete = rankByApy([venueMetrics(LIDO, reading({ apyPct: { value: 3.1, source: 's' } }), NOW, NOW)]);
    expect(bestRateClaim(complete)).toMatch(/highest current rate/i);
    expect(bestRateClaim(complete)).not.toMatch(/could not be read/i);
  });

  it('names the unread count and disowns "the best rate available" when incomplete', () => {
    const partial = rankByApy([
      venueMetrics(LIDO, reading({ apyPct: { value: 3.1, source: 's' } }), NOW, NOW),
      venueMetrics(RETH, null, null, NOW),
    ]);
    const claim = bestRateClaim(partial);
    expect(claim).toMatch(/1 venue could not be read/i);
    expect(claim).toMatch(/may be higher/i);
    expect(claim).toMatch(/not "the best rate available"/i);
  });

  it('names stale readings too, so an out-of-date top row is not sold as current', () => {
    const stale = rankByApy([
      venueMetrics(LIDO, reading({ apyPct: { value: 3.1, source: 's' } }), NOW - YIELD_READING_MAX_AGE_S - 1, NOW),
    ]);
    expect(bestRateClaim(stale)).toMatch(/out of date/i);
  });
});
