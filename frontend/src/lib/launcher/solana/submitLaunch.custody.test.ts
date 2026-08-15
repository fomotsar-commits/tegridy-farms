// THE FEE-CUSTODY CHECK'S POSITION ON THIS RAIL — Wave 3, phase 03.
//
// `submitLaunch.test.ts` mocks `assertFeeCustody` off, because it reads the chain and
// fails closed, so with no network nothing past it would run. That mock is safe ONLY
// while something else proves the check is still called, and still called high. This
// file is that something.
//
// ⚠ WHY THIS IS A SEPARATE FILE, AND NOT A BLOCK IN submitLaunch.gate.test.ts.
//
// It was written there first, and it was VACUOUS. That file deliberately leaves the
// Heat gate real, so with `fetch` stubbed to throw, the GATE refused before the custody
// check was ever reached — and the test passed just as happily with
// `assertFeeCustody` deleted from submitLaunch entirely. Proven by mutation.
//
// Two fail-closed guards in sequence cannot be pinned by one test with the network off:
// whichever runs first absorbs the assertion. So here the gate is mocked OPEN, leaving
// custody as the only thing that can refuse, and the mutation is meaningful again.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Transaction, type Connection } from '@solana/web3.js';

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  DynamicBondingCurveClient: { create: vi.fn(async () => ({})) },
}));
vi.mock('./dbcClient', () => ({ launchToken: vi.fn(async () => new Transaction()) }));
// Gate OPEN on purpose — see the note above.
vi.mock('../../heat/launchGate', () => ({
  assertMayLaunch: vi.fn(async () => ({ id: 'gd_test_row' })),
  HeatGateDenied: class HeatGateDenied extends Error {},
}));

import { submitLaunch, wasBroadcast } from './submitLaunch';

const WALLET = 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK';
const EVM = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const CFG = '4HVMW8TRZmXAxERH94hkVgM279fSXSBBsjonBYmxxxMn';
const META = { name: 'T', symbol: 'T', uri: 'https://example.com/t.json' };
const connection = { getSignatureStatuses: vi.fn(async () => ({ value: [null] })) };

describe('fee custody is verified before anything is signed or sent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
  });

  it('refuses, and never broadcasts, when custody cannot be verified', async () => {
    const send = vi.fn();
    const err = await submitLaunch({
      connection: connection as unknown as Connection,
      sendTransaction: send,
      walletAddress: WALLET,
      heatIdentity: EVM,
      config: CFG,
      mintKeypair: Keypair.generate(),
      ...META,
    }).catch((e) => e);

    // The load-bearing assertions are the last three, not the type: a refusal that had
    // already broadcast would be a lie told to a user about a token that exists.
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/custody/i);
    expect(send, 'custody refusal must happen above sendTransaction').not.toHaveBeenCalled();
    expect(wasBroadcast(err), 'a denial must never read as a failed broadcast').toBe(false);
    expect((err as { signature?: string }).signature).toBeUndefined();
  });
});
