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

import { launchToken } from './dbcClient';
import { submitLaunch, confirmSignature, ConfirmationTimeout } from './submitLaunch';

const CONFIG = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const WALLET = 'EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK';

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
      connection, sendTransaction: send, walletAddress: WALLET,
      config: CONFIG, mintKeypair, ...META,
    });

    expect(res).toEqual({ signature: 'SIGNATURE_1', mint: mintKeypair.publicKey.toBase58() });
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
      sendTransaction: send, walletAddress: WALLET, config: CONFIG,
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
      connection, sendTransaction: send, walletAddress: WALLET, config: CONFIG, mintKeypair, ...META,
    })).rejects.toThrow('user rejected');

    const res = await submitLaunch({
      connection, sendTransaction: send, walletAddress: WALLET, config: CONFIG, mintKeypair, ...META,
    });
    expect(res.mint).toBe(mintKeypair.publicKey.toBase58());
  });

  it('rejects an invalid metadata URI before anything is signed or sent', async () => {
    const send = vi.fn();
    await expect(submitLaunch({
      connection: connectionWith([]), sendTransaction: send, walletAddress: WALLET,
      config: CONFIG, mintKeypair: Keypair.generate(), name: 'X', symbol: 'X', uri: '   ',
    })).rejects.toThrow(/uri is required/i);
    expect(send).not.toHaveBeenCalled();
    expect(launchToken).not.toHaveBeenCalled();
  });

  it('surfaces an on-chain failure as an error, not a success', async () => {
    await expect(submitLaunch({
      connection: connectionWith([{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }]),
      sendTransaction: vi.fn(async () => 'SIG'), walletAddress: WALLET, config: CONFIG,
      mintKeypair: Keypair.generate(), ...META,
    })).rejects.toThrow(/failed on-chain/i);
  });

  it('throws ConfirmationTimeout CARRYING the signature when it broadcast but never confirmed', async () => {
    // The single most important error path: the transaction IS out there. The UI must
    // be able to send the user to an explorer rather than invite a second launch.
    const err = await submitLaunch({
      connection: connectionWith([null]), // never resolves to a status
      sendTransaction: vi.fn(async () => 'SIG_STRANDED'), walletAddress: WALLET,
      config: CONFIG, mintKeypair: Keypair.generate(), ...META,
      confirmTimeoutMs: 10,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ConfirmationTimeout);
    expect((err as ConfirmationTimeout).signature).toBe('SIG_STRANDED');
    expect((err as Error).message).toMatch(/may have succeeded/i);
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
