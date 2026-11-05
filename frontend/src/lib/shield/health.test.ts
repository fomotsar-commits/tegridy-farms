// What the health model is allowed to say, for loans on Gondi's v3.2 loan contract.
//
// Two failures are pinned. The first is specific to this venue and easy to ship
// by accident: these loans have NO price-based liquidation, so any health factor
// rendered next to one is a number the contract does not compute and cannot be
// liquidated against. A borrower who has used Aave reads "1.4" as
// distance-to-liquidation and will act on it.
//
// The second is Gondi's own rule: there is NO grace period. `repayLoan` reverts
// with LoanExpiredError once `startTime + duration <= block.timestamp`
// (MultiSourceLoan._baseLoanChecks), and `liquidateLoan` opens at the same
// second. A model that still offered a "grace period" would tell a borrower they
// had time they do not have, and the repayment it built would revert.

import { describe, it, expect } from 'vitest';
import {
  BAND_LABEL,
  BAND_SEVERITY,
  NO_HEALTH_FACTOR_DETAIL,
  URGENT_SECONDS,
  WATCH_SECONDS,
  assessDeadlineHealth,
  healthSeverity,
  type ShieldHealth,
} from './health';

const NOW = 1_700_000_000;

function at(secondsFromNow: number): ShieldHealth {
  return assessDeadlineHealth({ deadlineUnix: NOW + secondsFromNow, nowUnix: NOW });
}

describe('Gondi has no grace period: the window shuts AT the deadline', () => {
  it('at the deadline second the band is defaulted and repayment is refused', () => {
    // LoanExpiredError fires on `startTime + duration <= block.timestamp`: equality included.
    const h = at(0);
    expect(h.band).toBe('defaulted');
    expect(h.repayable).toBe(false);
  });

  it('one second before the deadline the loan is urgent and still repayable', () => {
    const h = at(1);
    expect(h.band).toBe('urgent');
    expect(h.repayable).toBe(true);
  });

  it('is defaulted and not repayable at any time past the deadline', () => {
    for (const offset of [-1, -600, -100_000]) {
      const h = at(offset);
      expect(h.band).toBe('defaulted');
      expect(h.repayable).toBe(false);
    }
  });

  it('has no grace band at all', () => {
    expect(Object.keys(BAND_LABEL)).not.toContain('grace');
    expect(Object.keys(BAND_SEVERITY)).not.toContain('grace');
    for (const offset of [-100_000, -600, -1, 0, 1, 60, URGENT_SECONDS, WATCH_SECONDS, 400 * 3600]) {
      expect(at(offset).band).not.toBe('grace');
    }
  });

  it('says there is no grace period, in the detail and in the urgent consequence', () => {
    expect(NO_HEALTH_FACTOR_DETAIL).toMatch(/no grace period/i);
    expect(at(3600).consequence).toMatch(/no grace period/i);
  });

  it('never promises a grace period in any copy it generates', () => {
    for (const offset of [-100_000, -600, -1, 0, 1, 60, URGENT_SECONDS, WATCH_SECONDS, 400 * 3600]) {
      const h = at(offset);
      expect(h.headline).not.toMatch(/grace/i);
      expect(h.consequence).not.toMatch(/(?:in|enters|its) (?:the |its )?grace period/i);
    }
  });
});

describe('no health factor is ever produced for these loans', () => {
  const offsets = [-100_000, -1, 0, 60, URGENT_SECONDS, WATCH_SECONDS, 400 * 3600];

  it.each(offsets)('at %ss from the deadline the health factor is null', (offset) => {
    const h = at(offset);
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
      const h = at(offset);
      // A "1.42"-shaped decimal is the specific artefact a borrower reads as a
      // health factor. Durations here are integers with unit suffixes.
      expect(h.headline).not.toMatch(/\b\d+\.\d+\b/);
      expect(h.consequence).not.toMatch(/\b\d+\.\d+\b/);
    }
  });
});

describe('the bands follow the one fact that decides the loan', () => {
  it('is safe well clear of the deadline', () => {
    expect(at(WATCH_SECONDS + 1).band).toBe('safe');
  });

  it('is watch at exactly the watch boundary', () => {
    expect(at(WATCH_SECONDS).band).toBe('watch');
  });

  it('is urgent at exactly the urgent boundary', () => {
    expect(at(URGENT_SECONDS).band).toBe('urgent');
  });

  it('carries the deadline it was given and the seconds left to it', () => {
    const h = at(7200);
    expect(h.deadlineUnix).toBe(NOW + 7200);
    expect(h.secondsToDeadline).toBe(7200);
    expect(h.headline).toMatch(/2h 0m left/);
  });

  it('sorts worse bands higher', () => {
    expect(healthSeverity(at(-1))).toBeGreaterThan(healthSeverity(at(3600)));
    expect(healthSeverity(at(3600))).toBeGreaterThan(healthSeverity(at(WATCH_SECONDS)));
    expect(healthSeverity(at(WATCH_SECONDS))).toBeGreaterThan(healthSeverity(at(WATCH_SECONDS + 1)));
  });
});

describe('the consequence states the real loss, not a liquidation penalty', () => {
  it('says the whole collateral NFT is lost, not a percentage of it', () => {
    for (const offset of [WATCH_SECONDS + 1, WATCH_SECONDS, URGENT_SECONDS, -1]) {
      expect(at(offset).consequence).toMatch(/collateral NFT/i);
    }
  });

  it('never describes the loss as a percentage penalty — nothing partial happens here', () => {
    for (const offset of [-100_000, -1, 60, URGENT_SECONDS, WATCH_SECONDS, 400 * 3600]) {
      const c = at(offset).consequence;
      expect(c).not.toMatch(/\d+\s*%/);
      expect(c).not.toMatch(/liquidation (?:penalty|bonus|fee)/i);
    }
  });

  it('tells a borrower past the deadline that repayment is no longer accepted', () => {
    const h = at(-600);
    expect(h.headline).toBe(BAND_LABEL.defaulted);
    expect(h.consequence).toMatch(/no longer accepts repayment/i);
    expect(h.consequence).toMatch(/claim the collateral NFT/i);
  });

  it('tells an urgent borrower that a repayment landing late is refused', () => {
    expect(at(3600).consequence).toMatch(/lands after the deadline is refused/i);
  });
});
