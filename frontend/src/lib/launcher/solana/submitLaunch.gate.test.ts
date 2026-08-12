// @vitest-environment node
//
// WHERE the Heat gate sits on the Solana rail, and why that is the only place it may sit.
//
// `submitLaunch.test.ts` mocks the gate open so it can test the post-broadcast contract.
// This file does the opposite: it lets the REAL gate run and asserts that a denial
// happens above every side effect. Without this pair, mocking the gate in the other file
// would be indistinguishable from deleting it.
//
// The invariant under test: `HeatGateDenied` is a plain Error subclass, so `wasBroadcast`
// reads false and the UI tells the user — truthfully — that nothing was submitted. Below
// `sendTransaction`, that same sentence would be a lie about a token that exists.

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Keypair, Transaction, type Connection } from '@solana/web3.js';

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  buildCurveWithMarketCap: vi.fn(() => ({ __configParams: 'CURVE' })),
  DynamicBondingCurveClient: { create: vi.fn(async () => ({ __client: true })) },
}));
vi.mock('./dbc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dbc')>();
  return { ...actual, isSolanaLauncherEnabled: vi.fn(() => true) };
});
vi.mock('./dbcClient', () => ({ launchToken: vi.fn() }));

import { launchToken } from './dbcClient';
import { submitLaunch, wasBroadcast } from './submitLaunch';
import { HeatGateDenied } from '../../heat/launchGate';
import { clearGateAudit } from '../../heat/gateAudit';

const CONFIG = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const WALLET = 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK';
const EVM = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';
const META = { name: 'Test Coin', symbol: 'TEST', uri: 'ipfs://meta' };

const connection = { getSignatureStatuses: vi.fn() } as unknown as Connection;

beforeEach(() => {
  vi.clearAllMocks();
  clearGateAudit();
  (launchToken as Mock).mockResolvedValue(new Transaction());
  // No oracle in a node test environment: `fetch` to a relative URL fails, the gate
  // fails closed, and that IS the scenario — an unreachable instrument denies.
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('ECONNREFUSED');
  }));
});

describe('the gate sits above every side effect', () => {
  it('an unreachable oracle DENIES, and nothing is built, signed or sent', async () => {
    const send = vi.fn();
    await expect(
      submitLaunch({
        connection, sendTransaction: send, walletAddress: WALLET, heatIdentity: EVM,
        config: CONFIG, mintKeypair: Keypair.generate(), ...META,
      }),
    ).rejects.toThrow();

    // The three things that must not have happened.
    expect(send).not.toHaveBeenCalled();
    expect(launchToken).not.toHaveBeenCalled();
    expect((connection as unknown as { getSignatureStatuses: Mock }).getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('the denial reads as NEVER BROADCAST — this is the load-bearing property', async () => {
    const err = await submitLaunch({
      connection, sendTransaction: vi.fn(), walletAddress: WALLET, heatIdentity: EVM,
      config: CONFIG, mintKeypair: Keypair.generate(), ...META,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(wasBroadcast(err)).toBe(false);
    // No signature, ever. A signature is how the UI decides a retry is dangerous.
    expect((err as { signature?: unknown }).signature).toBeUndefined();
  });

  it('a denial still produces an audit row — refusals are recorded, not just passes', async () => {
    // NOTE: asserted on the row the denial CARRIES, not on localStorage. This file runs
    // in the node environment, where there is no storage — which is also the real
    // private-mode browser case, and the case in which a launch must still work. The
    // persistence ring itself is covered in lib/heat/gateAudit.test.ts under jsdom.
    const err = (await submitLaunch({
      connection, sendTransaction: vi.fn(), walletAddress: WALLET, heatIdentity: EVM,
      config: CONFIG, mintKeypair: Keypair.generate(), ...META,
    }).catch((e) => e)) as HeatGateDenied;

    expect(err).toBeInstanceOf(HeatGateDenied);
    expect(err.audit.verdict).toBe('STALE');
    expect(err.audit.address).toBe(EVM);
    expect(err.audit.degrees).toBeNull(); // could not ask — NOT a score of zero
  });

  it('a MISSING qualifying identity says so, instead of blaming the island', async () => {
    const send = vi.fn();
    const err = await submitLaunch({
      connection, sendTransaction: send, walletAddress: WALLET, heatIdentity: '',
      config: CONFIG, mintKeypair: Keypair.generate(), ...META,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Connect the Ethereum wallet/);
    // Specifically NOT a gate denial: the island was never asked about an empty string,
    // so this must not be dressed up as a verdict about anybody.
    expect(err).not.toBeInstanceOf(HeatGateDenied);
    expect(send).not.toHaveBeenCalled();
  });
});
