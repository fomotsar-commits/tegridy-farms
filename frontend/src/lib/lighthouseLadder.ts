/**
 * Pure view-model math for the LOCKED EVM lighthouse (LighthouseLadder.sol).
 *
 * Everything the plain-pool module (evmLighthouse.ts) proved stays true here —
 * outages are never zeros, paying-now dies with the period — with two changes
 * the ladder forces:
 *
 *  1. THE VAULT IS READ, NOT DERIVED. The contract exposes `rewardSurplus()`
 *     (`balanceOf(pool) - totalSupply()`), which is the same quantity the
 *     plain-pool card had to compute in the UI. Reading it removes a whole
 *     class of drift between what the contract will pay and what the page
 *     claims — and it is the number that makes the exit promise true.
 *  2. A STAKER'S RATE DEPENDS ON THEIR LOCK. With boost weight in play,
 *     "what will I earn" is per-position, so the projections take a boost
 *     multiplier rather than assuming everyone earns the pool rate.
 */

export interface LadderReads {
  /** pool.totalSupply() — real principal across every position. */
  totalStakedRaw: bigint | null;
  /** pool.totalBoosted() — the accumulator's divisor. */
  totalBoostedRaw: bigint | null;
  /** pool.rewardSurplus() — payable rewards, principal excluded. */
  surplusRaw: bigint | null;
  /** pool.rewardRate() — reward raw units per second, pool-wide. */
  rewardRateRaw: bigint | null;
  /** pool.periodFinish() — unix seconds; 0 = never funded. */
  periodFinishSecs: bigint | null;
  /** pool.rewardsDuration() — seconds per notify cycle. */
  rewardsDurationSecs: bigint | null;
}

export interface LadderView {
  vaultRaw: bigint | null;
  /** True only while a funded period is running. */
  periodActive: boolean | null;
  /** Never funded at all — distinct from "the period ended". */
  everFunded: boolean | null;
  payingNowRawPerSec: bigint | null;
  configuredRawPerSec: bigint | null;
  runwaySecs: bigint | null;
  coreKnown: boolean;
}

export const MIN_LOCK_SECS = 7n * 24n * 60n * 60n;
export const MAX_LOCK_SECS = 4n * 365n * 24n * 60n * 60n;
/** TOWELI parity: 0.4x at seven days. */
export const MIN_BOOST_BPS = 4_000n;
export const MAX_BOOST_BPS = 40_000n;
export const PENALTY_BPS = 2_500n;
/**
 * The contract's `MIN_STAKE` — the 2026-09-04 dust-divisor floor.
 *
 * RAW UNITS, and deliberately NOT scaled by the pool's own `decimals`: it is a
 * plain constant in the contract (`100e18`), so the deploy script refuses any
 * staking token that is not 18-decimal precisely so the two agree. Mirrored
 * here so the panel can say "below the minimum" in words rather than letting
 * the user pay gas to discover it as a bare revert string.
 */
export const MIN_STAKE_RAW = 100n * 10n ** 18n;

export function deriveLadder(r: LadderReads, nowSecs: bigint): LadderView {
  const coreKnown =
    r.totalStakedRaw !== null &&
    r.totalBoostedRaw !== null &&
    r.surplusRaw !== null &&
    r.rewardRateRaw !== null &&
    r.periodFinishSecs !== null &&
    r.rewardsDurationSecs !== null;

  let periodActive: boolean | null = null;
  let everFunded: boolean | null = null;
  let payingNowRawPerSec: bigint | null = null;
  let runwaySecs: bigint | null = null;

  if (r.periodFinishSecs !== null) {
    // A pool that was NEVER notified has periodFinish 0. Collapsing that into
    // "the period ended" made the plain-pool card claim a last reward period
    // and a last notify that never happened — pinned as its own state here.
    everFunded = r.periodFinishSecs > 0n;
    periodActive = everFunded && nowSecs < r.periodFinishSecs;
    runwaySecs = periodActive ? r.periodFinishSecs - nowSecs : 0n;
    if (r.rewardRateRaw !== null) payingNowRawPerSec = periodActive ? r.rewardRateRaw : 0n;
  }

  return {
    vaultRaw: r.surplusRaw,
    periodActive,
    everFunded,
    payingNowRawPerSec,
    configuredRawPerSec: r.rewardRateRaw,
    runwaySecs,
    coreKnown,
  };
}

/** The ladder, exactly as the contract (and TegridyStaking) computes it. */
export function boostBpsFor(lockSecs: bigint): bigint {
  if (lockSecs <= MIN_LOCK_SECS) return MIN_BOOST_BPS;
  if (lockSecs >= MAX_LOCK_SECS) return MAX_BOOST_BPS;
  const range = MAX_LOCK_SECS - MIN_LOCK_SECS;
  const boostRange = MAX_BOOST_BPS - MIN_BOOST_BPS;
  return MIN_BOOST_BPS + ((lockSecs - MIN_LOCK_SECS) * boostRange) / range;
}

/** "4.00x" for a lock length — the number a staker is actually choosing. */
export function boostLabel(lockSecs: bigint): string {
  const bps = boostBpsFor(lockSecs);
  return `${(Number(bps) / 10_000).toFixed(2)}x`;
}

/**
 * A staker's share of the pool-wide rate, given the weight they would add.
 * Returns null when it cannot be known honestly — an unread pool, or a rate
 * that is not paying — rather than a flattering guess.
 *
 * NOTE the caveat this number always carries in the UI: it is computed at
 * TODAY's total weight, and every later staker dilutes it.
 */
export function projectedRawPerSec(
  view: LadderView,
  totalBoostedRaw: bigint | null,
  myBoostedRaw: bigint,
): bigint | null {
  if (view.payingNowRawPerSec === null || totalBoostedRaw === null) return null;
  if (view.payingNowRawPerSec === 0n) return 0n;
  const denom = totalBoostedRaw + myBoostedRaw;
  if (denom === 0n) return 0n;
  return (view.payingNowRawPerSec * myBoostedRaw) / denom;
}

/** What an early exit costs, in raw units. */
export function penaltyOn(amountRaw: bigint): bigint {
  return (amountRaw * PENALTY_BPS) / 10_000n;
}

/** Seconds until a lock opens; 0 once it has. */
export function lockRemaining(lockEndSecs: bigint, nowSecs: bigint): bigint {
  return lockEndSecs > nowSecs ? lockEndSecs - nowSecs : 0n;
}
