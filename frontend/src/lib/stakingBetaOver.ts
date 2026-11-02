import { EARLY_WITHDRAWAL_PENALTY_BPS } from './constants';

/**
 * TOWELI staking v1 (TegridyStaking) is closing, owner's plan of 2026-10-30: the
 * reward rate goes to 0, the reserve is refilled with what is owed, about 14 days
 * to claim, then a pause, under which emergencyWithdrawPosition returns a whole
 * stake with no penalty. The site takes no new stakes into it meanwhile.
 */
export const STAKING_V1_TAKES_NEW_STAKES = false as boolean;

export type StakingBetaPhase =
  | 'checking'
  | 'unread'
  | 'closing'
  | 'reserve-empty'
  | 'reserve-short'
  | 'claim-now'
  | 'paused';

export interface StakingBetaReads {
  /** A read below has not answered yet (first load). */
  loading: boolean;
  /** paused(). null = not read. */
  paused: boolean | null;
  /** rewardRate() in wei per second. null = not read. */
  rewardRate: bigint | null;
  /** balance - staked - IOUs, clamped at 0 (usePoolData). null = a leg not read. */
  rewardsRemaining: bigint | null;
  /** This wallet's unclaimed position rewards. undefined = no position to weigh, null = not read. */
  owed?: bigint | null;
}

/**
 * Where TOWELI staking v1 stands, from on-chain reads only. A read that did not land
 * is never taken as fine: 'checking' while the first load runs, then 'unread'.
 * "Covers what's owed" is #1029's reserve (balance - staked - IOUs, so IOUs are
 * already netted out) against this wallet's unclaimed rewards. With no position to
 * weigh, a non-empty reserve is all that can be checked.
 */
export function stakingBetaPhase(r: StakingBetaReads): StakingBetaPhase {
  const notRead = r.loading ? 'checking' : 'unread';
  // A read pause decides it alone: whatever the rate or reserve, the exit is the move.
  if (r.paused === true) return 'paused';
  if (r.paused === null || r.rewardRate === null) return notRead;
  if (r.rewardRate > 0n) return 'closing';
  if (r.rewardsRemaining === null) return notRead;
  if (r.rewardsRemaining === 0n) return 'reserve-empty';
  if (r.owed === null) return notRead;
  if (r.owed !== undefined && r.owed > r.rewardsRemaining) return 'reserve-short';
  return 'claim-now';
}

/** The hook fields stakingBetaPhase reads (usePoolData, useUserPosition), all optional. */
export interface BetaPoolFields {
  isLoading?: boolean;
  paused?: boolean | null;
  rewardRateRaw?: bigint;
  rewardRateUnread?: boolean;
  rewardsRemainingRaw?: bigint;
  rewardsRemainingUnread?: boolean;
}
export interface BetaWalletFields {
  isLoading?: boolean;
  isPaused?: boolean | null;
  positionUnread?: boolean;
  hasPosition?: boolean;
  pendingReward?: bigint;
}

/**
 * Maps usePoolData (and, for a connected wallet, useUserPosition) onto the reads.
 * A value counts only beside its own landed-read flag: a missing flag is unread.
 */
export function betaReadsFromHooks(pool: BetaPoolFields, wallet?: BetaWalletFields): StakingBetaReads {
  const bool = (v: boolean | null | undefined): boolean | null => (typeof v === 'boolean' ? v : null);
  return {
    loading: !!pool.isLoading || !!wallet?.isLoading,
    // The wallet's own pause read refreshes every 30 s and drives the card's
    // controls, so it wins; the pool read covers a visitor with no wallet.
    paused: bool(wallet?.isPaused) ?? bool(pool.paused),
    rewardRate: pool.rewardRateUnread === false && typeof pool.rewardRateRaw === 'bigint' ? pool.rewardRateRaw : null,
    rewardsRemaining:
      pool.rewardsRemainingUnread === false && typeof pool.rewardsRemainingRaw === 'bigint'
        ? pool.rewardsRemainingRaw
        : null,
    owed: !wallet
      ? undefined
      : wallet.positionUnread
        ? null
        : wallet.hasPosition
          ? (typeof wallet.pendingReward === 'bigint' ? wallet.pendingReward : null)
          : undefined,
  };
}

const PENALTY_PCT = EARLY_WITHDRAWAL_PENALTY_BPS / 100;

export const BETA_OVER_HEADING = 'Beta is over';

/** The one visible line under the heading, true in its phase and no other. */
export const BETA_OVER_LINE: Record<StakingBetaPhase, string> = {
  checking: 'TOWELI staking v1 is closing. Checking where it stands now.',
  unread:
    'TOWELI staking v1 is closing. We could not read where it stands, so check again before you claim or withdraw.',
  closing:
    `TOWELI staking v1 is closing. Everything you've earned will be paid, then the pool pauses so you can take your stake out with no ${PENALTY_PCT}% penalty.`,
  'reserve-empty': 'Rewards have stopped. The reward reserve is empty, so a claim pays 0 until it is refilled.',
  'reserve-short':
    "Rewards have stopped. The reward reserve can't cover all you've earned yet, so a claim now pays only part of it.",
  'claim-now':
    "Rewards have stopped. Claim what you've earned now: the pool pauses soon, and claims can't be made while it's paused.",
  paused: 'Paused for the move to the new staking contract. Take your stake out with no penalty.',
};

/** Why the site offers no stake, top-up or lock extension into v1. */
export const NEW_STAKES_CLOSED_LINE = 'TOWELI staking v1 is closing, so it takes no new stakes.';
