/**
 * A pool or farm whose reward period has ended takes no new deposits (owner,
 * 2026-10-14). Withdraw and claim stay open. These are the words every staking
 * card uses for it, built only from an end time a chain read returned.
 *
 * The date is the UTC day, so every visitor sees the chain's date, not their own.
 */

export function rewardsEndDate(endSecs: number | bigint): string {
  return new Date(Number(endSecs) * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function rewardsEndedLine(endSecs: number | bigint): string {
  return `Rewards ended ${rewardsEndDate(endSecs)}, so new stakes are closed. Withdraw and claim still work.`;
}

/**
 * A landed rate of 0 (never funded, or a period set to pay nothing): the pool pays
 * nothing now, so it takes no new stake either. It opens again once funding lands.
 */
export function rewardsZeroLine(neverStarted: boolean): string {
  return neverStarted
    ? 'No reward period has started, so new stakes are closed. Withdraw and claim still work.'
    : 'This pool pays 0 rewards now, so new stakes are closed. Withdraw and claim still work.';
}

/** The end time did not come back from the chain: no date is said, and staking waits. */
export const REWARDS_END_UNREAD_LINE = 'Whether rewards are still paid could not be read, so new stakes are held.';

/**
 * True only for a landed end time that has passed. `null` (unread) is not ended,
 * and 0 is a pool that was never funded, which is "not started", not "ended".
 */
export function rewardsHaveEnded(endSecs: number | bigint | null, nowSecs: number | bigint): boolean {
  if (endSecs === null) return false;
  const end = Number(endSecs);
  if (!Number.isFinite(end) || end <= 0) return false;
  return end <= Number(nowSecs);
}
