// @vitest-environment node
// Node env for the same reason dbcClient.test.ts uses it: this file imports the
// dbcClient module, whose sibling squads.ts uses web3.js's SYNC sha256 path at call
// time. Nothing here calls it, but the node env keeps the import honest either way.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Keypair, Transaction, type Connection } from '@solana/web3.js';

vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  buildCurveWithMarketCap: vi.fn(() => ({ __configParams: 'CURVE' })),
  DynamicBondingCurveClient: { create: vi.fn(async () => ({ __client: true })) },
}));

// The gate defaults false; the builders are pure and safe, so only flip the flag.
vi.mock('./dbc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dbc')>();
  return { ...actual, isSolanaLauncherEnabled: vi.fn(() => true) };
});

vi.mock('./dbcClient', () => ({ launchToken: vi.fn() }));

// THE HEAT GATE IS MOCKED OPEN IN THIS FILE, and that is deliberate.
//
// This suite exists to pin the POST-BROADCAST contract: which errors carry a signature,
// which count as broadcast, and why a retry must not mint a second token. The real gate
// fetches the island's oracle, which in a test environment is unreachable — so it fails
// closed and NOTHING PAST IT RUNS, and every assertion below would pass vacuously while
// testing nothing at all.
//
// The gate's own behaviour (fail-closed, three states, the audit row) is covered in
// lib/heat/launchGate.test.ts, and its POSITION on this rail — that a denial happens
// above `sendTransaction` and can never read as broadcast — is pinned in
// submitLaunch.gate.test.ts, which does NOT mock it. Both halves are needed: mocking it
// here without pinning it there is how a gate silently stops being called.
vi.mock('../../heat/launchGate', () => ({
  assertMayLaunch: vi.fn(async () => ({ id: 'gd_test_row' })),
  HeatGateDenied: class HeatGateDenied extends Error {},
}));

import { launchToken } from './dbcClient';
import { submitLaunch, confirmSignature, ConfirmationTimeout, LaunchFailedOnChain, wasBroadcast } from './submitLaunch';

const CONFIG = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const WALLET = 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK';
/** The qualifying identity for the gate — an ETHEREUM address, not the Solana payer. */
const EVM = '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a';

function connectionWith(statuses: unknown[]): Connection {
  let i = 0;
  return {
    getSignatureStatuses: vi.fn(async () => ({ value: [statuses[Math.min(i++, statuses.length - 1)]] })),
  } as unknown as Connection;
}

const META = { name: 'Test Coin', symbol: 'TEST', uri: 'ipfs://meta' };

beforeEach(() => {
  vi.clearAllMocks();
  (launchToken as Mock).mockResolvedValue(new Transaction());
});

describe('submitLaunch', () => {
  it('launches against the SUPPLIED config and returns the mint that co-signed', async () => {
    const mintKeypair = Keypair.generate();
    const send = vi.fn(async () => 'SIGNATURE_1');
    const connection = connectionWith([{ err: null, confirmationStatus: 'confirmed' }]);

    const res = await submitLaunch({
      connection, sendTransaction: send, walletAddress: WALLET, heatIdentity: EVM,
      config: CONFIG, mintKeypair, ...META,
    });

    expect(res).toEqual({
      signature: 'SIGNATURE_1',
      mint: mintKeypair.publicKey.toBase58(),
      // The gate row that permitted it — this is `gate_decision_id` on the birth notify.
      gateDecisionId: 'gd_test_row',
    });
    // The descriptor handed to launchToken must name the config we were given and
    // the wallet as BOTH payer and pool creator — never a protocol-held address.
    const params = (launchToken as Mock).mock.calls[0][1];
    expect(params.config).toBe(CONFIG);
    expect(params.baseMint).toBe(mintKeypair.publicKey.toBase58());
    expect(params.poolCreator).toBe(WALLET);
    expect(params.payer).toBe(WALLET);
  });

  it('passes NO wallet signer to launchToken — the adapter adds that signature', async () => {
    // Passing a signer here would sign twice and buy nothing; more importantly it
    // would mean this module, not the wallet adapter, decided how the user signs.
    const send = vi.fn(async () => 'SIG');
    await submitLaunch({
      connection: connectionWith([{ err: null, confirmationStatus: 'confirmed' }]),
      sendTransaction: send, walletAddress: WALLET, heatIdentity: EVM, config: CONFIG,
      mintKeypair: Keypair.generate(), ...META,
    });
    expect((launchToken as Mock).mock.calls[0][2]).toBeUndefined();
    // ...and the mint keypair IS handed over, since it must co-sign its own creation.
    expect((launchToken as Mock).mock.calls[0][3]).toBeInstanceOf(Keypair);
  });

  it('reuses the caller-owned mint keypair across retries — a retry is NOT a new token', async () => {
    // The double-launch invariant. The caller holds the keypair precisely so a failed
    // first attempt and its retry produce ONE token, not two.
    const mintKeypair = Keypair.generate();
    const connection = connectionWith([{ err: null, confirmationStatus: 'confirmed' }]);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('user rejected'))
      .mockResolvedValueOnce('SIG_RETRY');

    await expect(submitLaunch({
      connection, sendTransaction: send, walletAddress: WALLET, heatIdentity: EVM, config: CONFIG, mintKeypair, ...META,
    })).rejects.toThrow('user rejected');

    const res = await submitLaunch({
      connection, sendTransaction: send, walletAddress: WALLET, heatIdentity: EVM, config: CONFIG, mintKeypair, ...META,
    });
    expect(res.mint).toBe(mintKeypair.publicKey.toBase58());
  });

  it('rejects an invalid metadata URI before anything is signed or sent', async () => {
    const send = vi.fn();
    await expect(submitLaunch({
      connection: connectionWith([]), sendTransaction: send, walletAddress: WALLET, heatIdentity: EVM,
      config: CONFIG, mintKeypair: Keypair.generate(), name: 'X', symbol: 'X', uri: '   ',
    })).rejects.toThrow(/uri is required/i);
    expect(send).not.toHaveBeenCalled();
    expect(launchToken).not.toHaveBeenCalled();
  });

  it('surfaces an on-chain failure as an error, not a success', async () => {
    await expect(submitLaunch({
      connection: connectionWith([{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }]),
      sendTransaction: vi.fn(async () => 'SIG'), walletAddress: WALLET, heatIdentity: EVM, config: CONFIG,
      mintKeypair: Keypair.generate(), ...META,
    })).rejects.toThrow(/failed on-chain/i);
  });

  it('throws ConfirmationTimeout CARRYING the signature when it broadcast but never confirmed', async () => {
    // The single most important error path: the transaction IS out there. The UI must
    // be able to send the user to an explorer rather than invite a second launch.
    const err = await submitLaunch({
      connection: connectionWith([null]), // never resolves to a status
      sendTransaction: vi.fn(async () => 'SIG_STRANDED'), walletAddress: WALLET, heatIdentity: EVM,
      config: CONFIG, mintKeypair: Keypair.generate(), ...META,
      confirmTimeoutMs: 10,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConfirmationTimeout);
    expect((err as ConfirmationTimeout).signature).toBe('SIG_STRANDED');
    expect((err as Error).message).toMatch(/may have succeeded/i);
  });
});

describe('the post-broadcast contract', () => {
  // THE invariant this module exists to hold: once sendTransaction resolves, the
  // transaction is on the network, so NOTHING may surface as a plain Error — that is
  // how the UI identifies "never submitted" and tells the user retrying is safe.
  // A confirmed CRITICAL: /api/solrpc rewrites any non-ok upstream status to 502, and
  // web3.js retries 429 but NOT 502, so a flaky poll was the dominant path into that
  // false claim.
  it('survives a flaky confirm poll instead of reporting a landed tx as never-sent', async () => {
    let calls = 0;
    const connection = {
      getSignatureStatuses: vi.fn(async () => {
        calls += 1;
        if (calls <= 2) throw new Error('502 Bad Gateway');
        return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
      }),
    } as unknown as Connection;

    const res = await submitLaunch({
      connection, sendTransaction: vi.fn(async () => 'SIG_FLAKY'), walletAddress: WALLET, heatIdentity: EVM,
      config: CONFIG, mintKeypair: Keypair.generate(), ...META, confirmTimeoutMs: 30_000,
    });
    expect(res.signature).toBe('SIG_FLAKY');
    expect(calls).toBeGreaterThan(2); // it kept polling rather than giving up
  });

  it('a persistently failing RPC still ends as ConfirmationTimeout, never a plain Error', async () => {
    const connection = {
      getSignatureStatuses: vi.fn(async () => { throw new Error('502 Bad Gateway'); }),
    } as unknown as Connection;

    const err = await submitLaunch({
      connection, sendTransaction: vi.fn(async () => 'SIG_RPC_DEAD'), walletAddress: WALLET, heatIdentity: EVM,
      config: CONFIG, mintKeypair: Keypair.generate(), ...META, confirmTimeoutMs: 10,
    }).catch((e) => e);

    expect(wasBroadcast(err)).toBe(true);
    expect(err).toBeInstanceOf(ConfirmationTimeout);
    expect((err as ConfirmationTimeout).signature).toBe('SIG_RPC_DEAD');
  });

  it('an on-chain failure is definitive, carries the signature, and counts as broadcast', async () => {
    const err = await submitLaunch({
      connection: connectionWith([{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }]),
      sendTransaction: vi.fn(async () => 'SIG_FAILED'), walletAddress: WALLET, heatIdentity: EVM, config: CONFIG,
      mintKeypair: Keypair.generate(), ...META,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(LaunchFailedOnChain);
    expect((err as LaunchFailedOnChain).signature).toBe('SIG_FAILED');
    expect(wasBroadcast(err)).toBe(true);
  });

  it('reports the signature the moment it is broadcast, before confirmation', async () => {
    // Without this the UI cannot tell "waiting for your wallet" from "already on the
    // network", so it keeps saying "confirm in your wallet" — which is what makes a
    // user reload, losing the mint keypair and making the next attempt a SECOND token.
    const seen: string[] = [];
    await submitLaunch({
      connection: connectionWith([{ err: null, confirmationStatus: 'confirmed' }]),
      sendTransaction: vi.fn(async () => 'SIG_EARLY'), walletAddress: WALLET, heatIdentity: EVM, config: CONFIG,
      mintKeypair: Keypair.generate(), ...META,
      onBroadcast: (sig) => seen.push(sig),
    });
    expect(seen).toEqual(['SIG_EARLY']);
  });

  it('a pre-broadcast failure is NOT flagged as broadcast — retrying really is safe there', async () => {
    const err = await submitLaunch({
      connection: connectionWith([]), sendTransaction: vi.fn(async () => { throw new Error('User rejected'); }),
      walletAddress: WALLET, heatIdentity: EVM, config: CONFIG, mintKeypair: Keypair.generate(), ...META,
    }).catch((e) => e);
    expect(wasBroadcast(err)).toBe(false);
  });
});

describe('confirmSignature', () => {
  it('returns once the status reaches confirmed', async () => {
    await expect(
      confirmSignature(connectionWith([{ err: null, confirmationStatus: 'confirmed' }]), 'S'),
    ).resolves.toBeUndefined();
  });

  it('accepts finalized as well as confirmed', async () => {
    await expect(
      confirmSignature(connectionWith([{ err: null, confirmationStatus: 'finalized' }]), 'S'),
    ).resolves.toBeUndefined();
  });

  it('times out into ConfirmationTimeout rather than hanging or resolving', async () => {
    await expect(confirmSignature(connectionWith([null]), 'S', 10)).rejects.toBeInstanceOf(ConfirmationTimeout);
  });
});
