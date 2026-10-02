import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { smoothedRaw, isAccruing } from '../lib/ladder/meter';

/**
 * Drive a reward figure as a LIVE METER, without asking the chain anything.
 *
 * ── WHY THIS COSTS NO RPC ────────────────────────────────────────────────────
 * Accrual is a closed-form function of the clock and of four fields that came out of
 * ONE pool read already in hand: `rewardRate`, `totalWeighted`, `periodFinish` and
 * the stored accumulator. `earnedNow` replays the program's own arithmetic over them.
 * Running that replay at 60Hz is 60 bigint multiplications a second and zero network
 * calls. The caller re-syncs those fields on its own, slower schedule; this hook
 * never fetches, and nothing here is on a code path that can.
 *
 * ── WHY NOT `CountUpText`, THE SHARED ROLL-UP ────────────────────────────────
 * `components/motion/CountUpText` is the house number-animator and is the right tool
 * almost everywhere, but it is the wrong one HERE, for two specific reasons:
 *
 *   1. It is a SPRING (`useSpring`). A spring's position is a function of its own
 *      history, not of the clock. That is exactly the hidden-tab trap this project
 *      has already recorded: a tab hidden for an hour comes back with a stale spring
 *      that would visibly CREEP up to the true balance over a second or two. The
 *      figure must JUMP to the truth. A clock-derived value does that by
 *      construction; a spring cannot.
 *   2. A spring's overshoot behaviour is a tuning parameter, not a guarantee. The
 *      "never reads higher than claimable" rule has to be provable, and
 *      `smoothedRaw` makes it an inequality a test can pin.
 *
 * So this reuses the shared motion system where the shared system applies — framer's
 * `useReducedMotion`, which reads the same app-wide `MotionConfig reducedMotion="user"`
 * setup App.tsx installs — and adds NO animation dependency of its own. The movement
 * is a value changing, not a transform being tweened, so there is nothing for a
 * motion library to do.
 *
 * ── REDUCED MOTION ───────────────────────────────────────────────────────────
 * Under `prefers-reduced-motion` the interpolation is dropped entirely: a plain
 * once-a-second update of the EXACT figure. Slower, no sub-second movement, and
 * strictly more accurate rather than less.
 *
 * @param earnedAt `earnedNow` bound to a position (or a sum of them) and a pool, or
 *                 null when there is nothing readable — which renders as an outage
 *                 upstream, never as a zero.
 */
export function useAccrualMeter(earnedAt: ((secs: number) => bigint) | null): bigint | null {
  const reduce = useReducedMotion();

  // ── THE VALUE IS DERIVED IN RENDER, NOT STORED ──────────────────────────────
  // Reading the clock during render is deliberate. The alternative — keeping the
  // figure in state and writing it from the effect — leaves one frame in which the
  // rendered number was computed from the PREVIOUS `earnedAt`. That is not merely
  // stale: if the re-sync that replaced it brought a larger `totalWeighted` (another
  // staker arrived), the old projection is HIGHER than the new truth, and the honesty
  // guarantee would be broken for that frame. Deriving here means the figure is always
  // computed from the `earnedAt` currently in hand.
  //
  // `react-hooks/purity` is right that this is an impure render, and it is disabled
  // knowingly rather than worked around: a clock reading is the ONE input that cannot
  // be hoisted out without reintroducing the stale frame above. Everything else about
  // the render stays pure, and the value is a function of the clock alone, so a
  // re-render at any moment produces the correct figure for that moment.
  // eslint-disable-next-line react-hooks/purity
  const now = () => Date.now();
  const value = earnedAt
    ? (reduce ? earnedAt(Math.floor(now() / 1000)) : smoothedRaw(earnedAt, now()))
    : null;

  // State here is nothing but a re-render pump, and it is nudged only when the figure
  // actually changed. A frozen pool therefore costs no renders at all.
  const [, pump] = useState(0);

  useEffect(() => {
    if (!earnedAt) return;

    // The last figure a tick produced, so an unchanged one schedules no render. It is
    // effect-local rather than a ref because the effect's lifetime is exactly the
    // window over which the comparison is meaningful — it restarts whenever `earnedAt`
    // or `reduce` changes, which is precisely when the old figure stops being
    // comparable. (Sound because accrual is monotonic in the clock: any render landing
    // between two ticks that agree must itself have computed the same figure.)
    let last = reduce ? earnedAt(Math.floor(Date.now() / 1000)) : smoothedRaw(earnedAt, Date.now());

    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      // ⚠️ ALWAYS FROM `Date.now()`, NEVER FROM AN ACCUMULATED COUNTER. This is the
      // whole hidden-tab defence: a throttled or frozen loop simply misses frames,
      // and the next one it does run reads the true wall clock and lands on the true
      // value. There is no counter to fall behind.
      const now = Date.now();
      const next = reduce ? earnedAt(Math.floor(now / 1000)) : smoothedRaw(earnedAt, now);
      if (next !== last) { last = next; pump((n) => n + 1); }

      if (!reduce && isAccruing(earnedAt, now)) {
        frame = requestAnimationFrame(tick);
      } else {
        // Frozen — or reduced-motion. Poll slowly instead of burning frames, so a
        // window that gets refunded, or a pool that comes back above the I-11 weight
        // floor on the next re-sync, starts moving again without a reload.
        timer = setTimeout(tick, 1000);
      }
    };

    tick();

    // requestAnimationFrame does not fire in a hidden tab and setTimeout is throttled
    // there, so on restore the meter could sit on a figure minutes old until the next
    // callback happens to land. Recompute the instant the tab is visible again.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      tick();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [earnedAt, reduce]);

  return value;
}
