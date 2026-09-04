import { describe, it, expect } from 'vitest';
import { pickFeeMint, toBaseUnits, fromBaseUnits } from '../jupiter';
import { SOL_MINT, USDC_MINT } from '../solana';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

const NEWLINE = String.fromCharCode(10);

describe('fromBaseUnits strips trailing zeros without a backtracking regex', () => {
  // CodeQL flagged the old `/0+$/` at HIGH (js/polynomial-redos). The two
  // implementations produce IDENTICAL output, so a behavioural test cannot tell
  // them apart — which is exactly why the regex survived review. The property
  // that actually differs is complexity, and `decimals` is not ours to bound: it
  // comes off the token, so a hostile mint declaring a large value chooses the
  // length of the string this walks.
  it('handles a pathological all-zeros fraction', () => {
    // CORRECTED: the first of these is the FAST case, not the quadratic one. An
    // all-zeros fraction lets `/0+$/` match at position 0 and run straight to the
    // anchor, so it never backtracks. The quadratic shape is the SECOND line -
    // zeros that do NOT reach the end - because `$` then rejects and the engine
    // restarts at every zero in the run.
    //
    // Both survive either implementation at this size, which is the point of the
    // case below: measured against the old regex, 5000 characters is only ~1e7
    // steps and passes in milliseconds. These two pin OUTPUT on long input; they
    // are not, and were never, evidence about complexity.
    expect(fromBaseUnits(`1${'0'.repeat(5000)}`, 5000)).toBe('1');
    expect(fromBaseUnits(`${'0'.repeat(5000)}1`, 5000)).toContain('.');
  });

  // A BEHAVIOURAL TEST *CAN* TELL THEM APART - IT JUST HAS TO BE BIG ENOUGH.
  //
  // The note at the top of this block says a behavioural test cannot separate the
  // two implementations because their output is identical. That is true of output
  // and false of cost, and cost is observable: past some length the quadratic one
  // simply does not return. 5000 characters is far below that line; 200k is well
  // over it.
  //
  // MEASURED, both directions, 2026-09-04 - restore `/0+$/` and this case times
  // out at 5000ms (the engine ran ~21s before the runner gave up) while all the
  // other cases in this file, including the pathological one above, still PASS.
  // That is what makes this the discriminating test and them the output pins.
  //
  // Deliberately NO wall-clock assertion: a millisecond budget is the classic
  // flake on a loaded runner. The guard is vitest's own 5s test timeout, and a
  // linear scan of 200k characters is sub-millisecond even on a busy box.
  it('returns at all on a 200k run of zeros that does not reach the end', () => {
    const decimals = 200_000;
    const raw = `1${'0'.repeat(decimals - 1)}7`;
    expect(fromBaseUnits(raw, decimals)).toBe(`1.${'0'.repeat(decimals - 1)}7`);
  });

  it('still trims exactly as before on ordinary values', () => {
    expect(fromBaseUnits('500000000', 9)).toBe('0.5');
    expect(fromBaseUnits('1000000', 6)).toBe('1');
    expect(fromBaseUnits('1000001', 6)).toBe('1.000001');
    expect(fromBaseUnits('0', 6)).toBe('0');
  });

  it('names no backtracking-prone regex in the module source', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'jupiter.ts'),
      'utf8',
    );
    expect(src.length, 'the module source could not be read').toBeGreaterThan(500);
    // Comments are stripped FIRST. The fix's own comment names the regex it
    // replaced — as it should, so the next reader knows why the loop is there —
    // and without this the guard would fail on its own documentation. (That is
    // not hypothetical: it did, on the first run.)
    const code = src
      .split(NEWLINE)
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join(NEWLINE);
    expect(code.length, 'stripping comments removed the whole module').toBeGreaterThan(500);
    expect(code.includes('/0+$/'), 'the quadratic trailing-zero regex is back').toBe(false);
  });
});
