// @vitest-environment node
//
// Dollar lines are a convenience: they exist only when every price behind them was read,
// each pairing coin at ITS OWN read price (USDC is never taken as $1), and they name the
// price source and how old the read is.
import { describe, it, expect } from 'vitest';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE } from './quotes';
import { NO_USD_PRICES, USD_LINES, usdLine, usdOfCoin, usdOfPair, usdOfPool, usdText, type UsdPerCoin } from './usd';

const prices = (p: Partial<Record<'SOL' | 'USDC' | 'BAYLA', number | null>>): UsdPerCoin => ({ ...NO_USD_PRICES, ...p });

// DESIGN's shared forecast regex, verbatim. B1 exports it from ./format (format.ts is B1's
// file); the shared constant lives in ./format (integration swap, 2026-10-06).
import { FORECAST_WORDS } from './format';

describe('usd lines', () => {
  it('ships off: the committed switch is "off" until the owner rules (open question 7.36)', () => {
    expect(USD_LINES).toBe('off');
    expect(NO_USD_PRICES).toEqual({ SOL: null, USDC: null, BAYLA: null });
  });

  it('gives no figure without a read price for the coin: null, never $0', () => {
    expect(usdOfCoin(1_000_000_000n, SOL_QUOTE, NO_USD_PRICES)).toBeNull();
    expect(usdOfCoin(1_000_000_000n, SOL_QUOTE, prices({ SOL: 0 }))).toBeNull();
    expect(usdOfCoin(1_000_000_000n, SOL_QUOTE, prices({ SOL: Number.NaN }))).toBeNull();
    expect(usdOfCoin(1_000_000_000n, SOL_QUOTE, prices({ SOL: -150 }))).toBeNull();
    expect(usdOfPool(5_000_000_000n, SOL_QUOTE, NO_USD_PRICES)).toBeNull();
    expect(usdOfPair(1n, 1n, 6, 0.001, SOL_QUOTE, NO_USD_PRICES)).toBeNull();
    expect(usdText(null)).toBeNull();
  });

  it('values a coin at the price given, a pool at twice its coin side, a pair at the pool price', () => {
    expect(usdOfCoin(2_000_000_000n, SOL_QUOTE, prices({ SOL: 150 }))).toBe(300);
    expect(usdOfPool(1_000_000_000n, SOL_QUOTE, prices({ SOL: 150 }))).toBe(300);
    // 0.5 SOL plus 1,000 tokens at 0.0001 SOL each is 0.6 SOL: $90 at $150 a SOL.
    expect(usdOfPair(500_000_000n, 1_000_000_000n, 6, 0.0001, SOL_QUOTE, prices({ SOL: 150 }))).toBeCloseTo(90, 9);
  });

  it('a USDC pool uses USDC’s read price, never 1, and none without it', () => {
    // 100 USDC (6 decimals) on the coin side, read at $0.98: the pool holds about $196.
    expect(usdOfPool(100_000_000n, USDC_QUOTE, prices({ USDC: 0.98, SOL: 150 }))).toBeCloseTo(196, 9);
    expect(usdOfPool(100_000_000n, USDC_QUOTE, prices({ SOL: 150 }))).toBeNull();
    expect(usdOfCoin(100_000_000n, USDC_QUOTE, prices({ USDC: 0.98 }))).toBeCloseTo(98, 9);
  });

  it('a BAYLA pool uses BAYLA’s read price in BAYLA’s decimals, never another coin’s', () => {
    // 2,000 BAYLA (6 decimals) at $0.002 each: a pool holding that on its coin side is about $8.
    expect(usdOfPool(2_000_000_000n, BAYLA_QUOTE, prices({ BAYLA: 0.002, SOL: 150, USDC: 1 }))).toBeCloseTo(8, 9);
    expect(usdOfPool(2_000_000_000n, BAYLA_QUOTE, prices({ SOL: 150, USDC: 1 }))).toBeNull();
    // A pair in a BAYLA pool: 1,000 BAYLA plus 500 tokens (9 decimals) at 2 BAYLA each is 2,000 BAYLA: $4.
    expect(usdOfPair(1_000_000_000n, 500_000_000_000n, 9, 2, BAYLA_QUOTE, prices({ BAYLA: 0.002 }))).toBeCloseTo(4, 9);
  });

  it('a pair needs the token decimals and the pool price, or there is no figure', () => {
    expect(usdOfPair(500_000_000n, 1n, null, 0.0001, SOL_QUOTE, prices({ SOL: 150 }))).toBeNull();
    expect(usdOfPair(500_000_000n, 1n, 6, null, SOL_QUOTE, prices({ SOL: 150 }))).toBeNull();
    expect(usdOfPair(500_000_000n, 1n, 6, -1, SOL_QUOTE, prices({ SOL: 150 }))).toBeNull();
  });

  it('writes "about", whole dollars from a thousand up, cents below, and "under" for dust', () => {
    expect(usdText(1234.56)).toBe('about $1,235');
    expect(usdText(12.345)).toBe('about $12.35');
    expect(usdText(0.004)).toBe('under $0.01');
    expect(usdText(0)).toBe('about $0.00');
    expect(usdText(-1)).toBeNull();
    expect(usdText(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('a line names the coin whose price it used and how many seconds old that read is', () => {
    const now = 1_760_000_000_000;
    expect(usdLine(12.345, { quote: 'USDC', readAt: now - 7_500 }, now)).toBe('about $12.35, at Jupiter’s USDC price read 7 s ago');
    expect(usdLine(0.004, { quote: 'BAYLA', readAt: now }, now)).toBe('under $0.01, at Jupiter’s BAYLA price read 0 s ago');
    expect(usdLine(300, { quote: 'SOL', readAt: now + 2_000 }, now)).toBe('about $300.00, at Jupiter’s SOL price read 0 s ago');
    expect(usdLine(null, { quote: 'SOL', readAt: now }, now)).toBeNull();
    expect(usdLine(300, { quote: 'SOL', readAt: null }, now)).toBeNull();
  });

  it('no line carries a forecast word or an em dash', () => {
    const now = 1_760_000_000_000;
    const lines = [usdLine(1234.56, { quote: 'SOL', readAt: now - 1000 }, now), usdLine(0.001, { quote: 'USDC', readAt: now }, now), usdText(5)];
    for (const line of lines) {
      expect(line).not.toBeNull();
      expect(line).not.toMatch(FORECAST_WORDS);
      expect(line).not.toContain('—');
    }
  });
});
