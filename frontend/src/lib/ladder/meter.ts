// Sub-second DISPLAY smoothing for a figure the program advances once per whole second.
//
// This file contains no clock and no React. It is a pure function of (a way to ask
// what was earned at an integer second, some milliseconds) so the honesty guarantee
// below can be proven by a test rather than argued about.

/**
 * ── WHY SMOOTHING IS NEEDED AT ALL ───────────────────────────────────────────
 *
 * `earnedNow(position, pool, nowSecs)` is a STEP function of wall-clock time.
 * `lastTimeApplicable` opens with `BigInt(Math.floor(nowSecs))`, so every fractional
 * instant inside second T produces a byte-identical bigint to second T itself:
 * `earnedNow(p, pool, 12.0)` and `earnedNow(p, pool, 12.999)` are the same number.
 *
 * So ticking a clock at 60Hz and feeding it straight to `earnedNow` buys NOTHING.
 * The figure would still jump once a second, just re-rendered sixty times between
 * jumps. Fractional seconds are *safe* to pass — they are simply ignored — which is
 * precisely why they cannot produce a meter on their own. Anything that moves faster
 * than 1Hz has to be interpolation, and interpolation is where a number gets to lie.
 *
 * ── THE GUARANTEE THIS CHOOSES, AND WHY ──────────────────────────────────────
 *
 * The staker reading "Earned, unclaimed" is reading the number they are about to
 * press Claim against. The only tolerable error direction is DOWN. So this
 * interpolates between the PREVIOUS second and the CURRENT one — it LAGS, and it
 * never LEADS:
 *
 *     display(t + f) = earned(t-1) + floor( (earned(t) - earned(t-1)) * f )
 *
 * for f in [0, 1). `earned` is non-decreasing in t, so the result is bounded below by
 * earned(t-1) and STRICTLY below earned(t) for every f < 1. And earned(t) is exactly
 * what `earnedNow` returns at any instant inside second t, by the truncation above.
 * Therefore, at every instant:
 *
 *     smoothedRaw(...) <= earnedNow(position, pool, thatSameInstant)          (I)
 *
 * The price is up to one second of accrual in visible lag — on the live BAYLA pool
 * that is about 0.0053 BAYLA, below the last digit the card prints.
 *
 * The rejected alternative, interpolating from earned(t) TOWARDS earned(t+1), looks
 * identical and is a lie: it renders money the program would refuse to pay, because
 * that second has not happened yet. Overstating an unclaimable balance is this
 * repo's most-repeated defect class, so it is not on the table however smooth it is.
 *
 * ── STOPPING ─────────────────────────────────────────────────────────────────
 *
 * Nothing here knows or needs to know WHY accrual stopped, and no flag is cached:
 *
 *   · past `period_finish`, `lastTimeApplicable` pins dt, so earned stops moving;
 *   · with `total_weighted` at 0 or under the invariant I-11 floor,
 *     `rewardPerWeightNow` returns `rewardPerWeightStored` untouched;
 *   · a window that was never funded never moved the accumulator at all;
 *   · a degraded pool that has also stopped paying falls into one of the above.
 *
 * In each case earned(t-1) === earned(t), the step is zero, and this returns the
 * exact figure with no interpolation whatsoever. The meter freezes because the math
 * froze. There is no separate "should I stop" branch that could disagree with it.
 *
 * ── TAB RESTORE ──────────────────────────────────────────────────────────────
 *
 * This is a pure function of the clock. It holds no accumulator and no previous
 * frame, so a tab that was hidden for an hour cannot resume from a stale figure and
 * creep up to the truth — the first call after restore already IS the truth (minus
 * the sub-second lag). That property is structural, not a fix-up path.
 */

/** Fixed-point scale for the sub-second fraction. 1e6 = microseconds of a second. */
const FRACTION_SCALE = 1_000_000n;

/**
 * The figure to PRINT right now, given a way to ask what was earned at a whole second.
 *
 * `earnedAt` must be the real `earnedNow` bound to a position and a pool — the same
 * accumulator the program runs — not an approximation of it.
 */
export function smoothedRaw(earnedAt: (secs: number) => bigint, nowMs: number): bigint {
  const ms = Math.floor(nowMs);
  const sec = Math.floor(ms / 1000);

  const current = earnedAt(sec);
  const previous = earnedAt(sec - 1);

  // Not advancing (or the clock went backwards, e.g. an NTP step): there is nothing to
  // interpolate across, and the exact value is both the honest answer and a frozen one.
  if (current <= previous) return current;

  // ms - sec*1000 is in [0, 1000) for any ms, including negative ones, because both
  // floors round towards minus infinity.
  const fraction = BigInt(ms - sec * 1000) * 1_000n; // [0, 1e6)
  // bigint division truncates, and every term here is non-negative, so this floors.
  // Flooring is what keeps (I) an inequality rather than a rounding argument.
  return previous + ((current - previous) * fraction) / FRACTION_SCALE;
}

/**
 * Is this figure actually advancing at `nowMs`?
 *
 * Used only to decide whether to burn a 60Hz animation frame loop. It is deliberately
 * the SAME comparison `smoothedRaw` makes, so the loop can never keep running on a
 * figure that is frozen, nor idle on one that is moving.
 */
export function isAccruing(earnedAt: (secs: number) => bigint, nowMs: number): boolean {
  const sec = Math.floor(Math.floor(nowMs) / 1000);
  return earnedAt(sec) > earnedAt(sec - 1);
}
