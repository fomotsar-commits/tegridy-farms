// The honesty guard for the portfolio total.
//
// The product of this module is one dollar figure, and the test's job is to make that
// figure expensive to publish. Every assertion below is a way the total could look whole
// while a leg was missing:
//
//   - a leg still loading, counted as nothing
//   - a leg whose read FAILED, counted as nothing
//   - a leg that was read but could not be priced, counted as nothing
//   - a leg nobody built a reader for, quietly absent from the disclosure
//   - every leg missing, rendered as $0.00 rather than as "no total"
//   - legs read minutes apart, summed and stamped with the newest time
//
// The last two are the dangerous ones, because both produce a number a user will act on.
// A stale-but-plausible total and a fabricated zero are indistinguishable from a correct
// reading at a glance, and that is exactly why they are asserted first.

import { describe, it, expect } from 'vitest';
import { aggregatePortfolio, describeCompleteness, FRESHNESS_TOLERANCE_SEC } from './aggregate';
import type { PortfolioSourceReport, PortfolioSourceState } from './types';

const T = 1_800_000_000;

function report(
  id: PortfolioSourceReport['id'],
  state: PortfolioSourceState,
  usd: number | null,
  asOf: number | null = T,
): PortfolioSourceReport {
  return { id, label: `label:${id}`, state, usd, asOf };
}

/** Two priced legs, read at the same instant. The only shape that may read as whole. */
function healthy(): PortfolioSourceReport[] {
  return [report('wallet-eth', 'ok', 100), report('wallet-toweli', 'ok', 25)];
}

describe('a total is only published when every tracked leg was read and priced', () => {
  it('sums the contributing legs and calls itself complete', () => {
    const total = aggregatePortfolio(healthy());
    expect(total.usd).toBe(125);
    expect(total.completeness).toBe('complete');
    expect(total.counted).toEqual(['wallet-eth', 'wallet-toweli']);
    expect(total.omitted).toEqual([]);
  });

  const excluding: { state: PortfolioSourceState; why: string }[] = [
    { state: 'loading', why: 'a read that has not landed' },
    { state: 'unavailable', why: 'a read that failed' },
    { state: 'unpriced', why: 'a holding with no mark' },
  ];

  for (const { state, why } of excluding) {
    it(`goes PARTIAL, not smaller-and-silent, on ${why}`, () => {
      const total = aggregatePortfolio([...healthy(), report('staking', state, null)]);
      expect(total.completeness).toBe('partial');
      // The figure still shows — a user with a broken leg is better served by "125, and
      // here is what is missing" than by nothing. What must never happen is 125 with no
      // notice, so the omission is named.
      expect(total.usd).toBe(125);
      expect(total.counted).not.toContain('staking');
      expect(total.omitted.map((o) => o.id)).toEqual(['staking']);
      expect(describeCompleteness(total)).toContain('PARTIAL');
      expect(describeCompleteness(total)).toContain('label:staking');
    });
  }

  it('never renders a fabricated zero when nothing could be read', () => {
    const total = aggregatePortfolio([
      report('wallet-eth', 'unavailable', null),
      report('wallet-toweli', 'unavailable', null),
      report('staking', 'loading', null),
    ]);
    // The bug this pins: `usd` defaulting to 0 turns a total outage into the claim
    // "this wallet is empty", which is a factual statement about the user's money made
    // on the strength of calls that never came back.
    expect(total.usd).toBeNull();
    expect(total.completeness).toBe('unavailable');
    expect(describeCompleteness(total)).toMatch(/no total is shown/i);
  });

  it('treats a read zero as a fact and counts it', () => {
    const total = aggregatePortfolio([report('wallet-eth', 'ok', 0), report('wallet-toweli', 'ok', 0)]);
    expect(total.usd).toBe(0);
    expect(total.completeness).toBe('complete');
  });

  it('yields no total, and no zero, for an empty report set', () => {
    const total = aggregatePortfolio([]);
    expect(total.usd).toBeNull();
    expect(total.completeness).toBe('unavailable');
  });
});

describe('a leg cannot claim success without delivering what success means', () => {
  it('omits a leg that says ok but carries no value', () => {
    const total = aggregatePortfolio([...healthy(), report('lp', 'ok', null)]);
    expect(total.counted).not.toContain('lp');
    expect(total.completeness).toBe('partial');
    expect(total.omitted[0]?.reason).toMatch(/carried no value/i);
  });

  it('omits a leg whose value is not finite', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const total = aggregatePortfolio([...healthy(), report('lp', 'ok', bad)]);
      expect(total.usd).toBe(125);
      expect(total.completeness).toBe('partial');
    }
  });

  it('omits a leg whose read time is unknown, because it cannot be dated against the rest', () => {
    const total = aggregatePortfolio([...healthy(), report('lp', 'ok', 500, null)]);
    expect(total.usd).toBe(125);
    expect(total.counted).not.toContain('lp');
    expect(total.omitted[0]?.reason).toMatch(/read time unknown/i);
  });
});

describe('freshness is reported from the oldest leg, never the newest', () => {
  it('stamps the total with the oldest contributing read', () => {
    const total = aggregatePortfolio([
      report('wallet-eth', 'ok', 100, T - 90),
      report('wallet-toweli', 'ok', 25, T),
    ]);
    expect(total.asOfOldest).toBe(T - 90);
    expect(total.asOfNewest).toBe(T);
    expect(total.freshnessSpreadSec).toBe(90);
  });

  it('flags a sum assembled from legs that were not read together', () => {
    const total = aggregatePortfolio([
      report('wallet-eth', 'ok', 100, T - (FRESHNESS_TOLERANCE_SEC + 1)),
      report('wallet-toweli', 'ok', 25, T),
    ]);
    expect(total.mixedFreshness).toBe(true);
  });

  it('does not cry stale over ordinary poll skew', () => {
    const total = aggregatePortfolio([
      report('wallet-eth', 'ok', 100, T - FRESHNESS_TOLERANCE_SEC),
      report('wallet-toweli', 'ok', 25, T),
    ]);
    expect(total.mixedFreshness).toBe(false);
  });

  it('ignores omitted legs when dating the total — a stale leg that was dropped cannot age it', () => {
    const total = aggregatePortfolio([
      ...healthy(),
      report('staking', 'unavailable', null, T - 10_000),
    ]);
    expect(total.asOfOldest).toBe(T);
    expect(total.mixedFreshness).toBe(false);
  });
});

describe('sources this build does not read are disclosed, not omitted from the disclosure', () => {
  const withScope = () => [
    ...healthy(),
    { ...report('launched-tokens', 'out-of-scope', null, null), detail: 'no per-wallet token index' },
  ];

  it('lists them separately and does not let them mark the total partial', () => {
    const total = aggregatePortfolio(withScope());
    expect(total.completeness).toBe('complete');
    expect(total.omitted).toEqual([]);
    expect(total.outOfScope.map((o) => o.id)).toEqual(['launched-tokens']);
  });

  it('carries the reason so the surface can print WHY, not just THAT', () => {
    // "Not tracked" without a cause reads as an oversight the user should wait out.
    // The cause is what tells them it will not resolve on its own.
    expect(aggregatePortfolio(withScope()).outOfScope[0]?.reason).toBe('no per-wallet token index');
  });

  it('a complete total still means "everything we track" — never "everything you own"', () => {
    const total = aggregatePortfolio(withScope());
    expect(total.completeness).toBe('complete');
    expect(total.outOfScope.length).toBeGreaterThan(0);
    expect(describeCompleteness(total)).toBe('Every tracked source was read and priced.');
    expect(describeCompleteness(total)).not.toMatch(/everything you own|your full|complete portfolio/i);
  });
});
