// THE FEE INVARIANT, AT ONE REMOVE.
//
// lib/fees/swapFee.ts owns the dial and its rule: the number a caller SENDS and
// the number a surface DISPLAYS both come from `providerFeeAttachment`, and
// nothing else may compute a fee figure. A new surface is exactly where that rule
// gets broken — by reading `swapFeePolicy().bps` for a label, which advertises a
// charge against a request no provider ever received.
//
// So the assertions here are mostly negative: with the dial turned ON in the test
// environment, this module must still produce no figure, because no route is
// submitted from the yield surface and no provider was chosen. A fee that appears
// the moment an operator sets an env var, on a surface that cannot charge it, is
// a fabricated charge.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { yieldRouteFee, yieldRouteFeeValue, YIELD_THIRD_PARTY_NOTE } from './fee';
import { swapFeePolicy } from '../fees/swapFee';

const RECIPIENT = '0x1111111111111111111111111111111111111111';

function enableDial() {
  vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
  vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the dial is off by default and this module inherits that', () => {
  it('starts from a disabled policy in a clean environment', () => {
    vi.unstubAllEnvs();
    expect(swapFeePolicy().enabled, 'the venue fee must ship off').toBe(false);
    expect(yieldRouteFee(null).charged).toBe(false);
  });
});

describe('no provider, no figure — even with the dial on', () => {
  it('charges nothing when no route is submitted', () => {
    enableDial();
    // The precondition, pinned as a concrete fact so this test cannot pass
    // vacuously on a build where the dial silently failed to turn on.
    expect(swapFeePolicy().enabled).toBe(true);
    expect(swapFeePolicy().bps).toBe(25);

    const fee = yieldRouteFee(null);
    expect(fee.charged).toBe(false);
    expect(yieldRouteFeeValue(fee)).toBe('None');
  });

  it('prints no digits at all in the value column when nothing is charged', () => {
    enableDial();
    // The specific leak this guards: `${swapFeePolicy().bps / 100}%` in a label.
    // It would render "0.25%" here, over a route that cannot be signed.
    expect(/\d/.test(yieldRouteFeeValue(yieldRouteFee(null)))).toBe(false);
  });

  it('says why, and distinguishes "we do not charge here" from "we could not"', () => {
    enableDial();
    const noRoute = yieldRouteFee(null);
    expect(noRoute.charged === false && noRoute.reason).toMatch(/does not execute/i);

    // A named provider whose leg is withheld is a different fact and gets
    // different words — an operator has to be able to tell them apart.
    const blocked = yieldRouteFee('odos');
    expect(blocked.charged).toBe(false);
    expect(blocked.charged === false && blocked.reason).toMatch(/no confirmed fee mechanism/i);
  });
});

describe('when a fee does arrive, it arrives from the attachment', () => {
  it('takes bps and recipient from providerFeeAttachment for a ready leg', () => {
    enableDial();
    const fee = yieldRouteFee('paraswap');
    expect(fee.charged).toBe(true);
    expect(fee.charged === true && fee.bps).toBe(25);
    expect(fee.charged === true && fee.recipient.toLowerCase()).toBe(RECIPIENT);
    expect(yieldRouteFeeValue(fee)).toBe('0.25%');
  });

  it('goes back to nothing when the dial is off, for the same ready leg', () => {
    vi.unstubAllEnvs();
    expect(yieldRouteFee('paraswap').charged).toBe(false);
  });

  it('respects the ceiling the policy applies rather than re-deriving it', () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '2500');
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
    const fee = yieldRouteFee('paraswap');
    expect(fee.charged === true && fee.bps).toBe(swapFeePolicy().bps);
  });
});

describe('a zero fee does not read as a free position', () => {
  it('keeps the third-party costs disclosed alongside the zero', () => {
    expect(YIELD_THIRD_PARTY_NOTE).toMatch(/destination protocol takes its own cut/i);
    expect(YIELD_THIRD_PARTY_NOTE).toMatch(/gas/i);
  });
});
