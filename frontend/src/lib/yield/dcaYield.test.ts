// WHOSE MONEY, AND WHO PRESSES THE BUTTON.
//
// Two claims a "DCA into yield" feature makes by implication and must not:
//   · that the schedule is holding the unspent budget (it is not — a
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

const ETH = { symbol: 'ETH', decimals: 18 } as const;

function plan(amountPerSwap: string, totalSwaps: number, completedSwaps = 0) {
  const result = dcaYieldPlan({ amountPerSwap, totalSwaps, completedSwaps, asset: ETH });
  if (!result.ok) throw new Error(`expected a plan, got refusal: ${result.reason}`);
  return result.plan;
}

describe('the unspent figure is exact, and is the user’s own balance', () => {
  it('multiplies in wei rather than through a float', () => {
    // 0.1 * 3 in float is 0.30000000000000004. On an 18-decimal amount that is a
    // wrong number in a column of money.
    expect(plan('0.1', 3).idleWei).toBe(parseEther('0.3'));
    expect(plan('0.1', 3).idleAmount).toBe('0.3');
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
      const result = dcaYieldPlan({ amountPerSwap: bad, totalSwaps: 10, completedSwaps: 0, asset: ETH });
      expect(result.ok, `"${bad}" produced a plan`).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/could not be read/i);
    }
  });

  it('refuses non-integer and negative swap counts', () => {
    expect(dcaYieldPlan({ amountPerSwap: '0.1', totalSwaps: 3.5, completedSwaps: 0, asset: ETH }).ok).toBe(false);
    expect(dcaYieldPlan({ amountPerSwap: '0.1', totalSwaps: -1, completedSwaps: 0, asset: ETH }).ok).toBe(false);
    expect(dcaYieldPlan({ amountPerSwap: '0.1', totalSwaps: 3, completedSwaps: -1, asset: ETH }).ok).toBe(false);
  });

  it('never returns a zero-idle plan for input it could not parse', () => {
    // The failure this guards: a refusal quietly downgraded to `idleWei: 0n`
    // renders as "nothing unspent", which is the opposite of what happened.
    const result = dcaYieldPlan({ amountPerSwap: 'abc', totalSwaps: 10, completedSwaps: 0, asset: ETH });
    expect(result).not.toHaveProperty('plan');
  });
});

describe('a figure is never printed at a scale nobody chose', () => {
  // useDCA restores a schedule through a validator that accepts any ticker from
  // 0 to 18 decimals, and reads its own amounts back with the row's own
  // decimals. This module's arithmetic is safeParseEther/formatEther, which are
  // eighteen-decimal. Six-decimal input through eighteen-decimal arithmetic is
  // wrong by a factor of a million and renders as a perfectly plausible balance.
  it('refuses an asset that is not eighteen decimals rather than mis-scaling it', () => {
    const result = dcaYieldPlan({
      amountPerSwap: '100',
      totalSwaps: 10,
      completedSwaps: 0,
      asset: { symbol: 'USDC', decimals: 6 },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('USDC');
    expect(result.ok === false && result.reason).toMatch(/18 decimals/);
  });

  it('carries the ticker on the plan so the figure cannot be rendered as ETH', () => {
    const p = dcaYieldPlan({
      amountPerSwap: '5',
      totalSwaps: 4,
      completedSwaps: 1,
      asset: { symbol: 'DAI', decimals: 18 },
    });
    expect(p.ok).toBe(true);
    // DAI is eighteen decimals, so the arithmetic is right and the only thing
    // that could be wrong is the label. It travels with the number.
    expect(p.ok === true && p.plan.asset.symbol).toBe('DAI');
    expect(p.ok === true && p.plan.idleAmount).toBe('15');
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

describe('each leg is keyed to the BUDGET\u2019s own token, not to the first wired venue', () => {
  it('refuses to park an ETH budget in a USDC lending market, and names the token', () => {
    // The regression this exists for: before the legs were keyed to the asset,
    // wiring Aave made an ETH schedule print "would route to Aave v3 — USDC
    // market". That is a token the holder does not have and a deposit that
    // would revert.
    const p = plan('0.1', 10);
    expect(p.parking.state).toBe('unavailable');
    expect(p.parking.state === 'unavailable' && p.parking.reason).toMatch(/USDC/);
    expect(p.parking.state === 'unavailable' && p.parking.reason).toMatch(/stays in your wallet earning nothing/i);
  });

  it('offers an ETH-denominated staking venue for an ETH budget', () => {
    const p = plan('0.1', 10);
    expect(p.autoStake.state).toBe('available');
    if (p.autoStake.state !== 'available') throw new Error('unreachable');
    // The venue it names must actually take ETH through a payable function.
    expect(p.autoStake.venue.route.kind).toBe('native-payable');
    expect(p.autoStake.venue.route.kind === 'native-payable' && p.autoStake.venue.route.asset).toBe('ETH');
  });

  it('parks a USDS budget in the USDS vault and nowhere else', () => {
    const result = dcaYieldPlan({
      amountPerSwap: '10',
      totalSwaps: 4,
      completedSwaps: 0,
      asset: { symbol: 'USDS', decimals: 18 },
    });
    if (!result.ok) throw new Error(`expected a plan, got: ${result.reason}`);
    expect(result.plan.parking.state).toBe('available');
    if (result.plan.parking.state !== 'available') throw new Error('unreachable');
    expect(result.plan.parking.venue.id).toBe('sky-susds');
    // ...and it must NOT then offer to stake a stablecoin budget into an LST.
    expect(result.plan.autoStake.state).toBe('unavailable');
    expect(result.plan.autoStake.state === 'unavailable' && result.plan.autoStake.reason).toMatch(/USDS/);
  });

  it('gives a finished schedule its own reason rather than the wiring one', () => {
    const p = plan('0.1', 5, 5);
    expect(p.parking.state === 'unavailable' && p.parking.reason).toMatch(/no swaps left/i);
  });
});

describe('the total across schedules is never quietly short', () => {
  it('sums in wei and counts what it covered', () => {
    const total = dcaIdleTotal(
      [
        { amountPerSwap: '0.1', totalSwaps: 10, completedSwaps: 0, asset: ETH },
        { amountPerSwap: '0.2', totalSwaps: 5, completedSwaps: 1, asset: ETH },
      ],
      'ETH',
    );
    expect(total.idleWei).toBe(parseEther('1') + parseEther('0.8'));
    expect(total.counted).toBe(2);
    expect(total.unreadable).toBe(0);
    expect(total.otherDenomination).toBe(0);
  });

  it('excludes an unreadable schedule from the sum AND reports that it did', () => {
    // An understated total is the dangerous direction: it reads as reassuring.
    const total = dcaIdleTotal(
      [
        { amountPerSwap: '0.1', totalSwaps: 10, completedSwaps: 0, asset: ETH },
        { amountPerSwap: 'nonsense', totalSwaps: 10, completedSwaps: 0, asset: ETH },
      ],
      'ETH',
    );
    expect(total.idleWei).toBe(parseEther('1'));
    expect(total.counted).toBe(1);
    expect(total.unreadable).toBe(1);
  });

  it('reports an empty list as zero covering zero schedules, which is honest', () => {
    expect(dcaIdleTotal([], 'ETH')).toEqual({
      idleWei: 0n,
      idleAmount: '0',
      denomination: 'ETH',
      counted: 0,
      unreadable: 0,
      otherDenomination: 0,
    });
  });
});

describe('the total is a quantity of ONE asset, not a mixed number', () => {
  it('leaves a differently-denominated schedule out and counts it apart', () => {
    // "100" of a stablecoin added to an ETH total is not a small error, it is a
    // number that is not a quantity of anything — and it renders as a balance.
    const total = dcaIdleTotal(
      [
        { amountPerSwap: '0.1', totalSwaps: 10, completedSwaps: 0, asset: ETH },
        { amountPerSwap: '100', totalSwaps: 10, completedSwaps: 0, asset: { symbol: 'USDC', decimals: 6 } },
      ],
      'ETH',
    );
    expect(total.idleWei).toBe(parseEther('1'));
    expect(total.counted).toBe(1);
    expect(total.otherDenomination).toBe(1);
    // Reported apart from `unreadable`: that row was read perfectly well, it is
    // simply not this asset, and telling a user it was unreadable is a wrong
    // reason attached to a right exclusion.
    expect(total.unreadable).toBe(0);
  });

  it('converts nothing, because it holds no price and would have to invent one', () => {
    const total = dcaIdleTotal(
      [{ amountPerSwap: '100', totalSwaps: 10, completedSwaps: 0, asset: { symbol: 'USDC', decimals: 6 } }],
      'ETH',
    );
    expect(total.idleWei).toBe(0n);
    expect(total.counted).toBe(0);
  });

  it('names the asset it counted, so the caller does not label the figure itself', () => {
    expect(dcaIdleTotal([], 'TOWELI').denomination).toBe('TOWELI');
  });
});

describe('the TWAP refusal has a mechanism behind it, not a shrug', () => {
  it('explains that parking a TWAP balance fails parts rather than delaying them', () => {
    expect(TWAP_IDLE_NOTE).toMatch(/allowance/i);
    expect(TWAP_IDLE_NOTE).toMatch(/fail/i);
    expect(TWAP_IDLE_NOTE).not.toMatch(/coming soon|not yet supported/i);
  });
});
