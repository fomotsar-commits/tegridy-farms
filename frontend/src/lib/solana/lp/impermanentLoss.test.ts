// The one sentence the Add panel says about impermanent loss prints its percentages from
// this function, so the words cannot drift from the arithmetic. Pure ratio, display only.

import { describe, expect, it } from 'vitest';
import { IL_LINE_SHOWN, impermanentLossPct, impermanentLossPctText } from './impermanentLoss';

describe('impermanentLossPct: how far a share falls behind holding when the price moves', () => {
  it('a doubling costs 5.7% and a quadrupling 20.0%, to one decimal', () => {
    expect(impermanentLossPct(2).toFixed(1)).toBe('5.7');
    expect(impermanentLossPct(4).toFixed(1)).toBe('20.0');
  });

  it('is symmetric: a halving costs what a doubling costs, a quarter what four times costs', () => {
    for (const r of [2, 4, 1.5, 10, 1000]) {
      expect(impermanentLossPct(r)).toBeCloseTo(impermanentLossPct(1 / r), 10);
    }
  });

  it('no move, no loss; every move is a loss, never a gain', () => {
    expect(impermanentLossPct(1)).toBe(0);
    for (const r of [0.01, 0.5, 2, 4, 100]) {
      expect(impermanentLossPct(r)).toBeGreaterThan(0);
      expect(impermanentLossPct(r)).toBeLessThan(100);
    }
  });

  it('prints one decimal and drops a trailing .0: "5.7%" and "20%"', () => {
    expect(impermanentLossPctText(2)).toBe('5.7%');
    expect(impermanentLossPctText(4)).toBe('20%');
    expect(impermanentLossPctText(0.5)).toBe('5.7%');
    expect(impermanentLossPctText(0.25)).toBe('20%');
  });

  it('the sentence is on by default; the owner turns it off in one line', () => {
    expect(IL_LINE_SHOWN).toBe(true);
  });
});
