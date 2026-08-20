// WHAT A CELL IS ALLOWED TO SAY.
//
// Everything above this layer can be correct and the page can still lie, because
// the lie is a formatting decision: `(0).toFixed(2)` on an absent value is one
// keystroke away at all times, and the result — "0.00%" — is indistinguishable
// from a real reading. So these tests read the STRINGS.
//
// The strongest assertion here is the negative one: for every shape of missing
// input, the rendered text must not parse as a number. That holds whatever the
// formatter is rewritten to do.

import { describe, it, expect } from 'vitest';
import { UNAVAILABLE_MARK, apyDisplay, exitLiquidityDisplay, feedStatusLine, pegDisplay } from './display';
import { venueMetrics, type MetricRead } from './metrics';
import { YIELD_READING_MAX_AGE_S } from './feed';
import { yieldVenue } from './venues';

const NOW = 1_780_000_000;
const LIDO = yieldVenue('lido-steth')!;

const absent: MetricRead = { state: 'unavailable', reason: 'nothing was read for this venue' };

function reading(over: Record<string, unknown> = {}) {
  return {
    apyPct: { value: 3.1, source: 'stats API' },
    pegRatio: { value: 0.9994, source: 'pool mid' },
    exitLiquidityUsd: { value: 1_000_000, source: 'pool balances' },
    ...over,
  } as Parameters<typeof venueMetrics>[1];
}

/** Anything a reader could mistake for a quantity. */
function looksNumeric(text: string): boolean {
  return /\d/.test(text);
}

describe('an unavailable cell cannot be mistaken for a value', () => {
  it('renders the marker, never a digit, for every metric', () => {
    for (const display of [apyDisplay(absent), exitLiquidityDisplay(absent), pegDisplay(absent, 'ETH')]) {
      expect(display.text).toBe(UNAVAILABLE_MARK);
      expect(looksNumeric(display.text), `"${display.text}" reads as a number`).toBe(false);
      expect(display.unavailable).toBe(true);
    }
  });

  it('carries the reason as visible text, not as an empty tooltip', () => {
    // A hidden explanation behind an em dash is functionally no explanation: the
    // reader who needs it is skimming, and skimming does not hover.
    for (const display of [apyDisplay(absent), exitLiquidityDisplay(absent), pegDisplay(absent, 'USD')]) {
      expect(display.detail.length).toBeGreaterThan(10);
    }
  });

  it('never marks an absence as notable, so a gap cannot read as an alarm', () => {
    expect(pegDisplay(absent, 'ETH').notable).toBe(false);
  });

  it('holds for every real missing-metric path, not just a hand-built absence', () => {
    const noFeed = venueMetrics(LIDO, null, null, NOW);
    const noRate = venueMetrics(LIDO, reading({ apyPct: null, pegRatio: null, exitLiquidityUsd: null }), NOW, NOW);
    for (const row of [noFeed, noRate]) {
      expect(apyDisplay(row.apy).text).toBe(UNAVAILABLE_MARK);
      expect(pegDisplay(row.peg, LIDO.pegReference).text).toBe(UNAVAILABLE_MARK);
      expect(exitLiquidityDisplay(row.exitLiquidity).text).toBe(UNAVAILABLE_MARK);
    }
  });
});

describe('a read cell states its figure and its provenance', () => {
  it('prints an APY with its source and its age', () => {
    const row = venueMetrics(LIDO, reading(), NOW - 120, NOW);
    const display = apyDisplay(row.apy);
    expect(display.text).toBe('3.10%');
    expect(display.unavailable).toBe(false);
    expect(display.detail).toContain('stats API');
    expect(display.detail).toMatch(/ago/);
  });

  it('prints a genuine zero APY as a figure, because it is one', () => {
    const row = venueMetrics(LIDO, reading({ apyPct: { value: 0, source: 'stats API' } }), NOW, NOW);
    expect(apyDisplay(row.apy).text).toBe('0.00%');
    expect(apyDisplay(row.apy).unavailable).toBe(false);
  });

  it('prints a read exit liquidity of zero as $0.00 — a loud, real answer', () => {
    const row = venueMetrics(LIDO, reading({ exitLiquidityUsd: { value: 0, source: 'pool balances' } }), NOW, NOW);
    const display = exitLiquidityDisplay(row.exitLiquidity);
    expect(display.unavailable).toBe(false);
    expect(display.text).toContain('0');
  });

  it('says a stale figure is stale rather than refreshing it silently', () => {
    const row = venueMetrics(LIDO, reading(), NOW - YIELD_READING_MAX_AGE_S - 60, NOW);
    const display = apyDisplay(row.apy);
    expect(display.stale).toBe(true);
    expect(display.detail).toMatch(/out of date/i);
  });
});

describe('the peg column shows four decimals, because two would hide the subject', () => {
  it('keeps a half-percent discount distinguishable from no discount', () => {
    const pegged = venueMetrics(LIDO, reading({ pegRatio: { value: 1, source: 'mid' } }), NOW, NOW);
    const off = venueMetrics(LIDO, reading({ pegRatio: { value: 0.995, source: 'mid' } }), NOW, NOW);
    const a = pegDisplay(pegged.peg, 'ETH').text;
    const b = pegDisplay(off.peg, 'ETH').text;
    expect(a).not.toBe(b);
    expect(a).toBe('1.0000 ETH');
    expect(b).toBe('0.9950 ETH');
  });

  it('flags a notable discount and states the percentage under reference', () => {
    const off = venueMetrics(LIDO, reading({ pegRatio: { value: 0.97, source: 'mid' } }), NOW, NOW);
    const display = pegDisplay(off.peg, 'ETH');
    expect(display.notable).toBe(true);
    expect(display.detail).toMatch(/3\.00% under/);
  });

  it('describes an at-reference read without promising it holds', () => {
    const pegged = venueMetrics(LIDO, reading({ pegRatio: { value: 1, source: 'mid' } }), NOW, NOW);
    const display = pegDisplay(pegged.peg, 'ETH');
    expect(display.detail).toMatch(/not a guarantee it holds/i);
    expect(display.notable).toBe(false);
  });
});

describe('the feed banner tells an outage apart from an answer', () => {
  it('prefers the specific reason over the generic one when there is one', () => {
    expect(feedStatusLine('unavailable', 'VITE_YIELD_FEED_URL is set but is not a valid http(s) URL.')).toMatch(
      /VITE_YIELD_FEED_URL/,
    );
  });

  it('still says nothing was read when no reason was supplied', () => {
    const line = feedStatusLine('unavailable', null);
    expect(line).toMatch(/no rate, peg or exit-liquidity figure could be read/i);
    // And says what the columns will do about it, so a reader is not left to
    // decide for themselves what an em dash means.
    expect(line).toMatch(/rather than showing a number/i);
  });

  it('does not describe a loading read as an answer', () => {
    expect(feedStatusLine('loading', null)).not.toMatch(/could not|unavailable/i);
  });
});
