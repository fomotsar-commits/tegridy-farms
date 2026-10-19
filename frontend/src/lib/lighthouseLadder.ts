/**
 * Pure view-model math for the locked EVM lighthouse (LighthouseLadder.sol).
 * As in evmLighthouse.ts, an outage is never a zero and paying-now ends with the
 * period. The vault is read from `rewardSurplus()`, never derived in the UI, and
 * a projection takes the staker's own boost weight: with locks, a rate is per position.
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
/**
 * The cap of the ladder's law (LighthouseLadder.sol MAX_EARLY_EXIT_PENALTY_BPS):
 * leaving early costs the time left on the lock over four years, capped at 75%, as
 * the BAYLA ladder charges it (owner, 2026-10-18). The card never computes it: it
 * reads the pool's own quote for each position (penaltyFor).
 */
export const MAX_PENALTY_BPS = 7_500n;
/**
 * What the ladders the registry ships charge TODAY: the six of 2026-09-05, a flat
 * 25%. Build-time copy (llms.txt) says this; the card itself reads the pool. The
 * repin PR sets the schedule to 'time-left' and the number to MAX_PENALTY_BPS, and
 * scripts/verify-ladder-builds.mjs fails any shipped pool whose exit differs from
 * this pair, so the site and the chain cannot drift.
 */
export const LIVE_LADDER_EXIT_SCHEDULE: 'flat' | 'time-left' = 'flat';
export const LIVE_LADDER_EXIT_BPS = 2_500n;
/**
 * The contract's `MIN_STAKE` dust floor, in RAW units, not scaled by decimals:
 * it is a plain `100e18` in Solidity and the deploy script refuses any staking
 * token that is not 18-decimal. Mirrored so the panel says "below the minimum"
 * instead of letting the user pay gas for a bare revert.
 */
export const MIN_STAKE_RAW = 100n * 10n ** 18n;

/**
 * Ladder pools that must take no deposit: a build carrying C1, where a claim can
 * pay out of other stakers' principal (docs/LIGHTHOUSE_AUDIT_2026_09_01.md).
 * Keyed on the address, so the gate lifts when the registry repins. Deposits
 * only: claims and exits stay open, since a gate that traps funds is worse.
 */
export const C1_UNSAFE_LADDER_POOLS: readonly string[] = [
  // Empty: the six pre-fix pools were redeployed and repinned on 2026-09-05, and
  // addresses.json keeps the old six only as `ladder-*-retired` rows. Add a
  // lowercase address here and the panel closes its deposits with no other change.
  // What notices an unfixed ladder is scripts/verify-ladder-builds.mjs, which asks
  // the chain about every `poolKind: 'ladder'` pool the app ships.
];

/**
 * True when this pool is on the list above. Case-insensitive: the registry and
 * wagmi return checksummed addresses, and the list is stored lowercase.
 */
export function isC1UnsafeLadder(pool: string | null | undefined): boolean {
  if (!pool) return false;
  return C1_UNSAFE_LADDER_POOLS.includes(pool.toLowerCase());
}

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
 * A staker's share of the pool-wide rate, given the weight they would add: null
 * when a read is missing, 0 when the pool is not paying. Computed at today's
 * total weight, so every later staker dilutes it.
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

/** What an early exit costs on a FLAT-rate pool (the six live today), at the rate it answered. */
export function penaltyOn(amountRaw: bigint, penaltyBps: bigint): bigint {
  return (amountRaw * penaltyBps) / 10_000n;
}

/** "75%", "25%", "12.5%": the pool's penalty as the card says it. Never rounds. */
export function penaltyPct(penaltyBps: bigint): string {
  const whole = penaltyBps / 100n;
  const frac = penaltyBps % 100n;
  if (frac === 0n) return `${whole}%`;
  return `${whole}.${frac.toString().padStart(2, '0').replace(/0+$/, '')}%`;
}

/** A quoted penalty as a share of its position, floored to hundredths: "0.47%". */
export function penaltyShare(penaltyRaw: bigint, amountRaw: bigint): string {
  if (amountRaw <= 0n) return '0%';
  return penaltyPct((penaltyRaw * 10_000n) / amountRaw);
}

/** Seconds until a lock opens; 0 once it has. */
export function lockRemaining(lockEndSecs: bigint, nowSecs: bigint): bigint {
  return lockEndSecs > nowSecs ? lockEndSecs - nowSecs : 0n;
}
