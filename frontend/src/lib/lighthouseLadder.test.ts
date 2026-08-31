// The ladder card's honesty math. Every rule below exists because rendering
// the naive number would lie — and three of them are lessons paid for once
// already on the plain-pool card shipped hours earlier.

import { describe, it, expect } from 'vitest';
import {
  deriveLadder,
  boostBpsFor,
  boostLabel,
  projectedRawPerSec,
  penaltyOn,
  lockRemaining,
  MAX_LOCK_SECS,
  MIN_LOCK_SECS,
  type LadderReads,
} from './lighthouseLadder';

const NOW = 1_756_600_000n;
const E18 = 10n ** 18n;

function reads(over: Partial<LadderReads> = {}): LadderReads {
  return {
    totalStakedRaw: 200n * E18,
    totalBoostedRaw: 500n * E18, // someone locked long
    surplusRaw: 60n * E18,
    rewardRateRaw: 1_000n,
    periodFinishSecs: NOW + 86_400n * 30n,
    rewardsDurationSecs: 86_400n * 60n,
    ...over,
  };
}

describe('the ladder', () => {
  it("is TOWELI's ladder exactly: 0.40x at seven days, 4.00x at four years", () => {
    expect(boostLabel(MIN_LOCK_SECS)).toBe('0.40x');
    expect(boostLabel(MAX_LOCK_SECS)).toBe('4.00x');
    expect(boostLabel(MAX_LOCK_SECS * 3n)).toBe('4.00x'); // clamped
    expect(boostLabel(0n)).toBe('0.40x'); // below the floor reads as the floor
  });

  it('matches the contract at the exact rungs the deploy script asserts', () => {
    expect(boostBpsFor(MIN_LOCK_SECS)).toBe(4_000n);
    expect(boostBpsFor(MAX_LOCK_SECS)).toBe(40_000n);
    // A ten-fold spread — the incentive that a no-lock rung would flatten.
    expect(boostBpsFor(MAX_LOCK_SECS) / boostBpsFor(MIN_LOCK_SECS)).toBe(10n);
  });
});

describe('deriveLadder', () => {
  it('reads the vault from the contract instead of re-deriving it', () => {
    // rewardSurplus() IS balanceOf - totalSupply on-chain; the UI must not
    // compute a second, drifting version of the number that decides payouts.
    expect(deriveLadder(reads(), NOW).vaultRaw).toBe(60n * E18);
  });

  it('separates NEVER FUNDED from "the period ended"', () => {
    // The plain-pool card collapsed these and then asserted a "last notify"
    // that had never happened. A fresh pool is fresh, not expired.
    const fresh = deriveLadder(reads({ periodFinishSecs: 0n, rewardRateRaw: 0n }), NOW);
    expect(fresh.everFunded).toBe(false);
    expect(fresh.periodActive).toBe(false);
    expect(fresh.payingNowRawPerSec).toBe(0n);

    const ended = deriveLadder(reads({ periodFinishSecs: NOW - 1n }), NOW);
    expect(ended.everFunded).toBe(true);
    expect(ended.periodActive).toBe(false);
    expect(ended.payingNowRawPerSec).toBe(0n); // a real, labeled zero
    expect(ended.configuredRawPerSec).toBe(1_000n); // still stated as configuration
  });

  it('an unreadable figure is an outage — every derived number goes null, never 0', () => {
    const v = deriveLadder(reads({ surplusRaw: null }), NOW);
    expect(v.coreKnown).toBe(false);
    expect(v.vaultRaw).toBeNull();
    const v2 = deriveLadder(reads({ periodFinishSecs: null }), NOW);
    expect(v2.payingNowRawPerSec).toBeNull();
    expect(v2.runwaySecs).toBeNull();
  });

  it('runway is exact seconds to periodFinish, and 0 once past', () => {
    expect(deriveLadder(reads(), NOW).runwaySecs).toBe(86_400n * 30n);
    expect(deriveLadder(reads({ periodFinishSecs: NOW - 5n }), NOW).runwaySecs).toBe(0n);
  });
});

describe('what a staker would actually earn', () => {
  it('dilutes the projection by the weight the staker themself adds', () => {
    // The honest trap: quoting `rate * myShare / existingTotal` overstates,
    // because staking CHANGES the denominator. The projection must include
    // the new weight in the total it divides by.
    const v = deriveLadder(reads({ totalBoostedRaw: 0n }), NOW);
    const solo = projectedRawPerSec(v, 0n, 100n * E18);
    expect(solo).toBe(1_000n); // sole staker takes the whole rate

    const half = projectedRawPerSec(v, 100n * E18, 100n * E18);
    expect(half).toBe(500n); // equal weight, half the rate — not the whole of it
  });

  it('projects nothing when the pool is not paying, and null when unreadable', () => {
    const ended = deriveLadder(reads({ periodFinishSecs: NOW - 1n }), NOW);
    expect(projectedRawPerSec(ended, 100n * E18, 100n * E18)).toBe(0n);
    const outage = deriveLadder(reads({ periodFinishSecs: null }), NOW);
    expect(projectedRawPerSec(outage, 100n * E18, 100n * E18)).toBeNull();
  });

  it('a longer lock earns strictly more of the same pool — but boost is RELATIVE, not a multiplier on your own yield', () => {
    const v = deriveLadder(reads({ totalBoostedRaw: 0n }), NOW);
    const amount = 100n * E18;
    const existing = 300n * E18;
    const shortest = projectedRawPerSec(v, existing, (amount * boostBpsFor(MIN_LOCK_SECS)) / 10_000n)!;
    const locked = projectedRawPerSec(v, existing, (amount * boostBpsFor(MAX_LOCK_SECS)) / 10_000n)!;
    expect(locked > shortest).toBe(true);
    // And NOT 4x: 4.00x weight against a pool that already holds 300e18 of
    // weight yields far less than ten times the income, because the staker's
    // own weight enters the denominator too. A UI that promised "10x rewards"
    // would be lying; what the ladder buys is ten times the SHARE.
    expect(locked < shortest * 10n).toBe(true);
  });

  it('a SOLO staker earns the whole rate whatever they locked — boost only sorts stakers against each other', () => {
    const v = deriveLadder(reads({ totalBoostedRaw: 0n }), NOW);
    const amount = 100n * E18;
    const soloShortest = projectedRawPerSec(v, 0n, (amount * boostBpsFor(MIN_LOCK_SECS)) / 10_000n);
    const soloMaxLock = projectedRawPerSec(v, 0n, (amount * boostBpsFor(MAX_LOCK_SECS)) / 10_000n);
    expect(soloShortest).toBe(1_000n);
    expect(soloMaxLock).toBe(1_000n);
    // The honest consequence for today: every island pool is empty, so the
    // FIRST staker gains nothing from locking. The card must not imply
    // otherwise while it is the only position in the pool.
  });
});

describe('the exit costs', () => {
  it('prices the early exit at exactly 25%, the contract constant', () => {
    expect(penaltyOn(1_000n * E18)).toBe(250n * E18);
  });

  it('counts down a lock and stops at zero rather than going negative', () => {
    expect(lockRemaining(NOW + 100n, NOW)).toBe(100n);
    expect(lockRemaining(NOW - 100n, NOW)).toBe(0n);
  });
});
