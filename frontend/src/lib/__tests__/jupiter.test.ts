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

  // The trailing-zero trim moved off `/0+$/` onto an index scan (ReDoS, see the
  // comment on the function). These pin that the TRIMMING RULE is unchanged, so
  // the rewrite cannot quietly alter a displayed balance. They pass on both the
  // old and the new implementation, on purpose - they guard the refactor, not
  // the vulnerability. The vulnerability is guarded by the case below them.
  it('trims only TRAILING zeros, and never a significant one', () => {
    expect(fromBaseUnits('1000001', 6)).toBe('1.000001');   // interior zeros kept
    expect(fromBaseUnits('1000000', 6)).toBe('1');          // whole fraction is zeros -> no point
    expect(fromBaseUnits('0', 6)).toBe('0');                // zero stays a bare zero
    expect(fromBaseUnits('1500000', 6)).toBe('1.5');        // trailing run collapses
    expect(fromBaseUnits('100', 6)).toBe('0.0001');         // leading pad kept, trailing trimmed
  });

  // THE REGRESSION THIS FILE EXISTS FOR.
  //
  // `/0+$/` is quadratic on a fraction whose zeros do NOT reach the end: the
  // engine starts a match at every zero in the run and backtracks the whole run
  // each time. The adversarial shape is therefore a long run of zeros followed
  // by ONE significant digit - which is a real balance, not a contrived string.
  //
  // Deliberately NO wall-clock assertion: a millisecond budget is exactly the
  // kind of threshold that flakes on a loaded CI box. The guard is vitest's own
  // 5s test timeout. A linear scan of 200k characters is sub-millisecond even on
  // a busy runner; the old regex is ~4e10 steps and cannot finish inside it. So
  // this test is instant when the fix is present and times out when it is not.
  it('stays linear on a long run of zeros that does not reach the end', () => {
    const decimals = 200_000;
    const raw = `1${'0'.repeat(decimals - 1)}7`;
    expect(fromBaseUnits(raw, decimals)).toBe(`1.${'0'.repeat(decimals - 1)}7`);
  });
});
