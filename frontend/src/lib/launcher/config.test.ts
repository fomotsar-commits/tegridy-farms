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

  it('ships GATED OFF today (deliberate tripwire)', () => {
    // TRIPWIRE, not an invariant: this pins the CURRENT source state. When the mainnet-
    // fork rehearsal passes and you consciously flip EXOTIC_LAUNCHES_ENABLED true, update
    // THIS test — its failure is the forcing function that a flip was intentional.
    expect(EXOTIC_LAUNCHES_ENABLED).toBe(false);
    expect(isExoticLaunchEnabled()).toBe(false);
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
