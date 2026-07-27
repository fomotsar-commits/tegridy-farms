import { describe, it, expect } from 'vitest';
import {
  EXOTIC_LAUNCHES_ENABLED,
  ETH_NUMERAIRE,
  TOWELI_NUMERAIRE,
  allowedNumeraires,
  isAllowedNumeraire,
  isExoticLaunchEnabled,
} from './config';
import { TOWELI_ADDRESS } from '../constants';
import type { Address } from 'viem';

// The exotic-numeraire GATE is a live-money-path safety invariant: a TOWELI launch must
// be impossible while EXOTIC_LAUNCHES_ENABLED is off (it flips true only after the
// mainnet-fork rehearsal). These pin that, so a stray flag flip can't ship silently.
describe('exotic numeraire gate', () => {
  it('TOWELI_NUMERAIRE is the real TOWELI token', () => {
    expect(TOWELI_NUMERAIRE.toLowerCase()).toBe(TOWELI_ADDRESS.toLowerCase());
  });

  it('exotic launches are ENABLED (flipped 2026-07-27, operator-authorized)', () => {
    // TRIPWIRE, not an invariant: this pins the CURRENT source state. The flip is a
    // deliberate, informed decision (create fork-proven; graduation architecturally sound
    // but not execution-proven — same unexercised-graduation status the live ETH launcher
    // carries). If exotic is ever re-gated (set false + redeploy), flip this back too.
    expect(EXOTIC_LAUNCHES_ENABLED).toBe(true);
    expect(isExoticLaunchEnabled()).toBe(true); // launcher enabled AND exotic on
  });

  it('isAllowedNumeraire tracks the flag: ETH always; TOWELI iff exotic is on', () => {
    // INVARIANT (flag-agnostic): whatever EXOTIC_LAUNCHES_ENABLED is, the allowed set
    // must be exactly ETH (+ TOWELI when on). Robust to a future flip.
    expect(isAllowedNumeraire(ETH_NUMERAIRE)).toBe(true);
    expect(isAllowedNumeraire(TOWELI_NUMERAIRE)).toBe(EXOTIC_LAUNCHES_ENABLED);
    expect(allowedNumeraires().map((a) => a.toLowerCase())).toEqual(
      EXOTIC_LAUNCHES_ENABLED
        ? [ETH_NUMERAIRE.toLowerCase(), TOWELI_NUMERAIRE.toLowerCase()]
        : [ETH_NUMERAIRE.toLowerCase()],
    );
  });

  it('rejects an arbitrary ERC20 as a numeraire (EVM exotic = ETH + TOWELI only)', () => {
    const random = '0x00000000000000000000000000000000DeaDBeef' as Address;
    expect(isAllowedNumeraire(random)).toBe(false);
  });
});
