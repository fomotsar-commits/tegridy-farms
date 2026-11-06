/**
 * When a round trip at the planned size falls short at Jupiter's real quote, a smaller one may
 * still pay: the planned size comes from Jupiter's LISTED price, and on a thin coin the real route
 * is worse than that, so the best size is smaller than planned. On x·y = k the trip's gain rises
 * then falls with its size; the keeper asks Jupiter at half the size, fits Jupiter's leg to those
 * two quotes as one x·y = k pool, and finds the best size on that fit with our pool's own maths.
 * The fit only picks which size to ask about: every trip is still quoted, test-run and held to its
 * floor by the chain at the size it is sent.
 */

/** Smaller sizes are tried only when the planned one falls short by at most this share of what goes in. */
export const NEAR_MISS_BPS = 100n;

/** Whether a trip that brings back `back` for `coinIn`, needing `need`, is close enough to paying to try smaller. */
export function nearMiss(coinIn: bigint, back: bigint, need: bigint): boolean {
  return coinIn > 1n && back < need && (need - back) * 10_000n <= NEAR_MISS_BPS * coinIn;
}

/** How far short a trip falls, as a share of what goes in; 0 when it pays. */
export function shortShare(coinIn: bigint, back: bigint, need: bigint): number {
  return coinIn > 0n && back < need ? Number(need - back) / Number(coinIn) : 0;
}

/** Jupiter's leg as one x·y = k pool: `u` in brings `a·u / (b + u)` out. */
export interface FittedLeg {
  a: number;
  b: number;
}

/**
 * The x·y = k pool through two of Jupiter's quotes (`u` in, `out` out), or null when no such pool
 * fits them: 1/out = (b/a)·(1/u) + 1/a is a line through the two points.
 */
export function fitLeg(u1: number, out1: number, u2: number, out2: number): FittedLeg | null {
  if (!(u1 > 0 && u2 > 0 && out1 > 0 && out2 > 0) || u1 === u2) return null;
  const slope = (1 / out1 - 1 / out2) / (1 / u1 - 1 / u2);
  const intercept = 1 / out1 - slope / u1;
  if (!(slope > 0 && intercept > 0) || !Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  const a = 1 / intercept;
  return { a, b: slope * a };
}

export const legOut = (f: FittedLeg, u: number): number => (u > 0 ? (f.a * u) / (f.b + u) : 0);

/**
 * The size in [1, most] at which `gain` is largest, for a gain that rises then falls with size
 * (a ternary search). `gain` is the fitted trip's: what comes back less what went in.
 */
export function bestSize(most: bigint, gain: (x: bigint) => number): bigint {
  let lo = 1;
  let hi = Number(most);
  if (!(hi > 1)) return most;
  for (let i = 0; i < 80 && hi - lo > 1; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (gain(BigInt(Math.floor(m1))) < gain(BigInt(Math.floor(m2)))) lo = m1;
    else hi = m2;
  }
  const x = BigInt(Math.floor((lo + hi) / 2));
  return x < 1n ? 1n : x > most ? most : x;
}
