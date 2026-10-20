// @vitest-environment node
// Reads the program's own vectors off disk.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as B from './bitmap';
import { ClmmMathError, MAX_TICK, MIN_TICK } from './math';
import type { BitmapExtensionView } from './program';

/**
 * The band search, held to the program's own Rust run on random maps
 * (__fixtures__/program-vectors.json, section bandSearch): the pool's own map, the far-band
 * map, and the pool-level walk a swap makes, at spacings 1, 10, 60 and 120. The recorded
 * mainnet pools then check the same code on real maps (program.test.ts).
 */

type Outcome = { ok: unknown } | { err: string };
const V = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', 'program-vectors.json'), 'utf8')) as {
  bandSearch: [number, number[], number[][], number[][], unknown[][]][];
};
const PANICS = new Set(['ArithmeticOverflow', 'DivideByZero', 'IndexOutOfBounds']);

function run(f: () => unknown): Outcome {
  try {
    return { ok: f() };
  } catch (e) {
    if (!(e instanceof ClmmMathError)) throw e;
    return { err: PANICS.has(e.code) ? 'panic' : e.code };
  }
}

/** Set-bit indexes back to little-endian u64 words. */
function words(bits: number[], count: number): bigint[] {
  const w = new Array<bigint>(count).fill(0n);
  for (const b of bits) w[b >> 6] = w[b >> 6]! | (1n << BigInt(b & 63));
  return w;
}

describe('the band search matches the program, query for query', () => {
  it('covers found, not found and refused at every spacing', () => {
    const outcomes = V.bandSearch.flatMap((c) => c[4].flatMap((q) => q.slice(2) as Outcome[]));
    expect(outcomes.some((o) => 'ok' in o && Array.isArray(o.ok) && o.ok[0] === true)).toBe(true);
    expect(outcomes.some((o) => 'ok' in o && Array.isArray(o.ok) && o.ok[0] === false)).toBe(true);
    expect(outcomes.some((o) => 'ok' in o && o.ok === null)).toBe(true);
    expect(outcomes.some((o) => 'err' in o)).toBe(true);
    expect(new Set(V.bandSearch.map((c) => c[0]))).toEqual(new Set([1, 10, 60, 120]));
  });

  it.each(V.bandSearch.map((c, i) => [i, c[0], c] as const))('case %i (spacing %i)', (_, spacing, c) => {
    const [, poolBits, pos, neg, queries] = c;
    const bitmap = words(poolBits, 16);
    const ext: BitmapExtensionView = {
      address: 'x',
      poolId: 'x',
      positiveTickArrayBitmap: pos.map((b) => words(b, 8)),
      negativeTickArrayBitmap: neg.map((b) => words(b, 8)),
    };
    const big = B.wordsToBigInt(bitmap);
    for (const q of queries) {
      const [tick, zfo, inPool, current, walk, first, inExt, extInit] = q as [number, boolean, ...Outcome[]];
      const pool = { tickArrayBitmap: bitmap, tickSpacing: spacing, tickCurrent: tick };
      const start = B.getArrayStartIndex(tick, spacing);
      const label = `tick ${tick} zfo ${zfo}`;
      expect(run(() => B.nextInitializedTickArrayStartIndexInPool(big, start, spacing, zfo)), `in pool, ${label}`).toEqual(inPool);
      expect(run(() => B.checkCurrentTickArrayIsInitialized(big, tick, spacing)), `current, ${label}`).toEqual(current);
      expect(run(() => B.nextInitializedTickArrayStartIndex(pool, ext, start, zfo)), `walk, ${label}`).toEqual(walk);
      expect(run(() => B.firstInitializedTickArray(pool, ext, zfo)), `first, ${label}`).toEqual(first);
      expect(run(() => B.nextInitializedTickArrayFromOneBitmap(ext, start, spacing, zfo)), `in extension, ${label}`).toEqual(inExt);
      expect(run(() => B.extensionTickArrayIsInitialized(ext, start, spacing)), `extension bit, ${label}`).toEqual(extInit);
    }
  });
});

describe('start indexes', () => {
  it('round toward minus infinity, as the program does', () => {
    expect(B.getArrayStartIndex(0, 60)).toBe(0);
    expect(B.getArrayStartIndex(3599, 60)).toBe(0);
    expect(B.getArrayStartIndex(3600, 60)).toBe(3600);
    expect(B.getArrayStartIndex(-1, 60)).toBe(-3600);
    expect(B.getArrayStartIndex(-3600, 60)).toBe(-3600);
    expect(B.getArrayStartIndex(-3601, 60)).toBe(-7200);
  });

  it('the lowest band may start below MIN_TICK; nothing may start above MAX_TICK', () => {
    const low = B.getArrayStartIndex(MIN_TICK, 120);
    expect(low).toBeLessThan(MIN_TICK);
    expect(B.checkIsValidStartIndex(low, 120)).toBe(true);
    expect(B.checkIsValidStartIndex(low - 7200, 120)).toBe(false);
    expect(B.checkIsValidStartIndex(MAX_TICK + 1, 120)).toBe(false);
  });

  it('from spacing 15 up, the pool’s own map holds every band and the far-band map is never read', () => {
    for (const s of [15, 60, 120]) {
      expect(B.isOverflowDefaultTickarrayBitmap(s, [MIN_TICK, MAX_TICK])).toBe(false);
    }
    expect(B.isOverflowDefaultTickarrayBitmap(1, [30_720])).toBe(true);
    expect(B.isOverflowDefaultTickarrayBitmap(1, [30_719, -30_720])).toBe(false);
  });
});
