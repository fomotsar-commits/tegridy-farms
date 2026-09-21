// The HONESTY PIN for the live reward meter.
//
// The meter exists to make a number move between the whole seconds the program
// actually advances it on. Every way of doing that is a small lie about a balance
// somebody is about to press Claim against, so the only question that matters is
// WHICH DIRECTION the lie points. This file pins it pointing down.
//
// The fixtures are the LIVE mainnet pool's own numbers (rate 0.005506 BAYLA/s against
// 82,654.49 total weight, the owner's 20,000 at the four-year rung) so the bounds
// below are the bounds the real card is running under, not a tidy invented pool.
import { describe, it, expect } from 'vitest';
import { smoothedRaw, isAccruing } from './meter';
import { earnedNow, type LadderPoolView, type LadderPositionView } from './program';

const NOW = 1_800_000_000;
const DAY = 86_400;

/** The live BAYLA ladder, as read from `Bq6jov…XTXV`. */
const pool = (o: Partial<LadderPoolView> = {}) => ({
  minStakeRaw: 100_000_000n,          // 100 BAYLA
  totalWeighted: 82_654_490_000n,     // 82,654.49 whole
  rewardRate: 5_506n,                 // 0.005506 BAYLA/sec
  periodFinish: BigInt(NOW + 90 * DAY),
  lastUpdateTime: BigInt(NOW - DAY),
  rewardPerWeightStored: 0n,
  rpwResidueRaw: 0n,
  ...o,
}) as unknown as LadderPoolView;

/** The owner's position: 20,000 BAYLA at 4y, weight 80,000. */
const position = (o: Partial<LadderPositionView> = {}) => ({
  weight: 80_000_000_000n,
  rewardPerWeightPaid: 0n,
  rewardsOwed: 0n,
  ...o,
}) as unknown as LadderPositionView;

const bind = (p: LadderPositionView, pl: LadderPoolView) => (secs: number) => earnedNow(p, pl, secs);

describe('the meter moves', () => {
  it('climbs between two instants inside the SAME second — which earnedNow alone never does', () => {
    const at = bind(position(), pool());
    // The premise of the whole feature: `earnedNow` truncates, so these are equal…
    expect(at(NOW)).toBe(at(NOW + 0.75));
    // …and the meter is what puts movement between them.
    const early = smoothedRaw(at, NOW * 1000 + 100);
    const late = smoothedRaw(at, NOW * 1000 + 900);
    expect(late).toBeGreaterThan(early);
  });

  it('advances 5,329 raw units a second — the program\'s figure, NOT the pro-rata estimate', () => {
    const at = bind(position(), pool());
    const perSec = at(NOW + 1) - at(NOW);

    // The handover note rounds this to "about 5,330 raw units/sec". The program pays
    // 5,329. Both of the accumulator's floors — landing the interval in
    // `rewardPerWeightNow`, then drawing the share out in `earnedNow` — happen to be
    // free at this weight, so the shortfall is nothing but the rounding in that note:
    //   5506 x 80_000e6 / 82_654.49e6 = 5329.06… -> 5329.
    // Pinned at the program's figure, not the note's, because a browser check that
    // measured 5,329 against an expectation of 5,330 would read as a defect.
    expect((5_506n * 80_000_000_000n) / 82_654_490_000n).toBe(5_329n);
    expect(perSec).toBe(5_329n);
  });

  it('never goes backwards as the clock runs forward', () => {
    const at = bind(position(), pool());
    let prev = -1n;
    for (let ms = NOW * 1000; ms < NOW * 1000 + 4_000; ms += 37) {
      const v = smoothedRaw(at, ms);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('⚠️ the meter NEVER reads higher than what is claimable', () => {
  // THE load-bearing test. Interpolating forwards (t → t+1) instead of backwards
  // (t-1 → t) passes every other test in this file and fails only this one.
  it('stays at or below earnedNow() at the very same instant, across a whole second', () => {
    const at = bind(position(), pool());
    for (let ms = NOW * 1000; ms < NOW * 1000 + 3_000; ms += 13) {
      const claimable = earnedNow(position(), pool(), ms / 1000);
      expect(smoothedRaw(at, ms)).toBeLessThanOrEqual(claimable);
    }
  });

  it('lags by strictly less than one second of accrual, so it is smoothing and not a freeze', () => {
    const at = bind(position(), pool());
    const claimable = at(NOW + 2);
    const shown = smoothedRaw(at, (NOW + 2) * 1000 + 500);
    expect(shown).toBeLessThan(claimable);
    expect(claimable - shown).toBeLessThanOrEqual(at(NOW + 2) - at(NOW + 1));
  });

  it('is exact, not merely under, on the whole second itself', () => {
    const at = bind(position(), pool());
    expect(smoothedRaw(at, (NOW + 5) * 1000)).toBe(at(NOW + 4));
  });

  it('rounds DOWN — a half-second shows floor(half a second of accrual), never the ceiling', () => {
    const at = bind(position(), pool());
    const step = at(NOW + 1) - at(NOW);          // 5_330n
    const half = smoothedRaw(at, (NOW + 1) * 1000 + 500) - at(NOW);
    expect(half).toBe(step / 2n);                // 2_665n, floored
    expect(half).toBeLessThanOrEqual(step / 2n);
  });
});

describe('⚠️ the meter stops when accrual stops', () => {
  it('freezes past periodFinish', () => {
    const p = pool({ periodFinish: BigInt(NOW - 10) });
    const at = bind(position(), p);
    const a = smoothedRaw(at, NOW * 1000 + 100);
    const b = smoothedRaw(at, (NOW + 60) * 1000 + 900);
    expect(b).toBe(a);
    expect(isAccruing(at, NOW * 1000)).toBe(false);
  });

  it('freezes exactly AT periodFinish, not a second after it', () => {
    const p = pool({ periodFinish: BigInt(NOW) });
    const at = bind(position(), p);
    expect(smoothedRaw(at, (NOW + 3) * 1000 + 400)).toBe(at(NOW));
  });

  it('freezes when nothing is staked (totalWeighted 0)', () => {
    const p = pool({ totalWeighted: 0n });
    const at = bind(position(), p);
    expect(isAccruing(at, NOW * 1000)).toBe(false);
    expect(smoothedRaw(at, (NOW + 30) * 1000 + 700)).toBe(smoothedRaw(at, NOW * 1000));
  });

  it('freezes below the invariant I-11 weight floor, where the interval is burned not banked', () => {
    // minStake 100 BAYLA at the 0.40x base boost → a 40 BAYLA floor. Under it the
    // program does not advance the accumulator at all, and neither may the meter.
    const p = pool({ totalWeighted: 1_000_000n });   // 1 BAYLA of weight
    const at = bind(position(), p);
    expect(isAccruing(at, NOW * 1000)).toBe(false);
  });

  it('freezes on a window that was NEVER funded', () => {
    const p = pool({ rewardRate: 0n, periodFinish: 0n, lastUpdateTime: 0n });
    const at = bind(position(), p);
    expect(isAccruing(at, NOW * 1000)).toBe(false);
    expect(smoothedRaw(at, NOW * 1000 + 500)).toBe(0n);
  });

  it('a frozen pool still shows what was BANKED, and shows it exactly', () => {
    // A degraded/ended pool with rewards already owed must not render 0, and must not
    // render a smoothed approximation of a number that is no longer moving.
    const p = pool({ periodFinish: BigInt(NOW - 10) });
    const at = bind(position({ rewardsOwed: 1_234_567n }), p);
    expect(smoothedRaw(at, NOW * 1000 + 600)).toBe(at(NOW));
    expect(smoothedRaw(at, NOW * 1000 + 600)).toBeGreaterThan(1_234_567n);
  });
});

describe('the meter is a function of the clock, not of its own history', () => {
  it('the same millisecond always produces the same figure, however it was reached', () => {
    const at = bind(position(), pool());
    const direct = smoothedRaw(at, (NOW + 3_600) * 1000 + 250);
    // Walk there one frame at a time; a stateful meter would land somewhere else.
    for (let ms = NOW * 1000; ms < NOW * 1000 + 2_000; ms += 16) smoothedRaw(at, ms);
    expect(smoothedRaw(at, (NOW + 3_600) * 1000 + 250)).toBe(direct);
  });

  it('a clock that steps BACKWARDS reads down, and never invents a bigger balance', () => {
    const at = bind(position(), pool());
    const ahead = smoothedRaw(at, (NOW + 100) * 1000);
    const behind = smoothedRaw(at, (NOW + 50) * 1000);
    expect(behind).toBeLessThan(ahead);
    expect(behind).toBeLessThanOrEqual(earnedNow(position(), pool(), NOW + 50));
  });
});
