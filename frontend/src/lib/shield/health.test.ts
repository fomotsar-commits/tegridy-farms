// What the health model is allowed to say.
//
// Two failures are being pinned. The first is the familiar one: a failed read
// must not become a band, because a band is a claim about the loan and a failed
// read is a claim about us — and "safe" is the band an empty/undefined input
// would drift into.
//
// The second is specific to this venue and easier to ship by accident: these
// loans have NO price-based liquidation, so any health factor rendered next to
// one is a number the contract does not compute and cannot be liquidated
// against. A borrower who has used Aave reads "1.4" as distance-to-liquidation
// and will act on it. The assertions below make producing one a test failure
// rather than a design discussion.
//
// The third is the regression at the bottom of this file. The repayment window
// closes at `effectiveDeadline + _graceWithPauseExtension`, which the contract
// computes and no clock here can: `GRACE_PERIOD` is only its floor. A model that
// closes the window on the constant tells a borrower whose NFT is still
// recoverable that it is already gone — during the exact hour in which acting
// still works — and then refuses to build the transaction that would have
// worked. So `repayable` may only ever come from `isDefaulted`.

import { describe, it, expect } from 'vitest';
import {
  BAND_SEVERITY,
  NO_HEALTH_FACTOR_DETAIL,
  URGENT_SECONDS,
  WATCH_SECONDS,
  assessDeadlineHealth,
  healthSeverity,
  type ShieldHealth,
} from './health';

const NOW = 1_700_000_000;
const GRACE = 3600;

/**
 * `defaultedOnChain` is explicit at every call site on purpose: it is the one
 * fact this model is not allowed to infer, so a test that wants a defaulted loan
 * has to say the contract said so.
 */
function at(secondsFromNow: number, defaultedOnChain = false): ShieldHealth {
  return assessDeadlineHealth({
    effectiveDeadlineUnix: NOW + secondsFromNow,
    minGraceSeconds: GRACE,
    defaultedOnChain,
    nowUnix: NOW,
  });
}

function read(h: ShieldHealth) {
  if (h.status !== 'read') throw new Error(`expected a read health, got: ${h.detail}`);
  return h;
}

describe('a failed read is never a band', () => {
  it('refuses when the deadline could not be read', () => {
    const h = assessDeadlineHealth({
      effectiveDeadlineUnix: null,
      minGraceSeconds: GRACE,
      defaultedOnChain: false,
      nowUnix: NOW,
    });
    expect(h.status).toBe('unreadable');
    expect(h.status === 'unreadable' && h.detail).toMatch(/failed read, not a loan that is fine/i);
  });

  it('refuses when the grace period could not be read', () => {
    const h = assessDeadlineHealth({
      effectiveDeadlineUnix: NOW + 500,
      minGraceSeconds: null,
      defaultedOnChain: false,
      nowUnix: NOW,
    });
    expect(h.status).toBe('unreadable');
  });

  it('refuses when the contract’s default verdict could not be read, rather than assuming the loan is open', () => {
    const h = assessDeadlineHealth({
      effectiveDeadlineUnix: NOW + 500,
      minGraceSeconds: GRACE,
      defaultedOnChain: null,
      nowUnix: NOW,
    });
    expect(h.status).toBe('unreadable');
  });

  it('refuses a non-finite deadline rather than treating NaN arithmetic as a band', () => {
    const h = assessDeadlineHealth({
      effectiveDeadlineUnix: Number.NaN,
      minGraceSeconds: GRACE,
      defaultedOnChain: false,
      nowUnix: NOW,
    });
    expect(h.status).toBe('unreadable');
  });

  it('carries the caller’s reason so a user can tell which read went missing', () => {
    const h = assessDeadlineHealth({
      effectiveDeadlineUnix: null,
      minGraceSeconds: null,
      defaultedOnChain: null,
      nowUnix: NOW,
      unreadableDetail: 'Loan #7’s deadline could not be read.',
    });
    expect(h.status === 'unreadable' && h.detail).toBe('Loan #7’s deadline could not be read.');
  });

  it('sorts an unreadable position above every readable one, including a defaulted one', () => {
    const unreadable = assessDeadlineHealth({
      effectiveDeadlineUnix: null,
      minGraceSeconds: null,
      defaultedOnChain: null,
      nowUnix: NOW,
    });
    expect(healthSeverity(unreadable)).toBeGreaterThan(healthSeverity(at(-100_000, true)));
    expect(healthSeverity(unreadable)).toBeGreaterThan(BAND_SEVERITY.defaulted);
  });
});

describe('no health factor is ever produced for these loans', () => {
  const offsets = [-100_000, -GRACE - 1, -1, 0, 60, URGENT_SECONDS, WATCH_SECONDS, 400 * 3600];

  it.each(offsets)('at %ss from the deadline the health factor is null', (offset) => {
    const h = read(at(offset));
    expect(h.healthFactor).toBeNull();
    expect(h.healthFactorDetail).toBe(NO_HEALTH_FACTOR_DETAIL);
  });

  it('says why, rather than leaving a blank where a familiar number goes', () => {
    expect(NO_HEALTH_FACTOR_DETAIL).toMatch(/no health factor/i);
    expect(NO_HEALTH_FACTOR_DETAIL).toMatch(/no price oracle/i);
    expect(NO_HEALTH_FACTOR_DETAIL).toMatch(/time is the only variable/i);
  });

  it('never renders a ratio-shaped number in the headline or consequence', () => {
    for (const offset of offsets) {
      const h = read(at(offset));
      // A "1.42"-shaped decimal is the specific artefact a borrower reads as a
      // health factor. Durations here are integers with unit suffixes.
      expect(h.headline).not.toMatch(/\b\d+\.\d+\b/);
      expect(h.consequence).not.toMatch(/\b\d+\.\d+\b/);
    }
  });
});

describe('the bands follow the one fact that decides the loan', () => {
  it('is safe well clear of the deadline', () => {
    expect(read(at(WATCH_SECONDS + 1)).band).toBe('safe');
  });

  it('is watch at exactly the watch boundary', () => {
    expect(read(at(WATCH_SECONDS)).band).toBe('watch');
  });

  it('is urgent at exactly the urgent boundary', () => {
    expect(read(at(URGENT_SECONDS)).band).toBe('urgent');
  });

  it('is grace once the deadline passes but repayment still settles', () => {
    const h = read(at(-1));
    expect(h.band).toBe('grace');
    expect(h.repayable).toBe(true);
  });

  it('is defaulted when the contract says so, and is no longer repayable', () => {
    const h = read(at(-GRACE, true));
    expect(h.band).toBe('defaulted');
    expect(h.repayable).toBe(false);
  });

  it('is still in grace one second before the minimum window closes', () => {
    expect(read(at(-GRACE + 1)).band).toBe('grace');
  });
});

// THE REGRESSION.
//
// `_graceWithPauseExtension` = GRACE_PERIOD + any pause overlapping the grace
// window. After a mid-grace pause the constant runs out while `repayLoan` still
// succeeds. The lending contract's own audit trail records this being fixed in
// `isDefaulted` (NFTLEND-PAUSE-INFLIGHT) after the UI reported loans as defaulted
// for up to an hour while `claimDefault` reverted `LoanNotDefaulted`. Deriving
// closure from the constant here reintroduces it one layer up, with the harm
// pointing the same way: a borrower told the NFT is gone stops trying, in the
// window where trying still works.
describe('the window closes when the contract says it closed, not when the constant runs out', () => {
  it('is still repayable past the minimum grace while the contract reports no default', () => {
    const h = read(at(-GRACE - 4000, false));
    expect(h.repayable).toBe(true);
    expect(h.band).toBe('grace');
    expect(h.band).not.toBe('defaulted');
  });

  it('says the time left is unknown there rather than inventing one', () => {
    const h = read(at(-GRACE - 4000, false));
    expect(h.minSecondsToGraceEnd).toBeLessThan(0);
    expect(h.headline).toMatch(/still repayable/i);
    expect(h.consequence).toMatch(/accepted right now/i);
    expect(h.consequence).toMatch(/how much longer is unknown/i);
  });

  it('defaults on the contract’s verdict even before the minimum grace has elapsed', () => {
    // The reverse direction. `isDefaulted` cannot in fact fire this early, but
    // the model must follow the read rather than second-guess it with a clock.
    expect(read(at(-1, true)).band).toBe('defaulted');
    expect(read(at(-1, true)).repayable).toBe(false);
  });

  it('never reports a grace end as exact', () => {
    for (const offset of [-GRACE - 4000, -600, -1, 60, WATCH_SECONDS]) {
      expect(read(at(offset)).graceEndIsLowerBound).toBe(true);
    }
  });

  it('marks the bound as a floor in the copy — "at least", never "until"', () => {
    expect(read(at(-600)).headline).toMatch(/at least/i);
    expect(read(at(-600)).consequence).toMatch(/at least another/i);
  });
});

describe('the consequence states the real loss, not a liquidation penalty', () => {
  it('says the whole collateral NFT is lost, not a percentage of it', () => {
    for (const offset of [WATCH_SECONDS + 1, WATCH_SECONDS, URGENT_SECONDS, -1]) {
      expect(read(at(offset)).consequence).toMatch(/collateral NFT/i);
    }
  });

  it('never describes the loss as a percentage penalty — nothing partial happens here', () => {
    for (const offset of [-100_000, -1, 60, URGENT_SECONDS, WATCH_SECONDS, 400 * 3600]) {
      const c = read(at(offset)).consequence;
      expect(c).not.toMatch(/\d+\s*%/);
      expect(c).not.toMatch(/liquidation (?:penalty|bonus|fee)/i);
    }
  });

  it('tells a defaulted borrower that repaying afterwards does not buy the collateral back', () => {
    const h = read(at(-100_000, true));
    expect(h.consequence).toMatch(/not returned by repaying afterwards/i);
    expect(h.consequence).toMatch(/the lending contract reports this loan as defaulted/i);
  });

  it('gives a grace-period borrower the time they actually have left, not the elapsed deadline', () => {
    const h = read(at(-600));
    expect(h.secondsToDeadline).toBe(-600);
    expect(h.minSecondsToGraceEnd).toBe(GRACE - 600);
    expect(h.graceEndsAtLeastUnix).toBe(NOW - 600 + GRACE);
    expect(h.headline).toMatch(/left to repay/i);
  });
});
