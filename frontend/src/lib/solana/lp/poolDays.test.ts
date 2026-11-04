// DOUBLE DAYS (island answer twenty-four, build 7): a position's age in whole days, from its
// share account's own history as the ledger reads it. The age runs from the newest proven
// deposit or opening that found the account empty, and only when every transaction since is
// proven and the balances join up to the shares held now. Anything else is unknown: null.

import { describe, it, expect } from 'vitest';
import type { LedgerEntry } from './ledger';
import { poolDays } from './poolDays';

const DAY = 86_400;
/** The chain's clock at the positions read: 2026-11-03 03:36:40 UTC. */
const NOW = 1_793_677_000n;
let n = 0;
const at = (daysAgo: number) => ({ signature: `${++n}`.padEnd(88, 'x'), slot: n, blockTime: Number(NOW) - Math.round(daysAgo * DAY), final: true });
const moved = (kind: 'deposit' | 'withdrawal' | 'opening', daysAgo: number, lp: bigint, lpBefore: bigint): LedgerEntry =>
  ({ kind, ...at(daysAgo), lp, token: 1n, coin: 1n, lpBefore });
const deposit = (daysAgo: number, lp: bigint, lpBefore: bigint) => moved('deposit', daysAgo, lp, lpBefore);
const withdrawal = (daysAgo: number, lp: bigint, lpBefore: bigint) => moved('withdrawal', daysAgo, lp, lpBefore);
const bare = (kind: 'other' | 'mixed' | 'failed', daysAgo: number): LedgerEntry => ({ kind, ...at(daysAgo) });

describe('the age, when the history proves it', () => {
  it('one deposit into an empty account, twelve and a half days ago: day 12', () => {
    expect(poolDays([deposit(12.5, 10n, 0n)], 10n, NOW)).toBe(12);
  });

  it('a deposit on top keeps the first one’s day', () => {
    expect(poolDays([deposit(3, 5n, 10n), deposit(30, 10n, 0n)], 15n, NOW)).toBe(30);
  });

  it('a part taken out keeps it too: the shares never left', () => {
    expect(poolDays([withdrawal(2, 4n, 10n), deposit(20, 10n, 0n)], 6n, NOW)).toBe(20);
  });

  it('all taken out and put back starts again, from the newest start', () => {
    expect(poolDays([deposit(5, 7n, 0n), withdrawal(20, 10n, 10n), deposit(30, 10n, 0n)], 7n, NOW)).toBe(5);
  });

  it('the opener’s own shares count from the opening', () => {
    expect(poolDays([moved('opening', 9, 900n, 0n)], 900n, NOW)).toBe(9);
  });

  it('a transaction that failed moved nothing, and is passed over', () => {
    expect(poolDays([bare('failed', 1), deposit(12, 10n, 0n)], 10n, NOW)).toBe(12);
  });

  it('the day of the deposit is day 0', () => {
    expect(poolDays([deposit(0.4, 10n, 0n)], 10n, NOW)).toBe(0);
  });
});

describe('unknown, never guessed', () => {
  it('a transaction since the start that is not a proven deposit or withdrawal: a transfer, a mixed one, an unread one', () => {
    expect(poolDays([bare('other', 1), deposit(12, 10n, 0n)], 10n, NOW)).toBeNull();
    expect(poolDays([bare('mixed', 1), deposit(12, 10n, 0n)], 10n, NOW)).toBeNull();
    expect(poolDays([{ kind: 'unread', signature: 'u'.padEnd(88, 'x'), blockTime: null, detail: 'the node has no record of it' }, deposit(12, 10n, 0n)], 10n, NOW)).toBeNull();
  });

  it('balances that do not join up to the shares held now', () => {
    expect(poolDays([deposit(12, 10n, 0n)], 11n, NOW)).toBeNull();
    expect(poolDays([deposit(3, 5n, 9n), deposit(30, 10n, 0n)], 15n, NOW)).toBeNull();
  });

  it('a start older than what was read', () => {
    expect(poolDays([deposit(3, 5n, 10n)], 15n, NOW)).toBeNull();
    expect(poolDays([], 15n, NOW)).toBeNull();
  });

  it('no chain clock, no time on the start, a start after the clock, or no shares', () => {
    expect(poolDays([deposit(12, 10n, 0n)], 10n, null)).toBeNull();
    expect(poolDays([{ ...deposit(12, 10n, 0n), blockTime: null }], 10n, NOW)).toBeNull();
    expect(poolDays([deposit(-2, 10n, 0n)], 10n, NOW)).toBeNull();
    expect(poolDays([deposit(12, 10n, 0n)], 0n, NOW)).toBeNull();
  });
});
