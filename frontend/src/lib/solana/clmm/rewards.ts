import { ClmmMathError, Q64, U128_MAX, U64_MAX, mulDivCeil, mulDivFloor } from './math';
import type { PersonalPositionView, PoolStateView, RewardInfoView, TickStateView } from './program';

/**
 * A position's rewards owed, worked out the way the range program works them out when the
 * position is changed (a take-out of 0 included): pool.rs `update_reward_infos` to the
 * chain's clock, tick_array.rs `get_reward_growths_inside` from the position's two ticks,
 * then personal_position.rs `update_rewards`. Ported line for line, rounding included.
 */

const wrap128 = (v: bigint) => BigInt.asUintN(128, v);

/** pool.rs `RewardState`. */
export const REWARD_STATE = { uninitialized: 0, initialized: 1, opening: 2, ended: 3 } as const;

/**
 * pool.rs `update_reward_infos`, on a copy, at the chain's unix time `now`. Every change to
 * the pool's liquidity runs it first, so the liquidity has not moved since `lastUpdateTime`
 * and this is what the program would write at `now`, not an estimate.
 */
export function rewardInfosAt(pool: Pick<PoolStateView, 'liquidity' | 'rewardInfos'>, now: bigint): RewardInfoView[] {
  return pool.rewardInfos.map((r) => {
    const next = { ...r };
    if (!r.initialized || r.rewardTotalEmitted === U64_MAX) return next;
    if (now <= r.openTime) return next;
    const latest = now < r.endTime ? now : r.endTime;
    if (pool.liquidity !== 0n) {
      const timeDelta = latest > r.lastUpdateTime ? latest - r.lastUpdateTime : 0n;
      if (timeDelta === 0n) return next;
      // Emitted rounds up and growth rounds down, so what positions can claim never passes what was emitted.
      const rewardDelta = mulDivCeil(timeDelta, r.emissionsPerSecondX64, Q64, U128_MAX) ?? 0n;
      let growthDelta = mulDivFloor(timeDelta, r.emissionsPerSecondX64, pool.liquidity, U128_MAX) ?? 0n;
      const remain = U64_MAX - r.rewardTotalEmitted;
      if (rewardDelta <= remain) {
        next.rewardTotalEmitted = r.rewardTotalEmitted + rewardDelta;
      } else {
        next.rewardTotalEmitted = U64_MAX;
        growthDelta = mulDivFloor(remain, Q64, pool.liquidity, U128_MAX) ?? 0n;
      }
      next.rewardGrowthGlobalX64 = wrap128(r.rewardGrowthGlobalX64 + growthDelta);
    }
    next.lastUpdateTime = latest;
    if (latest >= r.openTime && latest < r.endTime) next.rewardState = REWARD_STATE.opening;
    else if (latest === r.endTime) next.rewardState = REWARD_STATE.ended;
    return next;
  });
}

type TickRewards = Pick<TickStateView, 'tick' | 'rewardGrowthsOutsideX64'>;

/** tick_array.rs `get_reward_growths_inside`: each reward's growth per unit of liquidity inside the range. */
export function getRewardGrowthsInside(lower: TickRewards, upper: TickRewards, tickCurrent: number, infos: RewardInfoView[]): bigint[] {
  return infos.map((r, i) => {
    if (!r.initialized) return 0n;
    const lo = lower.rewardGrowthsOutsideX64[i] ?? 0n;
    const hi = upper.rewardGrowthsOutsideX64[i] ?? 0n;
    const below = tickCurrent >= lower.tick ? lo : wrap128(r.rewardGrowthGlobalX64 - lo);
    const above = tickCurrent < upper.tick ? hi : wrap128(r.rewardGrowthGlobalX64 - hi);
    return wrap128(r.rewardGrowthGlobalX64 - below - above);
  });
}

/**
 * personal_position.rs `update_rewards` with `add_delta`: each reward owed once growth
 * inside reaches `inside`. A delta at or past u64::MAX counts 0 (`to_underflow_u64`); an
 * owed total past u64 is the program's CalculateOverflow, so the change would fail.
 */
export function rewardsOwedAfter(position: Pick<PersonalPositionView, 'liquidity' | 'rewardInfos'>, inside: bigint[]): bigint[] {
  return position.rewardInfos.map((r, i) => {
    const delta = wrap128((inside[i] ?? 0n) - r.growthInsideLastX64);
    const v = mulDivFloor(delta, position.liquidity, Q64, U128_MAX) ?? 0n;
    const owed = r.rewardAmountOwed + (v < U64_MAX ? v : 0n);
    if (owed > U64_MAX) throw new ClmmMathError('CalculateOverflow');
    return owed;
  });
}

/** One running reward of the pool, and what this position is owed of it. */
export interface RewardOwed {
  /** The reward's slot in the pool, 0 to 2. */
  index: number;
  mint: string;
  owed: bigint;
}

/**
 * What a position is owed of each reward its pool runs, if it were changed at the chain's
 * time `now`. An empty position earns nothing more, so it is owed what its record says.
 * Null when it could not be worked out: no clock, a tick that did not read, or a sum the
 * program would refuse. Never a zero standing in for an unknown.
 */
export function positionRewardsAt(
  pool: Pick<PoolStateView, 'liquidity' | 'rewardInfos' | 'tickCurrent'>,
  position: Pick<PersonalPositionView, 'liquidity' | 'rewardInfos' | 'tickLowerIndex' | 'tickUpperIndex'>,
  lower: TickRewards | null,
  upper: TickRewards | null,
  now: bigint | null,
): RewardOwed[] | null {
  const live = pool.rewardInfos.map((r, index) => ({ r, index })).filter((x) => x.r.initialized);
  if (live.length === 0) return [];
  const pick = (owed: bigint[]) => live.map(({ r, index }) => ({ index, mint: r.tokenMint, owed: owed[index] ?? 0n }));
  if (position.liquidity === 0n) return pick(position.rewardInfos.map((r) => r.rewardAmountOwed));
  if (now === null || !lower || !upper || lower.tick !== position.tickLowerIndex || upper.tick !== position.tickUpperIndex) return null;
  try {
    const inside = getRewardGrowthsInside(lower, upper, pool.tickCurrent, rewardInfosAt(pool, now));
    return pick(rewardsOwedAfter(position, inside));
  } catch (e) {
    if (e instanceof ClmmMathError) return null;
    throw e;
  }
}
