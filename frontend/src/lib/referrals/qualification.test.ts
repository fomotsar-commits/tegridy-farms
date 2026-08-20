// The referral splitter pays nobody by default, and that is the fact this
// module exists to keep in front of a prospective referrer.
//
// A referrer below the stake threshold does not earn a reduced share — their
// referees' carve routes to the treasury in full, and the referee pays exactly
// the same fee either way. So the failure mode here is not a wrong number on a
// dashboard: it is somebody sharing a link for a week, sending real volume
// through the venue, and discovering an empty claim page afterwards. These
// tests pin the disclosures that prevent that.

import { describe, it, expect } from 'vitest';
import {
  evaluateEarn,
  evaluateClaim,
  shouldWarnBeforeSharing,
  carveDestination,
  MIN_REFERRAL_AGE_SECONDS,
  type StandingInputs,
  type EarnVerdict,
} from './qualification';

/** Every read succeeded and the wallet clears the bar. Mutate one field per test. */
const QUALIFIED: StandingInputs = {
  setupComplete: true,
  banned: false,
  // Power is the SUM of two independent reads. Kept split here rather than
  // pre-summed because the null cases differ: a zero-address restaking pointer
  // contributes a determinate 0n, while a set pointer whose read failed bounds
  // the true power only from below — so the two must stay distinguishable.
  stakingPower: 4_000n,
  restakingPower: 1_000n,
  threshold: 1_000n,
  pending: 0n,
  registeredAt: 1_000n,
  nowSeconds: 1_000n + MIN_REFERRAL_AGE_SECONDS,
};

describe('evaluateEarn follows the contract order, not a convenient one', () => {
  it('qualifies a wallet at or above the threshold', () => {
    expect(evaluateEarn(QUALIFIED).kind).toBe('qualified');
    expect(evaluateEarn({ ...QUALIFIED, stakingPower: 1_000n, restakingPower: 0n }).kind).toBe('qualified');
  });

  it('reports below-threshold with the shortfall, not a bare refusal', () => {
    const v = evaluateEarn({ ...QUALIFIED, stakingPower: 300n, restakingPower: 100n });
    expect(v.kind).toBe('below-threshold');
    // The shortfall is the actionable number: it is what the wallet must add.
    if (v.kind === 'below-threshold') expect(v.shortfall).toBe(600n);
  });

  it('gates on setupComplete BEFORE anything about the wallet', () => {
    // The splitter records no fees at all while this is false, so reporting a
    // wallet-shaped verdict here would blame the user for a deployment state.
    const v = evaluateEarn({ ...QUALIFIED, setupComplete: false, stakingPower: 0n, restakingPower: 0n, banned: true });
    expect(v.kind).toBe('engine-inert');
  });

  it('treats a ban as disqualifying regardless of how much power the wallet has', () => {
    const v = evaluateEarn({ ...QUALIFIED, banned: true, stakingPower: 10_000_000n });
    expect(v.kind).toBe('banned');
  });

  it.each([
    ['setupComplete', { setupComplete: null }],
    ['banned', { banned: null }],
    ['stakingPower', { stakingPower: null }],
    ['restakingPower', { restakingPower: null }],
    ['threshold', { threshold: null }],
  ] as const)('returns unknown — never a verdict — when %s could not be read', (_name, patch) => {
    const v = evaluateEarn({ ...QUALIFIED, ...patch });
    expect(v.kind).toBe('unknown');
    // An unread threshold must never resolve to "you qualify" or "you don't".
    expect(['qualified', 'below-threshold']).not.toContain(v.kind);
  });
});

describe('the warning before sharing', () => {
  it('warns on every verdict that is not an affirmative qualification', () => {
    const verdicts: EarnVerdict[] = [
      { kind: 'unknown', reason: 'x' },
      { kind: 'engine-inert', reason: 'x' },
      { kind: 'banned', reason: 'x' },
      { kind: 'below-threshold', power: 1n, threshold: 2n, shortfall: 1n },
    ];
    for (const v of verdicts) expect(shouldWarnBeforeSharing(v)).toBe(true);
  });

  it('stays silent only for a qualification that was actually read', () => {
    expect(shouldWarnBeforeSharing({ kind: 'qualified', power: 2n, threshold: 1n })).toBe(false);
  });

  it('warns on unknown as loudly as on disqualification', () => {
    // Sharing on the strength of a read that did not happen is the same
    // mistake as sharing while disqualified, and the warning costs nothing.
    expect(shouldWarnBeforeSharing({ kind: 'unknown', reason: 'rpc down' })).toBe(
      shouldWarnBeforeSharing({ kind: 'below-threshold', power: 0n, threshold: 1n, shortfall: 1n }),
    );
  });
});

describe('where the carve actually lands', () => {
  it('names the treasury when the referrer cannot earn', () => {
    expect(carveDestination({ kind: 'below-threshold', power: 0n, threshold: 1n, shortfall: 1n })).toBe('treasury');
    expect(carveDestination({ kind: 'banned', reason: 'x' })).toBe('treasury');
  });

  it('says unknown rather than guessing a destination on a failed read', () => {
    expect(carveDestination({ kind: 'unknown', reason: 'x' })).toBe('unknown');
    expect(carveDestination({ kind: 'engine-inert', reason: 'x' })).toBe('unknown');
  });

  it('routes to the referrer only on an affirmative qualification', () => {
    expect(carveDestination({ kind: 'qualified', power: 2n, threshold: 1n })).toBe('referrer');
  });

  it('never reports a destination of referrer for any non-qualified verdict', () => {
    // The inverse of the warning rule, asserted separately so a change to one
    // cannot quietly diverge from the other.
    const nonQualified: EarnVerdict[] = [
      { kind: 'unknown', reason: 'x' },
      { kind: 'engine-inert', reason: 'x' },
      { kind: 'banned', reason: 'x' },
      { kind: 'below-threshold', power: 1n, threshold: 2n, shortfall: 1n },
    ];
    for (const v of nonQualified) expect(carveDestination(v)).not.toBe('referrer');
  });
});

describe('claiming is a separate question from earning', () => {
  it('distinguishes a genuine zero from every failure above it', () => {
    const v = evaluateClaim({ ...QUALIFIED, pending: 0n });
    expect(v.kind).toBe('nothing-pending');
  });

  it('reports never-registered rather than nothing-pending when no referee ever linked', () => {
    // Both render as "no money", but only one of them is fixed by recruiting.
    const v = evaluateClaim({ ...QUALIFIED, registeredAt: 0n });
    expect(v.kind).toBe('never-registered');
  });

  it('holds a claim inside the minimum age and says when it unlocks', () => {
    const v = evaluateClaim({ ...QUALIFIED, pending: 5n, nowSeconds: 1_000n });
    expect(v.kind).toBe('too-recent');
    if (v.kind === 'too-recent') expect(v.unlocksAt).toBe(1_000n + MIN_REFERRAL_AGE_SECONDS);
  });

  it('reports claimable with the amount once the clock has run', () => {
    const v = evaluateClaim({ ...QUALIFIED, pending: 42n });
    expect(v.kind).toBe('claimable');
    if (v.kind === 'claimable') expect(v.pendingWei).toBe(42n);
  });

  it('never reports nothing-pending when the pending read failed', () => {
    // A failed balance read rendering as a confident zero is the exact bug this
    // repo keeps finding; here it would tell a referrer they earned nothing.
    const v = evaluateClaim({ ...QUALIFIED, pending: null });
    expect(v.kind).toBe('unknown');
  });
});
