// THE ONE RULE: an unread figure never renders as a figure.
//
// Asserted without a DOM, because the failure is in the string rather than in
// the layout. A cell that prints '0.00%' for a rate nobody read is not a
// rendering bug a screenshot would catch — it is a number, and it is wrong.

import { describe, it, expect } from 'vitest';
import {
  UNAVAILABLE_MARK,
  exitDisplay,
  marketDisplay,
  navDisplay,
  rateDisplay,
  readStatusLine,
  vsNavDisplay,
} from './display';
import type { MetricRead } from './metrics';

const readCell = (over: Partial<Extract<MetricRead, { state: 'read' }>> = {}): MetricRead => ({
  state: 'read',
  value: 3.44,
  unit: 'pct',
  source: 'Aave v3 Pool.getReserveData(USDC).currentLiquidityRate at block 25888268',
  asOf: 1_788_335_951,
  block: 25_888_268,
  stale: false,
  ageSeconds: 0,
  maxAgeS: 3_600,
  ...over,
});

const gone: MetricRead = { state: 'unavailable', reason: 'Aave v3 Pool.getReserveData did not answer at block 25888268.' };
const na: MetricRead = { state: 'not-applicable', reason: 'stETH rebases, so there is no share rate to read.' };

const ALL_FIVE = [rateDisplay, navDisplay, marketDisplay, vsNavDisplay, exitDisplay] as const;

describe('the read and unread branches can never produce the same string', () => {
  it.each(ALL_FIVE.map((f, i) => [i, f] as const))('cell %i never prints a digit when nothing was read', (_i, fn) => {
    const out = fn(gone);
    expect(out.text).toBe(UNAVAILABLE_MARK);
    expect(out.text).not.toMatch(/\d/);
    expect(out.unavailable).toBe(true);
    expect(out.detail.length).toBeGreaterThan(10);
  });

  it.each(ALL_FIVE.map((f, i) => [i, f] as const))('cell %i never prints a digit when there is nothing to read', (_i, fn) => {
    const out = fn(na);
    expect(out.text).toBe(UNAVAILABLE_MARK);
    expect(out.notApplicable).toBe(true);
    expect(out.detail).toContain('rebases');
  });

  it('keeps the two absences distinguishable, because only one of them can change', () => {
    expect(rateDisplay(gone).notApplicable).toBe(false);
    expect(rateDisplay(na).notApplicable).toBe(true);
  });

  it('prints a genuine zero as a zero', () => {
    // A read 0.00% is a real, loud answer and is NOT what this file guards.
    expect(rateDisplay(readCell({ value: 0 })).text).toBe('0.00%');
    expect(rateDisplay(readCell({ value: 0 })).unavailable).toBe(false);
  });
});

describe('every figure carries its own unit, and the ratio carries none', () => {
  it('prints NAV and market price with their denomination', () => {
    expect(navDisplay(readCell({ value: 1.1709, unit: 'ETH' })).text).toBe('1.1709 ETH');
    expect(marketDisplay(readCell({ value: 1.1702, unit: 'ETH' })).text).toBe('1.1702 ETH');
  });

  it('prints vs-NAV as a multiple with no currency suffix', () => {
    // The whole point: at four decimals a ratio and a price are frequently the
    // same glyphs, and only the suffix says which claim is being made.
    const out = vsNavDisplay(readCell({ value: 0.9959, unit: 'ratio' }));
    expect(out.text).toContain('×');
    expect(out.text).not.toContain('ETH');
    expect(out.text).not.toContain('USD');
    expect(out.text).not.toContain('$');
  });

  it('flags a notable discount and describes an at-or-above reading as a measurement', () => {
    const under = vsNavDisplay(readCell({ value: 0.99, unit: 'ratio' }));
    expect(under.notable).toBe(true);
    expect(under.detail).toContain('1.00% under');
    const over = vsNavDisplay(readCell({ value: 1.0002, unit: 'ratio' }));
    expect(over.notable).toBe(false);
    expect(over.detail).toMatch(/not a guarantee/);
  });

  it('never flags an absence as notable', () => {
    expect(vsNavDisplay(gone).notable).toBe(false);
    expect(vsNavDisplay(na).notable).toBe(false);
  });
});

describe('an exit backlog is never worded as available liquidity', () => {
  it('says "queued ahead" and does not say "available"', () => {
    const out = exitDisplay(readCell({ value: 6402.67, unit: 'stETH', meaning: 'queued-ahead' }));
    expect(out.text).toContain('stETH');
    expect(out.detail).toContain('queued ahead');
    // The opposite fact. A reader who takes a backlog for depth has been told
    // they can leave when the number says the reverse.
    expect(out.detail).not.toContain('available');
  });

  it('says redeemable now for real depth, and prints its own unit rather than a currency', () => {
    const out = exitDisplay(readCell({ value: 164_381_298.44, unit: 'USDC', meaning: 'available-now' }));
    expect(out.detail).toContain('Redeemable now');
    expect(out.text).toContain('USDC');
    expect(out.text).not.toContain('$');
  });
});

describe('a stale reading is shown as measured, with its age and its own window', () => {
  it('names the window that was exceeded rather than a global one', () => {
    const out = rateDisplay(readCell({ stale: true, ageSeconds: 180_000, maxAgeS: 172_800 }));
    expect(out.stale).toBe(true);
    expect(out.detail).toMatch(/out of date|past this source/);
    expect(out.detail).toContain('48h');
    expect(out.text).toBe('3.44%');
  });

  it('carries the annualisation basis into the detail when a row has one', () => {
    const out = rateDisplay(readCell({ basis: 'the Sky Savings Rate, a governance parameter' }));
    expect(out.detail).toContain('Basis: the Sky Savings Rate');
  });
});

describe('the status line says which block, and how much of it failed', () => {
  it('names the block and the chain time on a clean read', () => {
    const line = readStatusLine('ready', 25_888_268, 1_788_335_951, 0, 40, null);
    expect(line).toContain('block 25888268');
    expect(line).toContain('2026-');
  });

  it('counts the unread figures rather than hiding them behind the same sentence', () => {
    const line = readStatusLine('partial', 25_888_268, 1_788_335_951, 3, 40, null);
    expect(line).toContain('3 of 40');
    expect(line).toContain('say so in place');
  });

  it('says nothing was read when nothing was', () => {
    expect(readStatusLine('unavailable', null, null, 40, 40, null)).toMatch(/could not be read/);
    expect(readStatusLine('loading', null, null, 0, 40, null)).toMatch(/Reading/);
  });
});
