// @vitest-environment node
// The operator signing wrapper is Node-only (never bundled into the browser wizard,
// which imports dbc.ts alone). Squads vault-PDA derivation uses web3.js's SYNC sha256
// path, which the jsdom/browser build of web3.js stubs out — so this suite runs under
// the node environment where findProgramAddressSync works.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Keypair, PublicKey, SystemProgram, type Transaction } from '@solana/web3.js';

// Stub the heavy SDK curve builder so mapping tests don't run real curve math;
// dbc.ts imports the SDK type-only (erased), so only dbcClient.ts sees this mock.
vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  buildCurveWithMarketCap: vi.fn(() => ({ __configParams: 'CURVE' })),
  DynamicBondingCurveClient: { create: vi.fn() },
}));

// Keep the REAL pure builders + asSquadsVault; only flip the feature gate so the
// mapping paths are reachable (the module default is false).
vi.mock('./dbc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dbc')>();
  return { ...actual, isSolanaLauncherEnabled: vi.fn(() => true) };
});

import { buildCurveWithMarketCap } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  asSquadsVault,
  buildDbcPartnerConfig,
  buildLaunchParams,
  claimPartnerFeesParams,
  isSolanaLauncherEnabled,
  U64_MAX,
} from './dbc';
import { SQUADS_V4_PROGRAM_ID, deriveSquadsVaultPda, verifySquadsVault } from './squads';
import { createPartnerConfig, launchToken, claimPartnerFees, type WalletSigner, type VaultProvenanceMap } from './dbcClient';

const gateMock = isSolanaLauncherEnabled as unknown as Mock;
const buildCurveMock = buildCurveWithMarketCap as unknown as Mock;
const SQUADS_PROGRAM = new PublicKey(SQUADS_V4_PROGRAM_ID);
const VAULT_INDEX = 0;

// Fresh, valid 32-byte pubkeys (the wrapper constructs real PublicKeys from them).
let configKp: Keypair;
let baseMintKp: Keypair;
let payerKp: Keypair;
let creatorKp: Keypair;
let poolKp: Keypair;
// Squads multisig configs + their DERIVED vault PDAs (System-owned, the real
// fee-claim signer). `vault` is the fee address; `provenance` binds it to its multisig.
let multisigKp: Keypair;
let multisig2Kp: Keypair;
let vault: ReturnType<typeof asSquadsVault>;
let vault2: ReturnType<typeof asSquadsVault>;
let provenance: VaultProvenanceMap;

beforeEach(() => {
  configKp = Keypair.generate();
  baseMintKp = Keypair.generate();
  payerKp = Keypair.generate();
  creatorKp = Keypair.generate();
  poolKp = Keypair.generate();
  multisigKp = Keypair.generate();
  multisig2Kp = Keypair.generate();
  vault = asSquadsVault(deriveSquadsVaultPda(multisigKp.publicKey.toBase58(), VAULT_INDEX));
  vault2 = asSquadsVault(deriveSquadsVaultPda(multisig2Kp.publicKey.toBase58(), VAULT_INDEX));
  provenance = {
    [vault]: { multisig: multisigKp.publicKey.toBase58(), vaultIndex: VAULT_INDEX },
    [vault2]: { multisig: multisig2Kp.publicKey.toBase58(), vaultIndex: VAULT_INDEX },
  };
  gateMock.mockReturnValue(true);
  buildCurveMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// A mock DBC client. `owner` decides what getAccountInfo reports for the MULTISIG
// account verifySquadsVault fetches: the Squads program (real multisig), the System
// program (a look-alike), or null (missing).
function makeClient(owner: PublicKey | null | 'throw' = SQUADS_PROGRAM) {
  const getAccountInfo = vi.fn(async () => {
    if (owner === 'throw') throw new Error('RPC down');
    return owner === null ? null : { owner };
  });
  const mkTx = () => ({ __tx: true, partialSign: vi.fn() }) as unknown as Transaction;
  return {
    connection: { getAccountInfo },
    partner: {
      createConfig: vi.fn(async (_p: unknown) => mkTx()),
      claimPartnerTradingFeeToReceiver: vi.fn(async (_p: unknown) => mkTx()),
    },
    creator: {
      createPool: vi.fn(async (_p: unknown) => mkTx()),
    },
  };
}

type MockClient = ReturnType<typeof makeClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asClient = (c: MockClient) => c as any;

function partnerConfig() {
  return buildDbcPartnerConfig({
    feeClaimer: vault,
    config: configKp.publicKey.toBase58(),
    payer: payerKp.publicKey.toBase58(),
    initialMarketCap: 5_000,
    migrationMarketCap: 50_000,
  });
}

function launchParams() {
  return buildLaunchParams(
    {
      config: configKp.publicKey.toBase58(),
      baseMint: baseMintKp.publicKey.toBase58(),
      poolCreator: creatorKp.publicKey.toBase58(),
      payer: payerKp.publicKey.toBase58(),
    },
    { name: 'Tegridy Meme', symbol: 'TMEME', uri: 'ipfs://cid' },
  );
}

describe('createPartnerConfig — base58 → PublicKey mapping', () => {
  it('maps every account descriptor to a PublicKey and spreads the curve params', async () => {
    const client = makeClient();
    const pc = partnerConfig();

    await createPartnerConfig(asClient(client), pc, undefined, configKp, provenance);

    expect(buildCurveMock).toHaveBeenCalledWith(pc.curve);
    expect(client.partner.createConfig).toHaveBeenCalledTimes(1);
    const arg = client.partner.createConfig.mock.calls[0]![0] as Record<string, unknown>;

    for (const key of ['config', 'feeClaimer', 'leftoverReceiver', 'quoteMint', 'payer'] as const) {
      expect(arg[key]).toBeInstanceOf(PublicKey);
    }
    expect((arg.config as PublicKey).toBase58()).toBe(pc.accounts.config);
    expect((arg.feeClaimer as PublicKey).toBase58()).toBe(pc.accounts.feeClaimer);
    expect((arg.leftoverReceiver as PublicKey).toBase58()).toBe(pc.accounts.leftoverReceiver);
    expect((arg.quoteMint as PublicKey).toBase58()).toBe(pc.accounts.quoteMint);
    expect((arg.payer as PublicKey).toBase58()).toBe(pc.accounts.payer);
    // ConfigParameters from buildCurveWithMarketCap are spread into the call.
    expect(arg.__configParams).toBe('CURVE');
  });

  it('verifies feeClaimer AND leftoverReceiver on-chain before building', async () => {
    const client = makeClient(SQUADS_PROGRAM);
    await createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp, provenance);
    expect(client.connection.getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it('throws when a vault is missing its provenance (fail-closed)', async () => {
    const client = makeClient();
    await expect(createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp, {})).rejects.toThrow(
      /missing Squads vault provenance/,
    );
    expect(client.partner.createConfig).not.toHaveBeenCalled();
  });

  it('partial-signs the config keypair and returns the wallet-signed tx', async () => {
    const client = makeClient();
    const signed = { __signed: true } as unknown as Transaction;
    const signer: WalletSigner = {
      publicKey: payerKp.publicKey,
      signTransaction: vi.fn(async () => signed),
    };
    const out = await createPartnerConfig(asClient(client), partnerConfig(), signer, configKp, provenance);
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    // The tx handed to the wallet was first partial-signed with the config keypair.
    const handed = (signer.signTransaction as Mock).mock.calls[0]![0] as { partialSign: Mock };
    expect(handed.partialSign).toHaveBeenCalledWith(configKp);
    expect(out).toBe(signed);
  });

  it('rejects when the config keypair pubkey does not match the descriptor', async () => {
    const client = makeClient();
    await expect(
      createPartnerConfig(asClient(client), partnerConfig(), undefined, Keypair.generate(), provenance),
    ).rejects.toThrow(/does not match the descriptor config/);
    expect(client.partner.createConfig).not.toHaveBeenCalled();
  });
});

describe('launchToken — base58 → PublicKey mapping', () => {
  it('maps accounts to PublicKeys and passes token metadata strings through', async () => {
    const client = makeClient();
    const p = launchParams();

    await launchToken(asClient(client), p, undefined, baseMintKp);

    expect(client.creator.createPool).toHaveBeenCalledTimes(1);
    const arg = client.creator.createPool.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.name).toBe('Tegridy Meme');
    expect(arg.symbol).toBe('TMEME');
    expect(arg.uri).toBe('ipfs://cid');
    for (const key of ['config', 'baseMint', 'poolCreator', 'payer'] as const) {
      expect(arg[key]).toBeInstanceOf(PublicKey);
    }
    expect((arg.baseMint as PublicKey).toBase58()).toBe(p.baseMint);
    expect((arg.poolCreator as PublicKey).toBase58()).toBe(p.poolCreator);
  });

  it('does not touch the RPC (no vault involved) and partial-signs the base mint', async () => {
    const client = makeClient();
    const out = (await launchToken(asClient(client), launchParams(), undefined, baseMintKp)) as unknown as {
      partialSign: Mock;
    };
    expect(client.connection.getAccountInfo).not.toHaveBeenCalled();
    expect(out.partialSign).toHaveBeenCalledWith(baseMintKp);
  });

  it('rejects when the base-mint keypair pubkey does not match the descriptor', async () => {
    const client = makeClient();
    await expect(launchToken(asClient(client), launchParams(), undefined, Keypair.generate())).rejects.toThrow(
      /does not match the descriptor baseMint/,
    );
  });
});

describe('claimPartnerFees — bigint → BN mapping', () => {
  it('maps addresses to PublicKeys and U64_MAX defaults to a BN', async () => {
    const client = makeClient();
    const params = claimPartnerFeesParams({
      feeClaimer: vault,
      pool: poolKp.publicKey.toBase58(),
      payer: payerKp.publicKey.toBase58(),
    });

    await claimPartnerFees(asClient(client), params, undefined, provenance);

    const arg = client.partner.claimPartnerTradingFeeToReceiver.mock.calls[0]![0] as Record<string, unknown>;
    for (const key of ['feeClaimer', 'payer', 'pool', 'receiver'] as const) {
      expect(arg[key]).toBeInstanceOf(PublicKey);
    }
    // BN (from @coral-xyz/anchor) carrying the exact u64-max sentinel.
    expect(String(arg.maxBaseAmount)).toBe(U64_MAX.toString());
    expect(String(arg.maxQuoteAmount)).toBe(U64_MAX.toString());
  });

  it('maps explicit bigint amounts and a distinct receiver vault', async () => {
    const client = makeClient();
    const params = claimPartnerFeesParams({
      feeClaimer: vault,
      receiver: vault2,
      pool: poolKp.publicKey.toBase58(),
      payer: payerKp.publicKey.toBase58(),
      maxBaseAmount: 123n,
      maxQuoteAmount: 456n,
    });

    await claimPartnerFees(asClient(client), params, undefined, provenance);

    const arg = client.partner.claimPartnerTradingFeeToReceiver.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(arg.maxBaseAmount)).toBe('123');
    expect(String(arg.maxQuoteAmount)).toBe('456');
    expect((arg.receiver as PublicKey).toBase58()).toBe(vault2);
    // feeClaimer + receiver both verified on-chain (their multisigs fetched).
    expect(client.connection.getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it('re-asserts u64 bounds on an operator-built params object (L3)', async () => {
    const client = makeClient();
    // Bypass the pure builder's bounds check with a hand-built params object.
    const bad = {
      feeClaimer: vault,
      receiver: vault,
      pool: poolKp.publicKey.toBase58(),
      payer: payerKp.publicKey.toBase58(),
      maxBaseAmount: -1n,
      maxQuoteAmount: 0n,
    } as ReturnType<typeof claimPartnerFeesParams>;
    await expect(claimPartnerFees(asClient(client), bad, undefined, provenance)).rejects.toThrow(/maxBaseAmount/);
    expect(client.partner.claimPartnerTradingFeeToReceiver).not.toHaveBeenCalled();
  });
});

describe('feature gate', () => {
  beforeEach(() => gateMock.mockReturnValue(false));

  it('createPartnerConfig throws when the launcher is gated', async () => {
    await expect(
      createPartnerConfig(asClient(makeClient()), partnerConfig(), undefined, configKp, provenance),
    ).rejects.toThrow(/gated/i);
  });
  it('launchToken throws when the launcher is gated', async () => {
    await expect(launchToken(asClient(makeClient()), launchParams(), undefined, baseMintKp)).rejects.toThrow(/gated/i);
  });
  it('claimPartnerFees throws when the launcher is gated', async () => {
    const params = claimPartnerFeesParams({
      feeClaimer: vault,
      pool: poolKp.publicKey.toBase58(),
      payer: payerKp.publicKey.toBase58(),
    });
    await expect(claimPartnerFees(asClient(makeClient()), params, undefined, provenance)).rejects.toThrow(/gated/i);
  });
});

describe('Squads-vault assertion (on-chain vault-PDA check)', () => {
  it('createPartnerConfig rejects when the parent multisig is a look-alike (System-owned)', async () => {
    const client = makeClient(SystemProgram.programId);
    await expect(createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp, provenance)).rejects.toThrow(
      /not the Squads v4 vault PDA/,
    );
    expect(client.partner.createConfig).not.toHaveBeenCalled();
  });

  it('createPartnerConfig rejects when the parent multisig does not exist', async () => {
    const client = makeClient(null);
    await expect(createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp, provenance)).rejects.toThrow(
      /not the Squads v4 vault PDA/,
    );
  });

  it('rejects when the fee address is not the multisig vault PDA (an EOA / wrong provenance)', async () => {
    const client = makeClient(SQUADS_PROGRAM);
    // vault is derived from multisigKp; point its provenance at multisig2Kp so the
    // derived PDA no longer matches — a stand-in for an EOA fee address.
    const wrong: VaultProvenanceMap = {
      [vault]: { multisig: multisig2Kp.publicKey.toBase58(), vaultIndex: VAULT_INDEX },
    };
    await expect(createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp, wrong)).rejects.toThrow(
      /not the Squads v4 vault PDA/,
    );
    // Rejected on the pure derive/compare — the multisig was never fetched.
    expect(client.connection.getAccountInfo).not.toHaveBeenCalled();
  });

  it('claimPartnerFees rejects when the receiver multisig is not Squads-owned', async () => {
    const client = makeClient(SystemProgram.programId);
    const params = claimPartnerFeesParams({
      feeClaimer: vault,
      pool: poolKp.publicKey.toBase58(),
      payer: payerKp.publicKey.toBase58(),
    });
    await expect(claimPartnerFees(asClient(client), params, undefined, provenance)).rejects.toThrow(
      /not the Squads v4 vault PDA/,
    );
    expect(client.partner.claimPartnerTradingFeeToReceiver).not.toHaveBeenCalled();
  });
});

describe('verifySquadsVault (correct vault-PDA model)', () => {
  const conn = (owner: PublicKey | null | 'throw') =>
    ({
      getAccountInfo: vi.fn(async () => {
        if (owner === 'throw') throw new Error('RPC down');
        return owner === null ? null : { owner };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  const ms = () => Keypair.generate().publicKey.toBase58();

  it('returns true when the address is the derived vault PDA and the multisig is Squads-owned', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), { address, multisig, vaultIndex: 0 })).resolves.toBe(true);
  });

  it('returns false (without fetching) when the address is not the multisig vault PDA', async () => {
    const multisig = ms();
    const c = conn(SQUADS_PROGRAM);
    await expect(
      verifySquadsVault(c, { address: Keypair.generate().publicKey.toBase58(), multisig, vaultIndex: 0 }),
    ).resolves.toBe(false);
    expect(c.getAccountInfo).not.toHaveBeenCalled();
  });

  it('returns false when the multisig is not Squads-owned (System program)', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn(SystemProgram.programId), { address, multisig, vaultIndex: 0 })).resolves.toBe(
      false,
    );
  });

  it('returns false when the multisig account does not exist', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn(null), { address, multisig, vaultIndex: 0 })).resolves.toBe(false);
  });

  it('throws on an empty address or empty multisig', async () => {
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), { address: '   ', multisig: ms(), vaultIndex: 0 })).rejects.toThrow(
      /empty/,
    );
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), { address: ms(), multisig: '   ', vaultIndex: 0 })).rejects.toThrow(
      /empty/,
    );
  });

  it('throws on a malformed multisig base58', async () => {
    await expect(
      verifySquadsVault(conn(SQUADS_PROGRAM), { address: ms(), multisig: 'not-a-valid-key!!!', vaultIndex: 0 }),
    ).rejects.toThrow();
  });

  it('propagates an RPC failure instead of coercing it to false', async () => {
    const multisig = ms();
    const address = deriveSquadsVaultPda(multisig, 0);
    await expect(verifySquadsVault(conn('throw'), { address, multisig, vaultIndex: 0 })).rejects.toThrow(/RPC down/);
  });
});

describe('deriveSquadsVaultPda', () => {
  it('is deterministic, off-curve, and index-sensitive', () => {
    const multisig = Keypair.generate().publicKey.toBase58();
    const a = deriveSquadsVaultPda(multisig, 0);
    expect(deriveSquadsVaultPda(multisig, 0)).toBe(a);
    expect(PublicKey.isOnCurve(new PublicKey(a))).toBe(false); // a PDA is off the ed25519 curve
    expect(deriveSquadsVaultPda(multisig, 1)).not.toBe(a); // the vault index is part of the seed
  });

  it('rejects an out-of-range vault index', () => {
    const multisig = Keypair.generate().publicKey.toBase58();
    expect(() => deriveSquadsVaultPda(multisig, 256)).toThrow(/u8/);
    expect(() => deriveSquadsVaultPda(multisig, -1)).toThrow(/u8/);
  });
});
