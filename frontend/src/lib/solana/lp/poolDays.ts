// DOUBLE DAYS (island answer twenty-four, build 7): "Day {d} in the pool = {2d} warm days." The
// island counts the weight; the venue only says the position's age, in whole days, and only
// when the share account's own history, as the ledger read it (ledger.ts), proves it.
import type { LedgerEntry } from './ledger';

const DAY = 86_400;

/**
 * Whole days since these shares last went into the pool from an empty share account: the
 * newest proven deposit or opening that found the account at zero, by the chain's clock.
 * Every transaction after it must be a proven deposit, withdrawal or opening (one that failed
 * moved nothing and is passed over), and the balances must join up from it to the shares held
 * now. A transfer, a transaction this page could not read, or a start older than the page
 * leaves the age unknown: null, never a guess. `entries` newest first, as the ledger keeps them.
 */
export function poolDays(entries: readonly LedgerEntry[], lpAmount: bigint, chainNow: bigint | null): number | null {
  if (chainNow === null || lpAmount <= 0n) return null;
  let after = lpAmount;
  for (const e of entries) {
    if (e.kind === 'failed') continue;
    if (e.kind !== 'deposit' && e.kind !== 'withdrawal' && e.kind !== 'opening') return null;
    // The balance this entry found, worked back from the one after it, must be the one its record shows.
    const before = e.kind === 'withdrawal' ? after + e.lp : after - e.lp;
    if (before !== e.lpBefore) return null;
    if (before === 0n) {
      if (e.blockTime === null) return null;
      const days = Math.floor((Number(chainNow) - e.blockTime) / DAY);
      return days >= 0 ? days : null;
    }
    after = before;
  }
  return null;
}
