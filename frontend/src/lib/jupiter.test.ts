// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { limitTakingAmount, toBaseUnits, fromBaseUnits, pickFeeMint } from './jupiter';

describe('limitTakingAmount — full-precision limit-order receive amount', () => {
  // The OLD formula was toBaseUnits(price, buyDecimals) FIRST, multiply after —
  // truncating typed price digits beyond the buy token's decimals and flooring
  // the order rate scaled by size. These cases are chosen to FAIL under that
  // formula, so a regression back to truncate-first cannot pass.

  it('keeps price precision beyond the buy token decimals (old formula floored this)', () => {
    // Sell 1,000,000 units of a 6-decimal token at 0.00001234567 (6-dec buy).
    // Old: floor(0.00001234567e6)=12 → 1e12·12/1e6 = 12,000,000.
    // Exact: 1e12 · 1234567 / (1e6 · 1e11) = 12,345,670.
    expect(limitTakingAmount('1000000000000', '0.00001234567', 6, 6)).toBe('12345670');
  });

  it('represents a fractional price on a 0-decimal buy token (old formula returned null)', () => {
    // Sell 100 units (9-dec pay) at 0.6 whole tokens each → exactly 60.
    // Old: toBaseUnits('0.6', 0) = null → "Amount too small".
    expect(limitTakingAmount('100000000000', '0.6', 9, 0)).toBe('60');
  });

  it('matches the old math when the price fits the buy decimals exactly', () => {
    // 1.5 SOL at 150 USDC/SOL = 225 USDC — both formulas agree here.
    expect(limitTakingAmount('1500000000', '150', 9, 6)).toBe('225000000');
  });

  it('applies exactly one floor, at the end', () => {
    // 1 unit (0 dec) at 0.9999999 into a 6-dec buy: exact 999999.9 → 999999.
    expect(limitTakingAmount('1', '0.9999999', 0, 6)).toBe('999999');
  });

  it('returns null for nothing-to-take inputs, matching the button gating', () => {
    expect(limitTakingAmount(null, '1', 9, 6)).toBeNull();
    expect(limitTakingAmount('1000', '', 9, 6)).toBeNull();
    expect(limitTakingAmount('1000', '0', 9, 6)).toBeNull();
    expect(limitTakingAmount('1000', '0.0', 9, 6)).toBeNull();
    expect(limitTakingAmount('1000', 'abc', 9, 6)).toBeNull();
    expect(limitTakingAmount('1000', '1e5', 9, 6)).toBeNull(); // no exponent form
    // Rounds to zero: 1 base unit at a price too small to represent.
    expect(limitTakingAmount('1', '0.1', 9, 0)).toBeNull();
  });
});

describe('base-unit round trips (guards the shared parsing family)', () => {
  it('toBaseUnits truncates to the given decimals by design', () => {
    expect(toBaseUnits('1.2345678', 6)).toBe('1234567');
  });
  it('fromBaseUnits inverts toBaseUnits for representable values', () => {
    expect(fromBaseUnits(toBaseUnits('1.234567', 6)!, 6)).toBe('1.234567');
  });
});

describe('pickFeeMint', () => {
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  it('prefers USDC, then USDT, then SOL; null when the pair touches none', () => {
    expect(pickFeeMint(SOL, USDC)).toBe(USDC);
    expect(pickFeeMint(USDT, USDC)).toBe(USDC);
    expect(pickFeeMint(USDT, SOL)).toBe(USDT);
    expect(pickFeeMint(SOL, 'Other')).toBe(SOL);
    expect(pickFeeMint('A', 'B')).toBeNull();
  });
  it('a swap paid in USDT for any other coin carries the fee, in USDT, either way round', () => {
    // Until 2026-11-02 this pair ran fee-free: USDT was one press away on the Pay list
    // (the island's answer twenty-four) but not in the fee-mint set.
    expect(pickFeeMint(USDT, 'Other')).toBe(USDT);
    expect(pickFeeMint('Other', USDT)).toBe(USDT);
  });
  it('ExactOut may only fee the input side', () => {
    expect(pickFeeMint('A', USDC, 'ExactOut')).toBeNull();
    expect(pickFeeMint(USDC, 'A', 'ExactOut')).toBe(USDC);
    expect(pickFeeMint('A', USDT, 'ExactOut')).toBeNull();
    expect(pickFeeMint(USDT, 'A', 'ExactOut')).toBe(USDT);
  });
});
