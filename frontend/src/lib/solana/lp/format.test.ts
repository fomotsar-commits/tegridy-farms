// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { formatSolPrice, priceText } from './format';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE } from './quotes';

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
