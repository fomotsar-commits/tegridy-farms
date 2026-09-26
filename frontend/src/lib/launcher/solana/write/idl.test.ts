// @vitest-environment node
// PDA derivation under jsdom fails on a realm mismatch inside web3.js (see program.ts).
//
// EVERY ACCOUNT LIST THE WRITE PATH SENDS, HELD AGAINST THE PROGRAMS' OWN IDLs.
//
// The IDLs are the ones emitted with the exact mainnet binaries
// (C:\Users\jimbo\solana-launch-release-2026-09-26\artifacts), committed under
// solana/tegridy-amm/idl/ and pinned here by sha256 against that release's
// SHA256SUMS. For each instruction a transaction can carry we check, position by
// position: the account's IDL name maps to the address we put there, and its signer
// and writable flags equal the IDL's. Discriminators and argument layouts too.
// An account list that only agrees with itself is how this repo shipped two
// instructions that could never succeed (see curve/ix.ts); this is the other side.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  LAUNCH_ERROR_CODES,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  cpAmmAuthorityPda,
  cpLpMintPda,
  cpObservationPda,
  cpPermissionPda,
  cpPoolVaultPda,
  curvePda,
  curveVaultPda,
  globalPda,
  migrationAuthorityPda,
  poolStatePda,
  sortMints,
} from '../curve/program';
import { associatedTokenAddress, migrateToAmmIx, releasePlatformReserveIx, sellIx } from '../curve/ix';
import { deriveAuthority, deriveObservation, deriveVault } from '../../../solana/cpswap/program';
import { swapBaseInputIx } from '../../../solana/cpswap/ix';
import { CP_SWAP_ERROR_CODES, CP_SWAP_ERROR_COPY } from '../../../solana/cpswap/errors';
import { CP_CREATE_POOL_FEE_RECEIVER, launchIndexAddress } from './config';
import { createLaunchInstructions } from './launch';
import { LAUNCH_FAILURE_COPY } from './errors';
import { AMM_CONFIG, CPSWAP, LAUNCH, VAULT, cfgLocal, globalValue } from './testkit.fixture';
import type { OpenGate } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const IDL_DIR = resolve(HERE, '../../../../../../solana/tegridy-amm/idl');
const LAUNCH_IDL_PATH = resolve(IDL_DIR, 'tegridy_launch.json');
const CPSWAP_IDL_PATH = resolve(IDL_DIR, 'raydium_cp_swap.json');

/** From the release's artifacts/SHA256SUMS. */
const SHA256 = {
  launch: 'd987fafe7b2e50a4e760c5d7d2607d7f35896cc2efd786310dd784cce3928751',
  cpswap: '939bc040fa0f65b6639f07545be9d23fde0492e9b5fc3d90229a313b0fcf0262',
};

interface IdlAccount {
  name: string;
  signer?: boolean;
  writable?: boolean;
  address?: string;
}
interface IdlIx {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
  args: Array<{ name: string; type: unknown }>;
}
interface Idl {
  address: string;
  instructions: IdlIx[];
  errors: Array<{ code: number; name: string }>;
}

const load = (p: string): { raw: Buffer; idl: Idl } => {
  const raw = readFileSync(p);
  return { raw, idl: JSON.parse(raw.toString('utf8')) as Idl };
};

describe('the committed IDLs are the release artifacts', () => {
  // Not a skip: a missing IDL means these guards are not running, and that must fail.
  it('both files exist', () => {
    expect(existsSync(LAUNCH_IDL_PATH), LAUNCH_IDL_PATH).toBe(true);
    expect(existsSync(CPSWAP_IDL_PATH), CPSWAP_IDL_PATH).toBe(true);
  });
  it('hash to the release SHA256SUMS', () => {
    expect(createHash('sha256').update(load(LAUNCH_IDL_PATH).raw).digest('hex')).toBe(SHA256.launch);
    expect(createHash('sha256').update(load(CPSWAP_IDL_PATH).raw).digest('hex')).toBe(SHA256.cpswap);
  });
  it('name the registered program ids', () => {
    expect(load(LAUNCH_IDL_PATH).idl.address).toBe(LAUNCH.toBase58());
    expect(load(CPSWAP_IDL_PATH).idl.address).toBe(CPSWAP.toBase58());
  });
});

const launchIdl = () => load(LAUNCH_IDL_PATH).idl;
const cpIdl = () => load(CPSWAP_IDL_PATH).idl;
const ixOf = (idl: Idl, name: string): IdlIx => {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`${name} not in IDL`);
  return ix;
};

/**
 * Hold a built instruction against the IDL: count, per-position address (via the
 * name→address map), signer and writable flags, fixed addresses, discriminator.
 */
function assertParity(ix: TransactionInstruction, spec: IdlIx, byName: Record<string, PublicKey>, programId: PublicKey) {
  expect(ix.programId.toBase58()).toBe(programId.toBase58());
  expect(Array.from(ix.data.subarray(0, 8))).toEqual(spec.discriminator);
  expect(ix.keys.length).toBeGreaterThanOrEqual(spec.accounts.length);
  spec.accounts.forEach((a, i) => {
    const k = ix.keys[i]!;
    const want = byName[a.name];
    expect(want, `no expected address for IDL account "${a.name}"`).toBeDefined();
    expect(k.pubkey.toBase58(), `${spec.name}[${i}] ${a.name}`).toBe(want!.toBase58());
    if (a.address) expect(k.pubkey.toBase58(), `${spec.name}[${i}] fixed address`).toBe(a.address);
    expect(k.isSigner, `${spec.name}[${i}] ${a.name} signer`).toBe(!!a.signer);
    expect(k.isWritable, `${spec.name}[${i}] ${a.name} writable`).toBe(!!a.writable);
  });
}

const u64At = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);

const CREATOR = Keypair.generate().publicKey;
const MINT_KP = Keypair.generate();
const MINT = MINT_KP.publicKey;
const TRADER = Keypair.generate().publicKey;

const gate: OpenGate = {
  kind: 'open',
  cfg: cfgLocal,
  global: globalValue(),
  ammConfig: {
    address: AMM_CONFIG.toBase58(), index: 0, disableCreatePool: false, tradeFeeRate: 2500n, protocolFeeRate: 120000n,
    fundFeeRate: 0n, createPoolFee: 0n, creatorFeeRate: 0n, protocolOwner: VAULT.toBase58(), fundOwner: VAULT.toBase58(),
  },
  ammConfigAddress: AMM_CONFIG,
  paused: false,
  graduation: { permission: true, createPoolFeeReceiver: true },
};

describe('create transaction: every launch-program instruction matches the IDL', () => {
  const ixs = createLaunchInstructions(
    gate,
    { creator: CREATOR, mint: MINT_KP, metadata: { name: 'Test', symbol: 'TST', uri: 'https://ipfs.io/ipfs/bafy' } },
    1_461_600,
    { maxLamportsIn: 50_000_000n, minTokensOut: 123n },
  );

  it('is create account, init mint, metadata, create_launch, ATA, buy, in that order', () => {
    expect(ixs.map((i) => i.programId.toBase58())).toEqual([
      SYSTEM_PROGRAM_ID.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
      LAUNCH.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      LAUNCH.toBase58(),
    ]);
  });

  it('create_launch: 8 IDL accounts, then the launch index as a trailing read-only key', () => {
    const ix = ixs[3]!;
    assertParity(ix, ixOf(launchIdl(), 'create_launch'), {
      creator: CREATOR,
      global: globalPda(LAUNCH),
      mint: MINT,
      curve: curvePda(MINT, LAUNCH),
      curve_vault: curveVaultPda(MINT, LAUNCH),
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }, LAUNCH);
    expect(ix.keys).toHaveLength(9);
    expect(ix.keys[8]).toEqual({ pubkey: launchIndexAddress(LAUNCH), isSigner: false, isWritable: false });
    expect(ix.data.length).toBe(8); // no args
  });

  it('the opening buy: creator is both trader and creator, fee recipient from global, exact args', () => {
    const ix = ixs[5]!;
    assertParity(ix, ixOf(launchIdl(), 'buy'), {
      trader: CREATOR,
      global: globalPda(LAUNCH),
      fee_recipient: VAULT,
      mint: MINT,
      curve: curvePda(MINT, LAUNCH),
      creator: CREATOR,
      curve_vault: curveVaultPda(MINT, LAUNCH),
      trader_token_account: associatedTokenAddress(MINT, CREATOR),
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
    }, LAUNCH);
    expect(ixOf(launchIdl(), 'buy').args.map((a) => [a.name, a.type])).toEqual([
      ['max_lamports_in', 'u64'],
      ['min_tokens_out', 'u64'],
    ]);
    expect(ix.data.length).toBe(24);
    expect(u64At(ix.data, 8)).toBe(50_000_000n);
    expect(u64At(ix.data, 16)).toBe(123n);
  });
});

describe('sell, migrate and release match the IDL', () => {
  it('sell: 10 accounts, args tokens_in then min_lamports_out', () => {
    const ix = sellIx({ trader: TRADER, mint: MINT, feeRecipient: VAULT, creator: CREATOR }, 7n, 5n, { programId: LAUNCH });
    assertParity(ix, ixOf(launchIdl(), 'sell'), {
      trader: TRADER, global: globalPda(LAUNCH), fee_recipient: VAULT, mint: MINT, curve: curvePda(MINT, LAUNCH),
      creator: CREATOR, curve_vault: curveVaultPda(MINT, LAUNCH), trader_token_account: associatedTokenAddress(MINT, TRADER),
      token_program: TOKEN_PROGRAM_ID, system_program: SYSTEM_PROGRAM_ID,
    }, LAUNCH);
    expect(ixOf(launchIdl(), 'sell').args.map((a) => a.name)).toEqual(['tokens_in', 'min_lamports_out']);
    expect(u64At(ix.data, 8)).toBe(7n);
    expect(u64At(ix.data, 16)).toBe(5n);
  });

  it('migrate_to_amm: all 25 accounts, as the write path builds it', () => {
    const ix = migrateToAmmIx(
      { payer: TRADER, creator: CREATOR, feeRecipient: VAULT, launchMint: MINT, ammConfig: AMM_CONFIG, createPoolFee: CP_CREATE_POOL_FEE_RECEIVER },
      { programId: LAUNCH, cpSwapProgram: CPSWAP },
    );
    const spec = ixOf(launchIdl(), 'migrate_to_amm');
    expect(spec.accounts).toHaveLength(25);
    expect(ix.keys).toHaveLength(25);
    const auth = migrationAuthorityPda(LAUNCH);
    const pool = poolStatePda(MINT, LAUNCH);
    const lp = cpLpMintPda(pool, CPSWAP);
    const [m0, m1] = sortMints(WSOL_MINT, MINT);
    assertParity(ix, spec, {
      payer: TRADER, global: globalPda(LAUNCH), fee_recipient: VAULT, launch_mint: MINT, curve: curvePda(MINT, LAUNCH),
      curve_vault: curveVaultPda(MINT, LAUNCH), wsol_mint: WSOL_MINT, creator: CREATOR, migration_authority: auth,
      auth_wsol: associatedTokenAddress(WSOL_MINT, auth), auth_token: associatedTokenAddress(MINT, auth),
      auth_lp: associatedTokenAddress(lp, auth), cp_swap_program: CPSWAP, amm_config: AMM_CONFIG,
      cp_swap_permission: cpPermissionPda(auth, CPSWAP), amm_authority: cpAmmAuthorityPda(CPSWAP), pool_state: pool,
      lp_mint: lp, token_0_vault: cpPoolVaultPda(pool, m0, CPSWAP), token_1_vault: cpPoolVaultPda(pool, m1, CPSWAP),
      create_pool_fee: CP_CREATE_POOL_FEE_RECEIVER, observation_state: cpObservationPda(pool, CPSWAP),
      token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: SYSTEM_PROGRAM_ID,
    }, LAUNCH);
    expect(ix.data.length).toBe(8);
  });

  it('release_platform_reserve: 10 accounts, the treasury ATA owned by the fee recipient', () => {
    const ix = releasePlatformReserveIx({ payer: TRADER, feeRecipient: VAULT, mint: MINT }, { programId: LAUNCH });
    assertParity(ix, ixOf(launchIdl(), 'release_platform_reserve'), {
      payer: TRADER, global: globalPda(LAUNCH), fee_recipient: VAULT, mint: MINT, curve: curvePda(MINT, LAUNCH),
      curve_vault: curveVaultPda(MINT, LAUNCH), recipient_token: associatedTokenAddress(MINT, VAULT),
      token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: SYSTEM_PROGRAM_ID,
    }, LAUNCH);
  });
});

describe('cp-swap swap_base_input matches the fork IDL', () => {
  it('13 accounts in order, payer signs but is not writable, args amount_in then minimum_amount_out', () => {
    const pool = poolStatePda(MINT, LAUNCH);
    const ix = swapBaseInputIx({
      programId: CPSWAP, payer: TRADER, ammConfig: AMM_CONFIG, poolState: pool,
      inputTokenAccount: associatedTokenAddress(WSOL_MINT, TRADER), outputTokenAccount: associatedTokenAddress(MINT, TRADER),
      inputVault: deriveVault(CPSWAP, pool, WSOL_MINT), outputVault: deriveVault(CPSWAP, pool, MINT),
      inputTokenProgram: TOKEN_PROGRAM_ID, outputTokenProgram: TOKEN_PROGRAM_ID, inputTokenMint: WSOL_MINT, outputTokenMint: MINT,
      observationState: deriveObservation(CPSWAP, pool), amountIn: 9n, minimumAmountOut: 4n,
    });
    const spec = ixOf(cpIdl(), 'swap_base_input');
    expect(spec.accounts).toHaveLength(13);
    assertParity(ix, spec, {
      payer: TRADER, authority: deriveAuthority(CPSWAP), amm_config: AMM_CONFIG, pool_state: pool,
      input_token_account: associatedTokenAddress(WSOL_MINT, TRADER), output_token_account: associatedTokenAddress(MINT, TRADER),
      input_vault: deriveVault(CPSWAP, pool, WSOL_MINT), output_vault: deriveVault(CPSWAP, pool, MINT),
      input_token_program: TOKEN_PROGRAM_ID, output_token_program: TOKEN_PROGRAM_ID,
      input_token_mint: WSOL_MINT, output_token_mint: MINT, observation_state: deriveObservation(CPSWAP, pool),
    }, CPSWAP);
    expect(spec.args.map((a) => a.name)).toEqual(['amount_in', 'minimum_amount_out']);
    expect(u64At(ix.data, 8)).toBe(9n);
    expect(u64At(ix.data, 16)).toBe(4n);
  });

  it('the launch program derives the same pool vaults and price record the pool program does', () => {
    const pool = poolStatePda(MINT, LAUNCH);
    expect(deriveVault(CPSWAP, pool, MINT).equals(cpPoolVaultPda(pool, MINT, CPSWAP))).toBe(true);
    expect(deriveObservation(CPSWAP, pool).equals(cpObservationPda(pool, CPSWAP))).toBe(true);
  });
});

describe('error tables equal the IDLs, code for code', () => {
  it('launch program: 6000-6024, every code has plain-English copy', () => {
    const idl = launchIdl();
    expect(idl.errors).toHaveLength(25);
    for (const e of idl.errors) {
      expect((LAUNCH_ERROR_CODES as Record<number, string>)[e.code], `code ${e.code}`).toBe(e.name);
      const copy = LAUNCH_FAILURE_COPY[e.name as keyof typeof LAUNCH_FAILURE_COPY];
      expect(copy, e.name).toBeTruthy();
      expect(copy).not.toMatch(/\u2014/); // plain copy, no em dash
    }
  });
  it('cp-swap: 6000-6014, every code has plain-English copy', () => {
    const idl = cpIdl();
    expect(idl.errors).toHaveLength(15);
    for (const e of idl.errors) {
      expect((CP_SWAP_ERROR_CODES as Record<number, string>)[e.code], `code ${e.code}`).toBe(e.name);
      expect(CP_SWAP_ERROR_COPY[e.name as keyof typeof CP_SWAP_ERROR_COPY], e.name).toBeTruthy();
    }
  });
});
