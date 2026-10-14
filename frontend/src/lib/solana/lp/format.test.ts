// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as earnCopy from './earnCopy';
import { FORECAST_WORDS, RATE_WORDS, feeRateText, formatSolPrice, minuteText, pctText, priceText } from './format';
import * as ledger from './ledger';
import * as poolGrowth from './poolGrowth';
import * as poolPast from './poolPast';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE } from './quotes';

/** Every string a module exports, on its own or as a member of an exported object. */
const exportedStrings = (m: object): string[] =>
  Object.values(m).flatMap((v: unknown) =>
    typeof v === 'string' ? [v] : v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RegExp) ? Object.values(v as Record<string, unknown>).filter((s): s is string => typeof s === 'string') : [],
  );

// No LP copy promises a return. One regex, exported here, is what every pin uses: a word
// added to it is caught everywhere at once.
describe('FORECAST_WORDS: the one regex every LP pin uses', () => {
  it('catches each forecast word, and lets a measured sentence through', () => {
    for (const s of ['an APR of 12%', 'APY', 'a yield of 3%', 'twice a year', 'annualised', '0.1% per day', 'per week', 'the rate of return', 'you earn fees on every trade']) expect(s).toMatch(FORECAST_WORDS);
    for (const s of ['Fees stay in the pool; there is nothing to claim.', 'measured over the last 20 transactions', 'aprons', 'no total is shown']) expect(s).not.toMatch(FORECAST_WORDS);
  });

  it('catches a rate over any span of time by its shape, and lets a measured span through', () => {
    const rates = ['about 5% per year', 'about 5% yearly', '5% each year', '5% every year', '0.4% a month', '0.4% per month', '0.4% monthly', '0.01% a day', '0.01% daily', '0.1% a week', '0.1% weekly', 'a  year'];
    for (const s of rates) {
      expect(s).toMatch(RATE_WORDS);
      expect(s).toMatch(FORECAST_WORDS);
    }
    // How long something took, or when, is not a rate.
    for (const s of ['0.0084% in 6.3 days', 'in 1 day', 'in 23 hours', 'Try again in about a minute.', 'since the day it opened', 'the last 30 minutes', 'yesterday', 'weekday']) {
      expect(s).not.toMatch(FORECAST_WORDS);
    }
    // FORECAST_WORDS holds every rate word: one list, never two.
    expect(FORECAST_WORDS.source).toContain(RATE_WORDS.source);
  });

  it('no exported string of ledger.ts, poolPast.ts, poolGrowth.ts or earnCopy.ts carries one, nor an em dash', () => {
    const strings = [...exportedStrings(ledger), ...exportedStrings(poolPast), ...exportedStrings(poolGrowth), ...exportedStrings(earnCopy)];
    expect(strings.length).toBeGreaterThanOrEqual(16);
    for (const mod of [poolGrowth, earnCopy]) expect(exportedStrings(mod).length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s).not.toMatch(FORECAST_WORDS);
      expect(s).not.toContain('—');
    }
  });
});

describe('pctText and feeRateText: a percent as a sentence prints it', () => {
  it('four decimals at most, no padding; a fee rate is the same form', () => {
    expect(pctText(0.84)).toBe('0.84%');
    expect(pctText(0.16)).toBe('0.16%');
    expect(pctText(1)).toBe('1%');
    expect(pctText(0.2)).toBe('0.2%');
    expect(pctText(0.12345678)).toBe('0.1235%');
    expect(feeRateText(10_000n)).toBe('1%');
    expect(feeRateText(2_500n)).toBe('0.25%');
  });
});

describe('minuteText: a chain time to the minute, in UTC', () => {
  it('prints the minute; a time the chain did not record says so', () => {
    expect(minuteText(1_791_066_624)).toBe('2026-10-03 22:30 UTC');
    expect(minuteText(1_791_055_083)).toBe('2026-10-03 19:18 UTC');
    expect(minuteText(null)).toBe('a time the chain did not record');
  });
});

// A price on the pool card and on the review. With SOL nothing was ever worth 10,000 SOL a
// token, so nobody saw what four significant digits make of a large number: "1.040e+5".
// A token worth 10,000 USDC, or 10,000 BAYLA, is ordinary.
describe('formatSolPrice: a price is written out, never in scientific notation', () => {
  it('from 10,000 up it is a whole number with its thousands grouped', () => {
    expect(formatSolPrice(104_000)).toBe('104,000');
    expect(formatSolPrice(123_456_789)).toBe('123,456,789');
    expect(formatSolPrice(10_000)).toBe('10,000');
    expect(formatSolPrice(1e9)).toBe('1,000,000,000');
    expect(formatSolPrice(123_456_789_012.4)).toBe('123,456,789,012');
  });

  it('the line is where four digits stop being enough: 9,999.4 is four digits, 9,999.6 is 10,000', () => {
    expect(formatSolPrice(9_999.4)).toBe('9999');
    expect(formatSolPrice(9_999.6)).toBe('10,000');
    // 9,999.5 is the first value four significant digits would write as "1.000e+4".
    expect(formatSolPrice(9_999.5)).toBe('10,000');
    expect(formatSolPrice(9_999.49)).toBe('9999');
  });

  it('no value a pool can have prints an exponent', () => {
    for (const v of [1e-12, 1e-9, 0.000001, 0.00012345, 0.01, 0.999, 1, 12.345, 999.95, 9_999.4, 9_999.5, 9_999.6, 99_999.5, 1e9 - 1, 1e9, 1e15, 1e21, 1e30]) {
      expect(formatSolPrice(v), `${v}`).not.toMatch(/e/i);
      expect(formatSolPrice(v), `${v}`).toMatch(/^[0-9][0-9.,]*$/);
    }
  });

  it('under 10,000 it is what it always was: four significant digits, no padding', () => {
    expect(formatSolPrice(0.01)).toBe('0.01');
    expect(formatSolPrice(0.0249)).toBe('0.0249');
    expect(formatSolPrice(0.009090909)).toBe('0.009091');
    expect(formatSolPrice(2.058)).toBe('2.058');
    expect(formatSolPrice(1234.56)).toBe('1235');
    expect(formatSolPrice(0.00000012)).toBe('0.00000012');
    expect(formatSolPrice(0)).toBe('0');
  });

  it('what is not a price says so, and is never a number', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(formatSolPrice(v)).toBe('unreadable');
  });
});

describe('priceText: the price with the pool’s own coin', () => {
  it('names the coin, whatever the size of the number', () => {
    expect(priceText(0.025, SOL_QUOTE)).toBe('1 token = 0.025 SOL');
    expect(priceText(104_000, USDC_QUOTE)).toBe('1 token = 104,000 USDC');
    expect(priceText(123_456_789, BAYLA_QUOTE)).toBe('1 token = 123,456,789 BAYLA');
  });
});
