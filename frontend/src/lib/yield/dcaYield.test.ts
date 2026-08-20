// WHOSE MONEY, AND WHO PRESSES THE BUTTON.
//
// Two claims a "DCA into yield" feature makes by implication and must not:
//   · that the schedule is holding the unspent budget (it is not — a Tegridy
//     schedule is a reminder, and the funds never leave the user's wallet), and
//   · that "auto-stake" happens by itself (it cannot — the venue runs no keeper,
//     and no server here holds or can derive a key, so every leg is signed).
//
// Both are pinned as strings below, because both are carried by copy rather than
// by code and copy is what a refactor drops. The third pin is the arithmetic one:
// an unreadable amount must REFUSE, never fall back to zero, because "0 ETH idle"
// is a sentence that tells a user their budget is fully deployed.

import { describe, it, expect } from 'vitest';
import { parseEther } from 'viem';
import {
  DCA_YIELD_EXECUTION_NOTE,
  DCA_YIELD_ROUND_TRIP_NOTE,
  TWAP_IDLE_NOTE,
  dcaIdleTotal,
  dcaYieldPlan,
} from './dcaYield';

function plan(amountPerSwap: string, totalSwaps: number, completedSwaps = 0) {
  const result = dcaYieldPlan({ amountPerSwap, totalSwaps, completedSwaps });
  if (!result.ok) throw new Error(`expected a plan, got refusal: ${result.reason}`);
  return result.plan;
}

describe('the unspent figure is exact, and is the user’s own balance', () => {
  it('multiplies in wei rather than through a float', () => {
    // 0.1 * 3 in float is 0.30000000000000004. On an 18-decimal amount that is a
    // wrong number in a column of money.
    expect(plan('0.1', 3).idleWei).toBe(parseEther('0.3'));
    expect(plan('0.1', 3).idleEth).toBe('0.3');
  });

  it('counts only the swaps still to come', () => {
    expect(plan('0.05', 30, 10).remainingSwaps).toBe(20);
    expect(plan('0.05', 30, 10).idleWei).toBe(parseEther('1'));
  });

  it('clamps an overrun schedule at zero rather than reporting a debt', () => {
    const p = plan('0.05', 5, 9);
    expect(p.remainingSwaps).toBe(0);
    expect(p.idleWei).toBe(0n);
  });

  it('keeps eighteen decimals rather than rounding to a display width', () => {
    expect(plan('0.000000000000000001', 2).idleWei).toBe(2n);
  });
});

describe('an unreadable amount refuses; it does not resolve to zero', () => {
  it('refuses the malformed inputs safeParseEther already guards on the input path', () => {
    for (const bad of ['', '1.', 'abc', '1e3', '-1', '0.1234567890123456789']) {
      const result = dcaYieldPlan({ amountPerSwap: bad, totalSwaps: 10, completedSwaps: 0 });
      expect(result.ok, `"${bad}" produced a plan`).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/could not be read/i);
    }
  });

  it('refuses non-integer and negative swap counts', () => {
    expect(dcaYieldPlan({ amountPerSwap: '0.1', totalSwaps: 3.5, completedSwaps: 0 }).ok).toBe(false);
    expect(dcaYieldPlan({ amountPerSwap: '0.1', totalSwaps: -1, completedSwaps: 0 }).ok).toBe(false);
    expect(dcaYieldPlan({ amountPerSwap: '0.1', totalSwaps: 3, completedSwaps: -1 }).ok).toBe(false);
  });

  it('never returns a zero-idle plan for input it could not parse', () => {
    // The failure this guards: a refusal quietly downgraded to `idleWei: 0n`
    // renders as "nothing unspent", which is the opposite of what happened.
    const result = dcaYieldPlan({ amountPerSwap: 'abc', totalSwaps: 10, completedSwaps: 0 });
    expect(result).not.toHaveProperty('plan');
  });
});

describe('neither leg claims to run on its own', () => {
  it('attaches the execution note to every plan, not to some', () => {
    expect(plan('0.1', 10).execution).toBe(DCA_YIELD_EXECUTION_NOTE);
    expect(plan('0.1', 10, 10).execution).toBe(DCA_YIELD_EXECUTION_NOTE);
  });

  it('names BOTH reasons nothing fires unattended — the keeper and the key', () => {
    // Fixing either one alone changes nothing, so a note that mentions only one
    // of them would read as a limitation about to be lifted.
    expect(DCA_YIELD_EXECUTION_NOTE).toMatch(/no keeper/i);
    expect(DCA_YIELD_EXECUTION_NOTE).toMatch(/no server here holds or can derive your key/i);
    expect(DCA_YIELD_EXECUTION_NOTE).toMatch(/you sign/i);
  });

  it('discloses the round-trip cost without inventing a gas figure for it', () => {
    expect(DCA_YIELD_ROUND_TRIP_NOTE).toMatch(/two signed transactions per swap/i);
    expect(DCA_YIELD_ROUND_TRIP_NOTE).toMatch(/does not estimate it/i);
  });
});

describe('both legs report unavailable while no destination is wired', () => {
  it('cannot park an unfilled budget, and says the money stays put', () => {
    const p = plan('0.1', 10);
    expect(p.parking.state).toBe('unavailable');
    expect(p.parking.state === 'unavailable' && p.parking.reason).toMatch(/stays in your wallet, earning nothing/i);
  });

  it('cannot stake a completed buy, and says what happens instead', () => {
    const p = plan('0.1', 10);
    expect(p.autoStake.state).toBe('unavailable');
    expect(p.autoStake.state === 'unavailable' && p.autoStake.reason).toMatch(/stays in your wallet/i);
  });

  it('gives a finished schedule its own reason rather than the wiring one', () => {
    const p = plan('0.1', 5, 5);
    expect(p.parking.state === 'unavailable' && p.parking.reason).toMatch(/no swaps left/i);
  });
});

describe('the total across schedules is never quietly short', () => {
  it('sums in wei and counts what it covered', () => {
    const total = dcaIdleTotal([
      { amountPerSwap: '0.1', totalSwaps: 10, completedSwaps: 0 },
      { amountPerSwap: '0.2', totalSwaps: 5, completedSwaps: 1 },
    ]);
    expect(total.idleWei).toBe(parseEther('1') + parseEther('0.8'));
    expect(total.counted).toBe(2);
    expect(total.unreadable).toBe(0);
  });

  it('excludes an unreadable schedule from the sum AND reports that it did', () => {
    // An understated total is the dangerous direction: it reads as reassuring.
    const total = dcaIdleTotal([
      { amountPerSwap: '0.1', totalSwaps: 10, completedSwaps: 0 },
      { amountPerSwap: 'nonsense', totalSwaps: 10, completedSwaps: 0 },
    ]);
    expect(total.idleWei).toBe(parseEther('1'));
    expect(total.counted).toBe(1);
    expect(total.unreadable).toBe(1);
  });

  it('reports an empty list as zero covering zero schedules, which is honest', () => {
    expect(dcaIdleTotal([])).toEqual({ idleWei: 0n, idleEth: '0', counted: 0, unreadable: 0 });
  });
});

describe('the TWAP refusal has a mechanism behind it, not a shrug', () => {
  it('explains that parking a TWAP balance fails parts rather than delaying them', () => {
    expect(TWAP_IDLE_NOTE).toMatch(/allowance/i);
    expect(TWAP_IDLE_NOTE).toMatch(/fail/i);
    expect(TWAP_IDLE_NOTE).not.toMatch(/coming soon|not yet supported/i);
  });
});
