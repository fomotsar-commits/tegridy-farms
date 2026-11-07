// @vitest-environment node
// PDA derivation under jsdom fails on a realm mismatch inside web3.js (see program.ts).
//
// EVERY ACCOUNT LIST THE WRITE PATH SENDS, HELD AGAINST THE PROGRAMS' OWN IDLs.
//
// The IDLs are the ones emitted with the exact mainnet binaries
// (C:\Users\jimbo\solana-launch-release-2026-09-26\artifacts), committed under
// solana/tegridy-amm/idl/ and pinned here by sha256 against that release's
// SHA256SUMS. One exception since 2026-10-06: the pool IDL also lists
// `create_lp_metadata`, which the source has and mainnet does not run yet (see SHA256
// below). The site sends no such instruction. For each instruction a transaction can carry we check, position by
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
import { associatedTokenAddress, migrateToAmmIx, sellIx } from '../curve/ix';
import {
  IX_DEPOSIT,
  IX_INITIALIZE,
  IX_WITHDRAW,
  deriveAuthority,
  deriveLpMint as cpDeriveLpMint,
  deriveObservation,
  derivePool as cpDerivePool,
  deriveVault,
  publicTierConfig,
} from '../../../solana/cpswap/program';
import {
  DEPOSIT_ACCOUNTS, INITIALIZE_ACCOUNTS, MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WITHDRAW_ACCOUNTS, depositIx, initializeIx, swapBaseInputIx, withdrawIx,
} from '../../../solana/cpswap/ix';
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

/**
 * `launch` and `cpswapRelease` are from the release's artifacts/SHA256SUMS: the IDLs of the
 * binaries mainnet runs. `cpswap` is the committed pool IDL, which is one instruction AHEAD of
 * that release: the source now has `create_lp_metadata` (it names a pool's share token), and
 * mainnet does not run it until the owner upgrades the pool program. The test below holds the
 * two together: take that one instruction out and the file is the release's, byte for byte.
 */
const SHA256 = {
  // The reserve-at-create build (artifacts/SHA256SUMS; d987fafe, the reserve-held build, is superseded).
  launch: 'cd9e173c666940f82222a2798dc1c5bc0cf30edf7b32450530e65aa523a3cb31',
  cpswap: '1e8fd7928c0fce6788b880703a1cbfc932e808ab5acadfd5217eb637d739f736',
  cpswapRelease: '939bc040fa0f65b6639f07545be9d23fde0492e9b5fc3d90229a313b0fcf0262',
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

describe('the committed IDLs are the pinned ones', () => {
  // Not a skip: a missing IDL means these guards are not running, and that must fail.
  it('both files exist', () => {
    expect(existsSync(LAUNCH_IDL_PATH), LAUNCH_IDL_PATH).toBe(true);
    expect(existsSync(CPSWAP_IDL_PATH), CPSWAP_IDL_PATH).toBe(true);
  });
  it('hash to their pins', () => {
    expect(createHash('sha256').update(load(LAUNCH_IDL_PATH).raw).digest('hex')).toBe(SHA256.launch);
    expect(createHash('sha256').update(load(CPSWAP_IDL_PATH).raw).digest('hex')).toBe(SHA256.cpswap);
  });
  it('the pool IDL is the release IDL plus create_lp_metadata, and nothing else', () => {
    const { idl } = load(CPSWAP_IDL_PATH);
    expect(idl.instructions.filter((i) => i.name === 'create_lp_metadata')).toHaveLength(1);
    // The IDL tool writes two-space JSON with no final newline, which is what this re-emits.
    const without = { ...idl, instructions: idl.instructions.filter((i) => i.name !== 'create_lp_metadata') };
    expect(createHash('sha256').update(JSON.stringify(without, null, 2)).digest('hex')).toBe(SHA256.cpswapRelease);
  });
  it('create_lp_metadata takes no argument and names nine accounts, with only the payer signing', () => {
    const ix = load(CPSWAP_IDL_PATH).idl.instructions.find((i) => i.name === 'create_lp_metadata');
    if (!ix) throw new Error('create_lp_metadata is not in the pool IDL');
    // No argument at all: a caller cannot hand the program a name, a symbol or a link.
    expect(ix.args).toEqual([]);
    expect(ix.discriminator).toEqual([...createHash('sha256').update('global:create_lp_metadata').digest().subarray(0, 8)]);
    expect(ix.accounts.map((a) => a.name)).toEqual([
      'payer', 'authority', 'pool_state', 'lp_mint', 'metadata', 'update_authority', 'metadata_program', 'system_program', 'rent',
    ]);
    expect(ix.accounts.filter((a) => a.signer).map((a) => a.name)).toEqual(['payer']);
    // Only the payer and the new record are written. The pool, its share mint and the
    // authority that also owns every vault are read-only.
    expect(ix.accounts.filter((a) => a.writable).map((a) => a.name)).toEqual(['payer', 'metadata']);
    const fixed = Object.fromEntries(ix.accounts.filter((a) => a.address).map((a) => [a.name, a.address]));
    expect(fixed).toEqual({
      // The record's editor is the vault, the address that signs for the multisig. Never the multisig account.
      update_authority: VAULT.toBase58(),
      metadata_program: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
      system_program: '11111111111111111111111111111111',
      rent: 'SysvarRent111111111111111111111111111111111',
    });
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
    VAULT,
  );

  it('is create account, init mint, metadata, create_launch, ATA, buy, then the plant (burn, Workshop), in that order', () => {
    expect(ixs.map((i) => i.programId.toBase58())).toEqual([
      SYSTEM_PROGRAM_ID.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
      LAUNCH.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      LAUNCH.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
    ]);
    // The plant is appended LAST, so every launch-program index above stays where it was.
    expect(ixs.slice(6).map((i) => i.data[0])).toEqual([15, 12]);
  });

  it('without an opening buy the plant follows create_launch directly', () => {
    const plain = createLaunchInstructions(
      gate,
      { creator: CREATOR, mint: MINT_KP, metadata: { name: 'Test', symbol: 'TST', uri: 'https://ipfs.io/ipfs/bafy' } },
      1_461_600,
      null,
      VAULT,
    );
    expect(plain.map((i) => i.programId.toBase58()).slice(3)).toEqual([LAUNCH.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
  });

  it('create_launch: 11 IDL accounts (the platform reserve paid to the treasury), then the launch index', () => {
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
      // The reserve's destination: global.fee_recipient and its token account for this mint.
      fee_recipient: VAULT,
      treasury_token: associatedTokenAddress(MINT, VAULT),
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    }, LAUNCH);
    expect(ixOf(launchIdl(), 'create_launch').accounts).toHaveLength(11);
    expect(ix.keys).toHaveLength(12);
    expect(ix.keys[11]).toEqual({ pubkey: launchIndexAddress(LAUNCH), isSigner: false, isWritable: false });
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

describe('sell and migrate match the IDL, and nothing is left to release', () => {
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

  it('the program has no release_platform_reserve: the reserve is paid inside create_launch', () => {
    expect(launchIdl().instructions.map((i) => i.name).sort()).toEqual(
      ['buy', 'create_launch', 'initialize_global', 'migrate_to_amm', 'sell', 'update_global'],
    );
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

describe('cp-swap deposit and withdraw match the committed mainnet IDL', () => {
  // Deposit and withdraw have never run on the mainnet binary from this site; until
  // now only ix.test.ts held them, and it reads the Rust source. These hold them to
  // the release's own IDL: the account list as data (name, order, flags), the built
  // instruction position by position, the discriminators, and where each argument sits.
  const lpAccounts = (spec: IdlIx) => spec.accounts.map((a) => [a.name, !!a.signer, !!a.writable]);
  const lpPool = poolStatePda(MINT, LAUNCH);
  const [lpM0, lpM1] = sortMints(WSOL_MINT, MINT);
  const lpMint = cpLpMintPda(lpPool, CPSWAP);
  const lpCommon = {
    programId: CPSWAP, owner: TRADER, poolState: lpPool, ownerLpToken: associatedTokenAddress(lpMint, TRADER),
    token0Account: associatedTokenAddress(lpM0, TRADER), token1Account: associatedTokenAddress(lpM1, TRADER),
    token0Vault: deriveVault(CPSWAP, lpPool, lpM0), token1Vault: deriveVault(CPSWAP, lpPool, lpM1),
    vault0Mint: lpM0, vault1Mint: lpM1, lpMint, lpTokenAmount: 11n,
  };
  const lpByName: Record<string, PublicKey> = {
    owner: TRADER, authority: deriveAuthority(CPSWAP), pool_state: lpPool, owner_lp_token: lpCommon.ownerLpToken,
    token_0_account: lpCommon.token0Account, token_1_account: lpCommon.token1Account,
    token_0_vault: lpCommon.token0Vault, token_1_vault: lpCommon.token1Vault,
    token_program: TOKEN_PROGRAM_ID, token_program_2022: TOKEN_2022_PROGRAM_ID,
    vault_0_mint: lpM0, vault_1_mint: lpM1, lp_mint: lpMint, memo_program: MEMO_PROGRAM_ID,
  };

  it('deposit matches the committed mainnet IDL: 13 accounts, discriminator, three u64 args at 8, 16 and 24', () => {
    const spec = ixOf(cpIdl(), 'deposit');
    expect(spec.accounts).toHaveLength(13);
    expect(DEPOSIT_ACCOUNTS.map((a) => [a.name, a.s, a.w])).toEqual(lpAccounts(spec));
    expect(Array.from(IX_DEPOSIT)).toEqual(spec.discriminator);
    expect(spec.args.map((a) => [a.name, a.type])).toEqual([
      ['lp_token_amount', 'u64'], ['maximum_token_0_amount', 'u64'], ['maximum_token_1_amount', 'u64'],
    ]);
    const ix = depositIx({ ...lpCommon, maximumToken0Amount: 22n, maximumToken1Amount: 33n });
    expect(ix.keys).toHaveLength(13);
    assertParity(ix, spec, lpByName, CPSWAP);
    expect(ix.data.length).toBe(32);
    expect([u64At(ix.data, 8), u64At(ix.data, 16), u64At(ix.data, 24)]).toEqual([11n, 22n, 33n]);
  });

  it('withdraw matches the committed mainnet IDL: 14 accounts (the memo program last), discriminator, three u64 args', () => {
    const spec = ixOf(cpIdl(), 'withdraw');
    expect(spec.accounts).toHaveLength(14);
    expect(WITHDRAW_ACCOUNTS.map((a) => [a.name, a.s, a.w])).toEqual(lpAccounts(spec));
    expect(Array.from(IX_WITHDRAW)).toEqual(spec.discriminator);
    expect(spec.args.map((a) => [a.name, a.type])).toEqual([
      ['lp_token_amount', 'u64'], ['minimum_token_0_amount', 'u64'], ['minimum_token_1_amount', 'u64'],
    ]);
    const ix = withdrawIx({ ...lpCommon, minimumToken0Amount: 22n, minimumToken1Amount: 33n });
    expect(ix.keys).toHaveLength(14);
    assertParity(ix, spec, lpByName, CPSWAP);
    expect(ix.data.length).toBe(32);
    expect([u64At(ix.data, 8), u64At(ix.data, 16), u64At(ix.data, 24)]).toEqual([11n, 22n, 33n]);
  });
});

describe('cp-swap initialize matches the committed mainnet IDL', () => {
  // Opening a pool from this site (lp-create). The decoder pins all 20 slots by name and
  // order (intent.ts poolInitialize), so the list it pins is held to the release's IDL.
  const flags = (spec: IdlIx) => spec.accounts.map((a) => [a.name, !!a.signer, !!a.writable]);
  const tier1 = publicTierConfig(CPSWAP);
  const [t0, t1] = sortMints(WSOL_MINT, MINT);

  it('20 accounts by name, order and flags, the discriminator, and init_amount_0, init_amount_1, open_time', () => {
    const spec = ixOf(cpIdl(), 'initialize');
    expect(spec.accounts).toHaveLength(20);
    expect(INITIALIZE_ACCOUNTS.map((a) => [a.name, a.s, a.w])).toEqual(flags(spec));
    expect(Array.from(IX_INITIALIZE)).toEqual(spec.discriminator);
    expect(spec.args.map((a) => [a.name, a.type])).toEqual([['init_amount_0', 'u64'], ['init_amount_1', 'u64'], ['open_time', 'u64']]);
  });

  it('the opening the site builds, at the standard address, position by position', () => {
    const spec = ixOf(cpIdl(), 'initialize');
    const pool = cpDerivePool(CPSWAP, tier1, t0, t1);
    const lpMint = cpDeriveLpMint(CPSWAP, pool);
    const byName: Record<string, PublicKey> = {
      creator: TRADER, amm_config: tier1, authority: deriveAuthority(CPSWAP), pool_state: pool,
      token_0_mint: t0, token_1_mint: t1, lp_mint: lpMint,
      creator_token_0: associatedTokenAddress(t0, TRADER), creator_token_1: associatedTokenAddress(t1, TRADER),
      creator_lp_token: associatedTokenAddress(lpMint, TRADER),
      token_0_vault: deriveVault(CPSWAP, pool, t0), token_1_vault: deriveVault(CPSWAP, pool, t1),
      create_pool_fee: CP_CREATE_POOL_FEE_RECEIVER, observation_state: deriveObservation(CPSWAP, pool),
      token_program: TOKEN_PROGRAM_ID, token_0_program: TOKEN_PROGRAM_ID, token_1_program: TOKEN_PROGRAM_ID,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: SYSTEM_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    };
    const ix = initializeIx({
      programId: CPSWAP, creator: TRADER, ammConfig: tier1, token0Mint: t0, token1Mint: t1,
      creatorToken0: byName.creator_token_0!, creatorToken1: byName.creator_token_1!, creatorLpToken: byName.creator_lp_token!,
      token0Program: TOKEN_PROGRAM_ID, token1Program: TOKEN_PROGRAM_ID, createPoolFee: CP_CREATE_POOL_FEE_RECEIVER,
      initAmount0: 11n, initAmount1: 22n, openTime: 0n,
    });
    expect(ix.keys).toHaveLength(20);
    assertParity(ix, spec, byName, CPSWAP);
    expect(ix.data.length).toBe(32);
    expect([u64At(ix.data, 8), u64At(ix.data, 16), u64At(ix.data, 24)]).toEqual([11n, 22n, 0n]);
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
