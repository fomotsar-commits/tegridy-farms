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
import { SQUADS_V4_PROGRAM_ID, verifySquadsVault } from './squads';
import { createPartnerConfig, launchToken, claimPartnerFees, type WalletSigner } from './dbcClient';

const gateMock = isSolanaLauncherEnabled as unknown as Mock;
const buildCurveMock = buildCurveWithMarketCap as unknown as Mock;
const SQUADS_PROGRAM = new PublicKey(SQUADS_V4_PROGRAM_ID);

// Fresh, valid 32-byte pubkeys (the wrapper constructs real PublicKeys from them).
let configKp: Keypair;
let baseMintKp: Keypair;
let payerKp: Keypair;
let creatorKp: Keypair;
let poolKp: Keypair;
let vault: ReturnType<typeof asSquadsVault>;
let vault2: ReturnType<typeof asSquadsVault>;

beforeEach(() => {
  configKp = Keypair.generate();
  baseMintKp = Keypair.generate();
  payerKp = Keypair.generate();
  creatorKp = Keypair.generate();
  poolKp = Keypair.generate();
  vault = asSquadsVault(Keypair.generate().publicKey.toBase58());
  vault2 = asSquadsVault(Keypair.generate().publicKey.toBase58());
  gateMock.mockReturnValue(true);
  buildCurveMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

// A mock DBC client. `owner` decides what getAccountInfo reports for vault checks:
// the Squads program (vault ok), the System program (an EOA), or null (missing).
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

    await createPartnerConfig(asClient(client), pc, undefined, configKp);

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
    await createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp);
    expect(client.connection.getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it('partial-signs the config keypair and returns the wallet-signed tx', async () => {
    const client = makeClient();
    const signed = { __signed: true } as unknown as Transaction;
    const signer: WalletSigner = {
      publicKey: payerKp.publicKey,
      signTransaction: vi.fn(async () => signed),
    };
    const out = await createPartnerConfig(asClient(client), partnerConfig(), signer, configKp);
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    // The tx handed to the wallet was first partial-signed with the config keypair.
    const handed = (signer.signTransaction as Mock).mock.calls[0]![0] as { partialSign: Mock };
    expect(handed.partialSign).toHaveBeenCalledWith(configKp);
    expect(out).toBe(signed);
  });

  it('rejects when the config keypair pubkey does not match the descriptor', async () => {
    const client = makeClient();
    await expect(createPartnerConfig(asClient(client), partnerConfig(), undefined, Keypair.generate())).rejects.toThrow(
      /does not match the descriptor config/,
    );
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

    await claimPartnerFees(asClient(client), params);

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

    await claimPartnerFees(asClient(client), params);

    const arg = client.partner.claimPartnerTradingFeeToReceiver.mock.calls[0]![0] as Record<string, unknown>;
    expect(String(arg.maxBaseAmount)).toBe('123');
    expect(String(arg.maxQuoteAmount)).toBe('456');
    expect((arg.receiver as PublicKey).toBase58()).toBe(vault2);
    // feeClaimer + receiver both verified on-chain.
    expect(client.connection.getAccountInfo).toHaveBeenCalledTimes(2);
  });
});

describe('feature gate', () => {
  beforeEach(() => gateMock.mockReturnValue(false));

  it('createPartnerConfig throws when the launcher is gated', async () => {
    await expect(createPartnerConfig(asClient(makeClient()), partnerConfig(), undefined, configKp)).rejects.toThrow(
      /gated/i,
    );
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
    await expect(claimPartnerFees(asClient(makeClient()), params)).rejects.toThrow(/gated/i);
  });
});

describe('Squads-vault assertion (on-chain owner check)', () => {
  it('createPartnerConfig rejects when the fee authority is an EOA (System-owned)', async () => {
    const client = makeClient(SystemProgram.programId);
    await expect(createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp)).rejects.toThrow(
      /not owned by the Squads v4 program/,
    );
    expect(client.partner.createConfig).not.toHaveBeenCalled();
  });

  it('createPartnerConfig rejects when the fee authority account does not exist', async () => {
    const client = makeClient(null);
    await expect(createPartnerConfig(asClient(client), partnerConfig(), undefined, configKp)).rejects.toThrow(
      /not owned by the Squads v4 program/,
    );
  });

  it('claimPartnerFees rejects when the receiver is not a Squads vault', async () => {
    const client = makeClient(SystemProgram.programId);
    const params = claimPartnerFeesParams({
      feeClaimer: vault,
      pool: poolKp.publicKey.toBase58(),
      payer: payerKp.publicKey.toBase58(),
    });
    await expect(claimPartnerFees(asClient(client), params)).rejects.toThrow(/not owned by the Squads v4 program/);
    expect(client.partner.claimPartnerTradingFeeToReceiver).not.toHaveBeenCalled();
  });
});

describe('verifySquadsVault', () => {
  const conn = (owner: PublicKey | null | 'throw') =>
    ({
      getAccountInfo: vi.fn(async () => {
        if (owner === 'throw') throw new Error('RPC down');
        return owner === null ? null : { owner };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it('returns true when the account is owned by the Squads v4 program', async () => {
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), Keypair.generate().publicKey.toBase58())).resolves.toBe(true);
  });

  it('returns false for an EOA (System-program-owned account)', async () => {
    await expect(verifySquadsVault(conn(SystemProgram.programId), Keypair.generate().publicKey.toBase58())).resolves.toBe(
      false,
    );
  });

  it('returns false when the account does not exist', async () => {
    await expect(verifySquadsVault(conn(null), Keypair.generate().publicKey.toBase58())).resolves.toBe(false);
  });

  it('throws on an empty address', async () => {
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), '   ')).rejects.toThrow(/empty/);
  });

  it('throws on a malformed base58 address', async () => {
    await expect(verifySquadsVault(conn(SQUADS_PROGRAM), 'not-a-valid-key!!!')).rejects.toThrow();
  });

  it('propagates an RPC failure instead of coercing it to false', async () => {
    await expect(verifySquadsVault(conn('throw'), Keypair.generate().publicKey.toBase58())).rejects.toThrow(/RPC down/);
  });
});
