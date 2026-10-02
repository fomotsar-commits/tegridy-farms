// WAVE SEVEN, element P (ruling 11): the day counter's one home.
//
// Two implementations disagreed before this file existed, and the disagreement
// was not cosmetic: element N answered null when the island's reading ran
// backwards, elements B and D clamped the same case to 0. The merge picked
// null, and the test that says so is the reason this file is worth reading.

import { describe, it, expect } from 'vitest';
import { daysHeld } from './daysHeld';

const DAY = 86_400;

describe('daysHeld', () => {
  it('counts whole days between the island stamps', () => {
    expect(daysHeld(1_000_000, 1_000_000 + 5 * DAY)).toBe(5);
    expect(daysHeld(1_000_000, 1_000_000)).toBe(0);
  });

  it('floors a part day rather than rounding it up', () => {
    // 5 days and 23 hours is 5 days held, not 6. A rounded-up day is a day the
    // wallet has not held, printed as one it has.
    expect(daysHeld(1_000_000, 1_000_000 + 5 * DAY + 23 * 3_600)).toBe(5);
  });

  it('answers null when either stamp is missing', () => {
    expect(daysHeld(null, 1_000_000)).toBeNull();
    expect(daysHeld(1_000_000, null)).toBeNull();
    expect(daysHeld(null, null)).toBeNull();
  });

  it('answers NULL on an inverted reckoning, and never a zero', () => {
    // THE MERGE DECISION. `as_of` before `held_since` is the island's own
    // instrument contradicting itself. A zero there would read as "bought
    // today", which is a claim about a wallet made from a reading that does
    // not support it - element N's own test called it that first, and this is
    // now the venue's single answer, element B included.
    expect(daysHeld(2_000_000, 1_000_000)).toBeNull();
    expect(daysHeld(1_000_000 + 1, 1_000_000)).toBeNull();
  });

  it('answers null for stamps that are not finite numbers', () => {
    expect(daysHeld(Number.NaN, 1_000_000)).toBeNull();
    expect(daysHeld(1_000_000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
