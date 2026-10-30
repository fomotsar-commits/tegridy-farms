import { parseAbi, parseEventLogs, type Log } from 'viem';
import { TEGRIDY_STAKING_ADDRESS } from './constants';

// The two events a TegridyStaking reward payout emits: getReward's RewardPaid and
// claimUnsettled's UnsettledClaimed (StakingRewardLib, emitted from the staking
// contract's own address because the library runs by delegatecall).
const PAYOUT_EVENTS = parseAbi([
  'event RewardPaid(address indexed user, uint256 indexed tokenId, uint256 reward)',
  'event UnsettledClaimed(address indexed user, uint256 amount)',
]);

/** Shown instead of a receipt when a confirmed claim paid nothing. */
export const NOTHING_PAID_COPY =
  'Nothing was paid: the staking reward reserve is empty. Your rewards stay owed until it is refilled.';

/**
 * What a confirmed TegridyStaking claim (getReward or claimUnsettled) actually PAID,
 * read off its own receipt.
 *
 * Both pay min(owed, reserve) and emit their event only when that is above zero. On
 * an empty reserve the transaction still succeeds, pays nothing and emits no payout
 * event at all, and what is owed stays owed. So a receipt that was read and holds no
 * payout event is a measured ZERO. Measured 2026-10-27 on a mainnet fork: the reserve
 * was empty and a claim on each of the 22 positions paid 0.
 *
 * @returns wei paid; `0n` when the receipt was read and holds no payout; `null` only
 *          when there is no receipt or its logs would not parse, which is unknown.
 */
export function stakingClaimPaid(receipt: { logs: readonly Log[] } | null | undefined): bigint | null {
  if (!receipt) return null;
  try {
    const staking = TEGRIDY_STAKING_ADDRESS.toLowerCase();
    const events = parseEventLogs({
      abi: PAYOUT_EVENTS,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === staking) as Log[],
    });
    return events.reduce((sum, e) => sum + (e.eventName === 'RewardPaid' ? e.args.reward : e.args.amount), 0n);
  } catch {
    return null;
  }
}

// The four ways a TegridyStaking position's stake comes back, each logging what it
// sent to the holder: withdraw, earlyWithdraw (net of the penalty), and the two
// exits, emergencyWithdrawPosition (paused only) and emergencyExitPosition.
const EXIT_EVENTS = parseAbi([
  'event Withdrawn(address indexed user, uint256 indexed tokenId, uint256 amount)',
  'event EarlyWithdrawn(address indexed user, uint256 indexed tokenId, uint256 amount, uint256 penalty)',
  'event EmergencyWithdraw(address indexed user, uint256 indexed tokenId, uint256 amount)',
  'event EmergencyExitPosition(address indexed user, uint256 indexed tokenId, uint256 amount)',
]);

/**
 * TOWELI a confirmed TegridyStaking withdrawal sent back, read off its own receipt.
 *
 * @returns wei returned; `null` when there is no receipt, its logs would not parse,
 *          or it holds no exit log (then it is not this withdrawal's receipt). A
 *          null is unknown, never zero: the caller falls back to its snapshot.
 */
export function stakingStakeReturned(receipt: { logs: readonly Log[] } | null | undefined): bigint | null {
  if (!receipt) return null;
  try {
    const staking = TEGRIDY_STAKING_ADDRESS.toLowerCase();
    const events = parseEventLogs({
      abi: EXIT_EVENTS,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === staking) as Log[],
    });
    if (events.length === 0) return null;
    return events.reduce((sum, e) => sum + e.args.amount, 0n);
  } catch {
    return null;
  }
}
