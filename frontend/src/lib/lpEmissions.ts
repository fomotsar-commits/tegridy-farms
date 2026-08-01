/**
 * Is the TegridyLPFarming reward period actually running?
 *
 * Read `periodFinish`, never `rewardRate`: the Synthetix StakingRewards shape leaves a
 * NON-ZERO residual `rewardRate` in storage after a period ends (it is only overwritten
 * by the next `notifyRewardAmount`), while `earned()` stops accruing at `periodFinish`.
 * A rate-only check therefore reports emissions that nobody is being paid.
 *
 * Verified on mainnet 2026-07-31 against 0x1171268AE5B69791c47Fd589b7825932c957e149:
 * `periodFinish()` = 1781493095 (2026-06-15 UTC, in the past) while `rewardRate()` was
 * still 3_306_878_306_878_306 — exactly the trap above. /launch was advertising
 * "boosted LP farming today" off the back of it.
 */
export type LpEmissionsPhase = 'unknown' | 'running' | 'ended';

/**
 * @param periodFinishSec  `periodFinish()` in unix seconds; 0/NaN when the read failed.
 * @param nowMs            Wall clock in ms (injectable for tests).
 */
export function lpEmissionsPhase(periodFinishSec: number, nowMs: number = Date.now()): LpEmissionsPhase {
  // An unread period must not be reported as either running or ended.
  if (!Number.isFinite(periodFinishSec) || periodFinishSec <= 0) return 'unknown';
  return periodFinishSec * 1000 > nowMs ? 'running' : 'ended';
}

/**
 * The day-2 clause on /launch. "LP farming today" was true when written and false by
 * 2026-06-15; the phrasing now follows the contract instead of the calendar.
 */
export function dayTwoEconomyPhrase(phase: LpEmissionsPhase): string {
  switch (phase) {
    case 'running':
      return 'boosted LP farming, funded and running right now, with a gauge-emissions program as governance deploys';
    case 'ended':
      return 'a boosted LP-farming rail — deployed and wired, though its last emissions period has ended and a new one has to be funded — with a gauge-emissions program as governance deploys';
    default:
      return 'a boosted LP-farming rail (we could not read whether an emissions period is currently funded) and a gauge-emissions program as governance deploys';
  }
}

/** The same claim compressed for the page header's one-line summary. */
export function dayTwoEconomyShortPhrase(phase: LpEmissionsPhase): string {
  switch (phase) {
    case 'running':
      return 'LP farming running now; a gauge program as governance deploys';
    case 'ended':
      return 'an LP-farming rail awaiting its next funded period; a gauge program as governance deploys';
    default:
      return 'an LP-farming rail whose funding status we could not read; a gauge program as governance deploys';
  }
}
