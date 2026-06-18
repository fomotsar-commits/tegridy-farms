import { describe, it, expect } from 'vitest';
import { pickFeeMint, toBaseUnits, fromBaseUnits } from '../jupiter';
import { SOL_MINT, USDC_MINT } from '../solana';

// Two arbitrary (non-fee-supported) mints standing in for "any token".
const ARB = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ARB2 = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe('pickFeeMint — ExactIn (fee mint may be EITHER leg)', () => {
  it('SOL -> ARB charges the wSOL (input) leg', () => {
    expect(pickFeeMint(SOL_MINT, ARB)).toBe(SOL_MINT);
  });
  it('ARB -> SOL charges the wSOL (output) leg', () => {
    expect(pickFeeMint(ARB, SOL_MINT)).toBe(SOL_MINT);
  });
  it('USDC -> ARB charges USDC (input)', () => {
    expect(pickFeeMint(USDC_MINT, ARB)).toBe(USDC_MINT);
  });
  it('ARB -> USDC charges USDC (output)', () => {
    expect(pickFeeMint(ARB, USDC_MINT)).toBe(USDC_MINT);
  });
  it('prefers USDC over SOL when both legs qualify', () => {
    expect(pickFeeMint(SOL_MINT, USDC_MINT)).toBe(USDC_MINT);
    expect(pickFeeMint(USDC_MINT, SOL_MINT)).toBe(USDC_MINT);
  });
  it('arbitrary <-> arbitrary -> no fee (null), so the swap still succeeds', () => {
    expect(pickFeeMint(ARB, ARB2)).toBeNull();
  });
});

describe('pickFeeMint — ExactOut (fee mint must be the INPUT leg only)', () => {
  it('USDC -> ARB (input USDC) charges USDC', () => {
    expect(pickFeeMint(USDC_MINT, ARB, 'ExactOut')).toBe(USDC_MINT);
  });
  it('ARB -> USDC (USDC is the output) cannot charge -> null', () => {
    expect(pickFeeMint(ARB, USDC_MINT, 'ExactOut')).toBeNull();
  });
});

describe('toBaseUnits', () => {
  it('converts decimals without float error', () => {
    expect(toBaseUnits('0.5', 9)).toBe('500000000');
    expect(toBaseUnits('1.5', 9)).toBe('1500000000');
    expect(toBaseUnits('10', 6)).toBe('10000000');
    expect(toBaseUnits('.5', 6)).toBe('500000');
    expect(toBaseUnits('1', 0)).toBe('1');
  });
  it('rejects zero / empty / non-decimal input', () => {
    expect(toBaseUnits('0.0', 9)).toBeNull();
    expect(toBaseUnits('', 9)).toBeNull();
    expect(toBaseUnits('-5', 9)).toBeNull();
    expect(toBaseUnits('1e3', 9)).toBeNull();
    expect(toBaseUnits('abc', 9)).toBeNull();
  });
});

describe('fromBaseUnits', () => {
  it('round-trips and trims', () => {
    expect(fromBaseUnits('500000000', 9)).toBe('0.5');
    expect(fromBaseUnits('1500000000', 9)).toBe('1.5');
    expect(fromBaseUnits('10000000', 6)).toBe('10');
    expect(fromBaseUnits('35064544', 6)).toBe('35.064544');
    expect(fromBaseUnits('1', 0)).toBe('1');
  });
});
