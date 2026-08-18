// @vitest-environment node
// Same reason as program.test.ts: PDA derivation under jsdom fails on a realm
// mismatch inside web3.js's sync sha256, not on anything in this code.
import { describe, it, expect } from 'vitest';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  MIGRATE_COMPUTE_UNITS,
  associatedTokenAddress,
  buyIx,
  createLaunchIx,
  CurveMode,
  initializeGlobalIx,
  migrateToAmmIx,
  sellIx,
  updateGlobalIx,
  setCurveSegmentsIx,
  createAmmConfigIx,
} from './ix';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CP_SWAP_PROGRAM_ID,
  IX_DISCRIMINATOR,
  CP_SWAP_IX_DISCRIMINATOR,
  cpAmmConfigPda,
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  cpAmmAuthorityPda,
  cpLpMintPda,
  cpObservationPda,
  cpPoolVaultPda,
  curvePda,
  curveVaultPda,
  globalPda,
  migrationAuthorityPda,
  poolStatePda,
  sortMints,
} from './program';
import { U64_MAX } from './math';

const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TRADER = new PublicKey('So11111111111111111111111111111111111111112');
const FEE_RECIPIENT = new PublicKey('SysvarRent111111111111111111111111111111111');

/** Read a little-endian u64 back out of instruction data. */
const u64At = (ix: TransactionInstruction, offset: number): bigint =>
  new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(offset, true);

const disc = (ix: TransactionInstruction): Uint8Array => Uint8Array.from(ix.data.subarray(0, 8));

const CREATOR = new PublicKey('Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7');

/** `[base58, isSigner, isWritable]` — the shape Anchor matches POSITIONALLY. */
const keyTable = (ix: TransactionInstruction) =>
  ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable] as const);

// ── the account lists, transcribed from the program's context structs ────────
//
// These are FIELD NAMES in declaration order, copied from
// `#[derive(Accounts)] pub struct Trade` and `pub struct MigrateToAmm` in
// tegridy-launch's lib.rs. They are the invariant; the builders' output is the
// thing under test.
//
// Counting was not enough, and that is not hypothetical: this file pinned NINE
// Trade accounts and TWENTY-THREE MigrateToAmm accounts — the numbers the encoder
// happened to emit — while the program declared ten and twenty-four. `creator` and
// `fee_recipient` were simply absent, every buy, sell and migration the repo could
// build reverted, and CI was green throughout because the assertion and the bug
// shared one source. Naming each slot means an omission moves a NAMED row rather
// than a total, so the failure says which account went missing.

const TRADE_ACCOUNTS = [
  'trader',
  'global',
  'fee_recipient',
  'mint',
  'curve',
  'creator',
  'curve_vault',
  'trader_token_account',
  'token_program',
  'system_program',
] as const;

const MIGRATE_ACCOUNTS = [
  'payer',
  'global',
  'fee_recipient',
  'launch_mint',
  'curve',
  'curve_vault',
  'wsol_mint',
  'migration_authority',
  'auth_wsol',
  'auth_token',
  'auth_lp',
  'cp_swap_program',
  'amm_config',
  'amm_authority',
  'pool_state',
  'lp_mint',
  'token_0_vault',
  'token_1_vault',
  'create_pool_fee',
  'observation_state',
  'token_program',
  'associated_token_program',
  'system_program',
  'rent',
] as const;

/**
 * Label each emitted account with the struct field it is standing in for, so a
 * comparison pins ORDER and NAME together: a builder that drops one account
 * relabels every account after it, and the diff names the first one that moved.
 */
function byName(
  ix: TransactionInstruction,
  names: readonly string[],
): Record<string, readonly [string, boolean, boolean]> {
  expect(ix.keys.length, `the program declares ${names.length} accounts`).toBe(names.length);
  const rows = keyTable(ix);
  return Object.fromEntries(names.map((n, i) => [n, rows[i]!]));
}

/** One named slot, for the assertions that care about a single account. */
const slot = (ix: TransactionInstruction, names: readonly string[], name: string) =>
  ix.keys[names.indexOf(name)]!.pubkey;

describe('buy', () => {
  const ix = buyIx(
    { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT, creator: CREATOR },
    5_000_000n,
    42n,
  );

  it('is addressed to the program and carries the buy discriminator', () => {
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.buy);
    expect(ix.data.length).toBe(8 + 8 + 8);
  });

  it('encodes both args little-endian, in order', () => {
    expect(u64At(ix, 8)).toBe(5_000_000n);
    expect(u64At(ix, 16)).toBe(42n);
  });

  it('fills every field of the Trade context, by name, in declaration order', () => {
    expect(byName(ix, TRADE_ACCOUNTS)).toEqual({
      trader: [TRADER.toBase58(), true, true],
      global: [globalPda().toBase58(), false, false],
      fee_recipient: [FEE_RECIPIENT.toBase58(), false, true],
      mint: [MINT.toBase58(), false, false],
      curve: [curvePda(MINT).toBase58(), false, true],
      creator: [CREATOR.toBase58(), false, true],
      curve_vault: [curveVaultPda(MINT).toBase58(), false, true],
      trader_token_account: [associatedTokenAddress(MINT, TRADER).toBase58(), false, true],
      token_program: [TOKEN_PROGRAM_ID.toBase58(), false, false],
      system_program: [SYSTEM_PROGRAM_ID.toBase58(), false, false],
    });
  });

  it('takes `creator` from the caller and never derives it', () => {
    // It is `curve.creator`, an address only a decoded curve can supply. A builder
    // that derived or defaulted it would revert with `CreatorMismatch` on every
    // launch it guessed wrong, and pay the wrong person on any it guessed right.
    const other = new PublicKey('BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL');
    const alt = buyIx(
      { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT, creator: other },
      1n,
      1n,
    );
    expect(slot(alt, TRADE_ACCOUNTS, 'creator').equals(other)).toBe(true);
    // …and it is distinct from the vault that used to occupy this slot.
    expect(slot(ix, TRADE_ACCOUNTS, 'creator').equals(curveVaultPda(MINT))).toBe(false);
  });

  it('accepts a non-ATA token account — the program does not require the ATA', () => {
    const other = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const custom = buyIx(
      {
        trader: TRADER,
        mint: MINT,
        feeRecipient: FEE_RECIPIENT,
        creator: CREATOR,
        traderTokenAccount: other,
      },
      1n,
      1n,
    );
    expect(slot(custom, TRADE_ACCOUNTS, 'trader_token_account').equals(other)).toBe(true);
  });

  it('refuses an amount that cannot be encoded, rather than truncating it', () => {
    const accounts = { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT, creator: CREATOR };
    expect(() => buyIx(accounts, U64_MAX + 1n, 0n)).toThrow(RangeError);
    expect(() => buyIx(accounts, -1n, 0n)).toThrow(RangeError);
    expect(() => buyIx(accounts, 0n, U64_MAX + 1n)).toThrow(RangeError);
    // u64::MAX itself is legal.
    expect(u64At(buyIx(accounts, U64_MAX, 0n), 8)).toBe(U64_MAX);
  });
});

describe('sell', () => {
  const accounts = { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT, creator: CREATOR };
  const ix = sellIx(accounts, 1_000n, 7n);

  it('carries the sell discriminator and the same account list as buy', () => {
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.sell);
    expect(u64At(ix, 8)).toBe(1_000n);
    expect(u64At(ix, 16)).toBe(7n);
    // Both handlers take `Context<Trade>`, so the lists cannot legally differ.
    expect(byName(ix, TRADE_ACCOUNTS)).toEqual(byName(buyIx(accounts, 1n, 1n), TRADE_ACCOUNTS));
  });

  it('is a DIFFERENT instruction from buy — the discriminator is the only thing separating them', () => {
    expect(disc(ix)).not.toEqual(IX_DISCRIMINATOR.buy);
  });
});

describe('create_launch', () => {
  const creator = TRADER;
  const ix = createLaunchIx({ creator, mint: MINT });

  // The client used to send only the discriminator, which was right until
  // `create_launch` gained `mode: u8`. An 8-byte payload against a handler
  // expecting 9 fails to deserialize — EVERY launch would have reverted.
  it('encodes the curve mode; every other term comes from global and is snapshotted', () => {
    expect(ix.data.length).toBe(9);
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.createLaunch);
    expect(ix.data[8]).toBe(CurveMode.ConstantProduct);
  });

  it('the mode byte actually changes with the argument', () => {
    const seg = createLaunchIx({ creator, mint: MINT }, CurveMode.Segmented);
    expect(seg.data[8]).toBe(1);
    expect(seg.data[8]).not.toBe(ix.data[8]);
  });

  it('rejects a mode that would not fit a u8 rather than truncating it', () => {
    // Truncation would silently select a DIFFERENT curve than the caller asked for.
    expect(() => createLaunchIx({ creator, mint: MINT }, 256 as never)).toThrow(RangeError);
    expect(() => createLaunchIx({ creator, mint: MINT }, -1 as never)).toThrow(RangeError);
  });

  it('lists the eight CreateLaunch accounts in declaration order', () => {
    expect(keyTable(ix)).toEqual([
      [creator.toBase58(), true, true],
      [globalPda().toBase58(), false, false],
      [MINT.toBase58(), false, true],
      [curvePda(MINT).toBase58(), false, true],
      [curveVaultPda(MINT).toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
      [SYSVAR_RENT_PUBKEY.toBase58(), false, false],
    ]);
  });
});

describe('migrate_to_amm', () => {
  const payer = TRADER;
  const ammConfig = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const createPoolFee = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const ix = migrateToAmmIx({
    payer,
    feeRecipient: FEE_RECIPIENT,
    launchMint: MINT,
    ammConfig,
    createPoolFee,
  });

  it('takes no args and needs the compute limit raised', () => {
    expect(ix.data.length).toBe(8);
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.migrateToAmm);
    // 264,128 CU measured off the CI rehearsal; the default 200,000 does not fit.
    expect(MIGRATE_COMPUTE_UNITS).toBe(400_000);
    expect(MIGRATE_COMPUTE_UNITS).toBeGreaterThan(264_128);
  });

  it('fills every field of the MigrateToAmm context, by name, in declaration order', () => {
    const migAuth = migrationAuthorityPda(MINT);
    const poolState = poolStatePda(MINT);
    const lpMint = cpLpMintPda(poolState);
    const [mint0, mint1] = sortMints(WSOL_MINT, MINT);

    expect(byName(ix, MIGRATE_ACCOUNTS)).toEqual({
      payer: [payer.toBase58(), true, true],
      global: [globalPda().toBase58(), false, false],
      fee_recipient: [FEE_RECIPIENT.toBase58(), false, true],
      launch_mint: [MINT.toBase58(), false, false],
      curve: [curvePda(MINT).toBase58(), false, true],
      curve_vault: [curveVaultPda(MINT).toBase58(), false, true],
      wsol_mint: [WSOL_MINT.toBase58(), false, false],
      migration_authority: [migAuth.toBase58(), false, true],
      auth_wsol: [associatedTokenAddress(WSOL_MINT, migAuth).toBase58(), false, true],
      auth_token: [associatedTokenAddress(MINT, migAuth).toBase58(), false, true],
      auth_lp: [associatedTokenAddress(lpMint, migAuth).toBase58(), false, true],
      cp_swap_program: [CP_SWAP_PROGRAM_ID.toBase58(), false, false],
      amm_config: [ammConfig.toBase58(), false, false],
      amm_authority: [cpAmmAuthorityPda().toBase58(), false, false],
      pool_state: [poolState.toBase58(), false, true],
      lp_mint: [lpMint.toBase58(), false, true],
      token_0_vault: [cpPoolVaultPda(poolState, mint0).toBase58(), false, true],
      token_1_vault: [cpPoolVaultPda(poolState, mint1).toBase58(), false, true],
      create_pool_fee: [createPoolFee.toBase58(), false, true],
      observation_state: [cpObservationPda(poolState).toBase58(), false, true],
      token_program: [TOKEN_PROGRAM_ID.toBase58(), false, false],
      associated_token_program: [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), false, false],
      system_program: [SYSTEM_PROGRAM_ID.toBase58(), false, false],
      rent: [SYSVAR_RENT_PUBKEY.toBase58(), false, false],
    });
  });

  it('takes `fee_recipient` from the caller and never derives it', () => {
    // It is `global.fee_recipient`, read off the decoded global. The program pins it
    // with an address constraint, so a derived or defaulted value fails ACCOUNT
    // VALIDATION — before the handler runs, which is why this builder could never
    // surface the AmmNotConfigured (6015) the ledger records as the real blocker.
    const other = new PublicKey('BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL');
    const alt = migrateToAmmIx({
      payer,
      feeRecipient: other,
      launchMint: MINT,
      ammConfig,
      createPoolFee,
    });
    expect(slot(alt, MIGRATE_ACCOUNTS, 'fee_recipient').equals(other)).toBe(true);
    // The mint used to land in this slot, which is the shift that broke the list.
    expect(slot(ix, MIGRATE_ACCOUNTS, 'fee_recipient').equals(MINT)).toBe(false);
  });

  it('passes the vaults in cp-swap mint order, not argument order', () => {
    // cp-swap constrains token_0_mint < token_1_mint by raw bytes and reverts hard
    // on the reverse.
    const poolState = poolStatePda(MINT);
    const [mint0, mint1] = sortMints(WSOL_MINT, MINT);
    expect(Buffer.compare(Buffer.from(mint0.toBytes()), Buffer.from(mint1.toBytes()))).toBeLessThan(0);
    expect(slot(ix, MIGRATE_ACCOUNTS, 'token_0_vault').equals(cpPoolVaultPda(poolState, mint0))).toBe(true);
    expect(slot(ix, MIGRATE_ACCOUNTS, 'token_1_vault').equals(cpPoolVaultPda(poolState, mint1))).toBe(true);
  });

  it('sorts even when the launch mint sorts BEFORE wsol — the case that reverts', () => {
    // WSOL's first byte is 6, so most mints happen to sort after it and a builder
    // that simply passed (wsol, launchMint) would look correct on almost every
    // fixture. This mint starts at 1, so the two orders genuinely differ.
    const lowMint = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    expect(sortMints(WSOL_MINT, lowMint)[0].equals(lowMint)).toBe(true);

    const low = migrateToAmmIx({
      payer,
      feeRecipient: FEE_RECIPIENT,
      launchMint: lowMint,
      ammConfig,
      createPoolFee,
    });
    const poolState = poolStatePda(lowMint);
    expect(slot(low, MIGRATE_ACCOUNTS, 'token_0_vault').equals(cpPoolVaultPda(poolState, lowMint))).toBe(true);
    expect(slot(low, MIGRATE_ACCOUNTS, 'token_1_vault').equals(cpPoolVaultPda(poolState, WSOL_MINT))).toBe(true);
    // i.e. NOT the argument order.
    expect(slot(low, MIGRATE_ACCOUNTS, 'token_0_vault').equals(cpPoolVaultPda(poolState, WSOL_MINT))).toBe(false);
  });

  it('uses OUR pool_state, so a squatter on cp-swap canonical cannot redirect it', () => {
    expect(slot(ix, MIGRATE_ACCOUNTS, 'pool_state').equals(poolStatePda(MINT))).toBe(true);
    // And every cp-swap-side account hangs off it.
    expect(slot(ix, MIGRATE_ACCOUNTS, 'lp_mint').equals(cpLpMintPda(poolStatePda(MINT)))).toBe(true);
    expect(
      slot(ix, MIGRATE_ACCOUNTS, 'observation_state').equals(cpObservationPda(poolStatePda(MINT))),
    ).toBe(true);
  });

  it('never invents create_pool_fee — it is a hardcoded, fail-closed address in the fork', () => {
    expect(slot(ix, MIGRATE_ACCOUNTS, 'create_pool_fee').equals(createPoolFee)).toBe(true);
    const other = migrateToAmmIx({
      payer,
      feeRecipient: FEE_RECIPIENT,
      launchMint: MINT,
      ammConfig,
      createPoolFee: SYSTEM_PROGRAM_ID,
    });
    expect(slot(other, MIGRATE_ACCOUNTS, 'create_pool_fee').equals(SYSTEM_PROGRAM_ID)).toBe(true);
  });
});

describe('associatedTokenAddress', () => {
  it('matches spl-token, including for a PDA owner (allowOwnerOffCurve)', () => {
    const migAuth = migrationAuthorityPda(MINT);
    expect(associatedTokenAddress(MINT, TRADER).equals(getAssociatedTokenAddressSync(MINT, TRADER))).toBe(true);
    // The migration authority is a PDA, so spl-token needs the flag; we always
    // behave as if it were passed, which is what migration requires.
    expect(
      associatedTokenAddress(WSOL_MINT, migAuth).equals(
        getAssociatedTokenAddressSync(WSOL_MINT, migAuth, true),
      ),
    ).toBe(true);
  });
});

describe('operator-only instructions', () => {
  const authority = TRADER;

  // Was "six u64s" and omitted `creator_fee_share_bps`, which the program takes as
  // its SECOND argument. Borsh is positional, so every field after `tradeFeeBps` was
  // landing one slot early: `initial_virtual_sol` would have been read as the creator
  // fee share, and so on down the line. Silent, total mis-configuration of the
  // protocol — not a revert. This is why the layout is asserted offset by offset.
  it('initialize_global encodes SEVEN u64s then two pubkeys, creatorFeeShareBps second', () => {
    const cpSwapProgram = CP_SWAP_PROGRAM_ID;
    const ammConfig = MINT;
    const ix = initializeGlobalIx(
      { authority, feeRecipient: FEE_RECIPIENT },
      {
        tradeFeeBps: 100n,
        creatorFeeShareBps: 4_800n,
        initialVirtualSol: 30_000_000_000n,
        initialVirtualToken: 1_073_000_000_000_000n,
        tokenTotalSupply: 1_000_000_000_000_000n,
        graduationTargetLamports: 85_000_000_000n,
        migrationReserveLamports: 250_000_000n,
        cpSwapProgram,
        ammConfig,
      },
    );
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.initializeGlobal);
    expect(ix.data.length).toBe(8 + 7 * 8 + 2 * 32);
    expect(u64At(ix, 8)).toBe(100n);                        // trade_fee_bps
    expect(u64At(ix, 16)).toBe(4_800n);                     // creator_fee_share_bps
    expect(u64At(ix, 24)).toBe(30_000_000_000n);            // initial_virtual_sol
    expect(u64At(ix, 32)).toBe(1_073_000_000_000_000n);     // initial_virtual_token
    expect(u64At(ix, 40)).toBe(1_000_000_000_000_000n);     // token_total_supply
    expect(u64At(ix, 48)).toBe(85_000_000_000n);            // graduation_target_lamports
    expect(u64At(ix, 56)).toBe(250_000_000n);               // migration_reserve_lamports
    expect(new PublicKey(ix.data.subarray(64, 96)).equals(cpSwapProgram)).toBe(true);
    expect(new PublicKey(ix.data.subarray(96, 128)).equals(ammConfig)).toBe(true);
    expect(keyTable(ix)).toEqual([
      [authority.toBase58(), true, true],
      [FEE_RECIPIENT.toBase58(), false, false],
      [globalPda().toBase58(), false, true],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
    ]);
  });

  // `update_global` takes TEN Options (lib.rs:467-476). This asserted NINE, which is
  // what the encoder wrote — test and encoder shared one wrong belief, so CI was
  // green while EVERY update_global reverted: a trailing Option that is never
  // written leaves the buffer one byte under the minimum and Borsh refuses it. That
  // silently blocked setting the AMM addresses and handing over authority.
  //
  // The count is the invariant, so it is stated once here and reused.
  const UPDATE_GLOBAL_OPTION_COUNT = 10;

  it('update_global writes one None byte per Option — all ten of them', () => {
    const ix = updateGlobalIx({ authority }, {});
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.updateGlobal);
    expect(ix.data.length).toBe(8 + UPDATE_GLOBAL_OPTION_COUNT);
    expect(Array.from(ix.data.subarray(8))).toEqual(
      new Array(UPDATE_GLOBAL_OPTION_COUNT).fill(0),
    );
    expect(keyTable(ix)).toEqual([
      [globalPda().toBase58(), false, true],
      [authority.toBase58(), true, false],
    ]);
  });

  it('update_global encodes EVERY field it accepts — no arg may be silently dropped', () => {
    // Set all ten, so a field present in UpdateGlobalArgs but missing from the
    // Writer chain changes the length and fails here. A None-only test cannot catch
    // that: it would just count one byte fewer and look self-consistent.
    const ix = updateGlobalIx(
      { authority },
      {
        tradeFeeBps: 100n,
        graduationTargetLamports: 11_621_942_308n,
        paused: false,
        newAuthority: MINT,
        newFeeRecipient: MINT,
        migrationReserveLamports: 250_000_000n,
        newCpSwapProgram: MINT,
        newAmmConfig: MINT,
        newInitialVirtualSol: 30_000_000_000n,
        newCreatorFeeShareBps: 4_800n,
      },
    );
    // tag+payload per field: u64 -> 9, bool -> 2, Pubkey -> 33.
    const SOME_U64 = 9;
    const SOME_BOOL = 2;
    const SOME_PUBKEY = 33;
    expect(ix.data.length).toBe(8 + 5 * SOME_U64 + SOME_BOOL + 4 * SOME_PUBKEY);
  });

  it('update_global puts creator_fee_share_bps LAST, after initial_virtual_sol', () => {
    // Order matters as much as presence: Borsh is positional, so encoding this
    // value in the wrong slot would reprice something else instead.
    const ix = updateGlobalIx({ authority }, { newCreatorFeeShareBps: 4_800n });
    // nine leading Nones, then Some(4800) as 1 tag byte + 8 LE bytes.
    expect(ix.data.length).toBe(8 + 9 + 1 + 8);
    expect(Array.from(ix.data.subarray(8, 17))).toEqual(new Array(9).fill(0));
    expect(ix.data[17]).toBe(1);
    const v = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    expect(v.getBigUint64(18, true)).toBe(4_800n);
  });

  it('update_global encodes Some in field order, and false is Some(false) not None', () => {
    // `paused: false` is a REAL instruction ("unpause"); collapsing it to None
    // would silently make the un-pause a no-op.
    const ix = updateGlobalIx({ authority }, { paused: false });
    expect(Array.from(ix.data.subarray(8, 13))).toEqual([0, 0, 1, 0, 0]);

    const both = updateGlobalIx({ authority }, { tradeFeeBps: 25n, paused: true });
    // Some(u64) = 1 + 8 bytes, then Option<u64> None, then Some(bool).
    expect(both.data[8]).toBe(1);
    expect(u64At(both, 9)).toBe(25n);
    expect(both.data[17]).toBe(0); // graduationTargetLamports: None
    expect(Array.from(both.data.subarray(18, 20))).toEqual([1, 1]); // Some(true)
  });

  it('update_global encodes an Option<Pubkey> as 1 + 32 bytes', () => {
    const ix = updateGlobalIx({ authority }, { newFeeRecipient: MINT });
    // trade_fee(1) grad_target(1) paused(1) new_authority(1) then Some + 32.
    expect(Array.from(ix.data.subarray(8, 12))).toEqual([0, 0, 0, 0]);
    expect(ix.data[12]).toBe(1);
    expect(new PublicKey(ix.data.subarray(13, 45)).equals(MINT)).toBe(true);
  });

  it('set_curve_segments puts AUTHORITY first — the reverse of update_global', () => {
    // Both are `has_one = authority`, but the structs declare the accounts in
    // OPPOSITE order (lib.rs:1613-1621 vs :1599-1607). Anchor matches POSITIONALLY,
    // so swapping them hands the program a Signer where it wants the config account
    // — a confusing deserialize failure rather than an obvious signer error.
    const seg = { sqrtPriceUpperX64: (1n << 65n) + 1n, liquidity: 1_000_000n };
    const set = setCurveSegmentsIx(
      { authority },
      { sqrtPriceStartX64: 1n << 64n, segments: [seg] },
    );
    expect(keyTable(set)).toEqual([
      [authority.toBase58(), true, false],
      [globalPda().toBase58(), false, true],
    ]);
    // ...and update_global is the other way round.
    expect(keyTable(updateGlobalIx({ authority }, { paused: true }))).toEqual([
      [globalPda().toBase58(), false, true],
      [authority.toBase58(), true, false],
    ]);
  });

  it('set_curve_segments encodes u128s and a u32 Vec prefix, little-endian', () => {
    const segs = [
      { sqrtPriceUpperX64: (1n << 70n) + 7n, liquidity: (1n << 65n) + 3n },
      { sqrtPriceUpperX64: (1n << 71n) + 9n, liquidity: (1n << 66n) + 5n },
    ];
    const ix = setCurveSegmentsIx(
      { authority },
      { sqrtPriceStartX64: (1n << 64n) + 1n, segments: segs },
    );
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.setCurveSegments);
    // 8 disc + 16 start + 4 Vec len + 32 per segment.
    expect(ix.data.length).toBe(8 + 16 + 4 + segs.length * 32);
    const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    const rd128 = (o: number) => view.getBigUint64(o, true) | (view.getBigUint64(o + 8, true) << 64n);
    // Every value here exceeds 2^53, so a Number-based encoder would round them.
    expect(rd128(8)).toBe((1n << 64n) + 1n);
    expect(view.getUint32(24, true)).toBe(2);
    segs.forEach((s, i) => {
      expect(rd128(28 + i * 32)).toBe(s.sqrtPriceUpperX64);
      expect(rd128(28 + i * 32 + 16)).toBe(s.liquidity);
    });
  });

  it('set_curve_segments refuses a value that does not fit a u128', () => {
    const tooBig = 2n ** 128n;
    expect(() =>
      setCurveSegmentsIx({ authority }, { sqrtPriceStartX64: tooBig, segments: [] }),
    ).toThrow(/sqrtPriceStartX64 must fit in a u128/);
    expect(() =>
      setCurveSegmentsIx(
        { authority },
        { sqrtPriceStartX64: 1n, segments: [{ sqrtPriceUpperX64: 1n, liquidity: tooBig }] },
      ),
    ).toThrow(/liquidity must fit in a u128/);
    // u128::MAX itself is legal at this layer; the PROGRAM rejects it on range.
    expect(() =>
      setCurveSegmentsIx({ authority }, { sqrtPriceStartX64: tooBig - 1n, segments: [] }),
    ).not.toThrow();
  });
});

describe('program-id override', () => {
  it('retargets every derived account', () => {
    const alt = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ix = buyIx(
      { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT, creator: CREATOR },
      1n,
      1n,
      { programId: alt },
    );
    expect(ix.programId.equals(alt)).toBe(true);
    expect(slot(ix, TRADE_ACCOUNTS, 'global').equals(globalPda(alt))).toBe(true);
    expect(slot(ix, TRADE_ACCOUNTS, 'curve').equals(curvePda(MINT, alt))).toBe(true);
    expect(slot(ix, TRADE_ACCOUNTS, 'global').equals(globalPda())).toBe(false);
  });
});

describe('cp-swap create_amm_config', () => {
  const owner = new PublicKey('Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7');
  const PARAMS = {
    index: 0,
    tradeFeeRate: 2_500n,
    protocolFeeRate: 120_000n,
    fundFeeRate: 0n,
    createPoolFee: 150_000_000n,
    creatorFeeRate: 0n,
  };

  it('is addressed to CP-SWAP, not tegridy-launch', () => {
    // Both programs derive discriminators the same way, so a mis-addressed
    // instruction finds no handler and fails obscurely rather than obviously.
    const ix = createAmmConfigIx({ owner }, PARAMS);
    expect(ix.programId.equals(CP_SWAP_PROGRAM_ID)).toBe(true);
    expect(ix.programId.equals(PROGRAM_ID)).toBe(false);
    expect(disc(ix)).toEqual(CP_SWAP_IX_DISCRIMINATOR.createAmmConfig);
  });

  it('owner is BOTH signer and writable — it pays the rent', () => {
    // `payer = owner` (create_config.rs:24). This is why the address must be
    // system-owned: a Squads multisig CONFIG account can neither sign nor be
    // debited, which is exactly what bricked the first mainnet deploy.
    const ix = createAmmConfigIx({ owner }, PARAMS);
    expect(keyTable(ix)).toEqual([
      [owner.toBase58(), true, true],
      [cpAmmConfigPda(PARAMS.index).toBase58(), false, true],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
    ]);
  });

  it('encodes index LITTLE-endian while the PDA seed uses BIG-endian', () => {
    // The same u16 is serialised two different ways in one instruction
    // (create_config.rs:20-22 vs the Borsh arg). 0x0102 makes them distinguishable.
    const ix = createAmmConfigIx({ owner }, { ...PARAMS, index: 0x0102 });
    expect(Array.from(ix.data.subarray(8, 10))).toEqual([0x02, 0x01]); // LE arg
    // and the account it targets is derived big-endian
    expect(ix.keys[1]!.pubkey.equals(cpAmmConfigPda(0x0102))).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(cpAmmConfigPda(0x0201))).toBe(false);
  });

  it('encodes the five rates in declaration order', () => {
    const ix = createAmmConfigIx({ owner }, PARAMS);
    expect(ix.data.length).toBe(8 + 2 + 5 * 8);
    expect(u64At(ix, 10)).toBe(2_500n); // trade_fee_rate
    expect(u64At(ix, 18)).toBe(120_000n); // protocol_fee_rate
    expect(u64At(ix, 26)).toBe(0n); // fund_fee_rate
    expect(u64At(ix, 34)).toBe(150_000_000n); // create_pool_fee
    expect(u64At(ix, 42)).toBe(0n); // creator_fee_rate
  });

  it('the recommended create_pool_fee sits under the migration-reserve ceiling', () => {
    // Not a program check — the program never validates this. The reserve is
    // snapshotted onto every curve at creation, so exceeding it makes every launch
    // made beforehand permanently unmigratable (state.rs:40-50).
    const MIGRATION_RESERVE = 250_000_000n;
    const MIN_MIGRATION_RESERVE = 42_156_720n;
    const ceiling = MIGRATION_RESERVE - MIN_MIGRATION_RESERVE;
    expect(ceiling).toBe(207_843_280n);
    expect(PARAMS.createPoolFee).toBeLessThanOrEqual(ceiling);
  });

  it('refuses an index outside u16 rather than wrapping it', () => {
    expect(() => createAmmConfigIx({ owner }, { ...PARAMS, index: 65_536 })).toThrow(RangeError);
    expect(() => createAmmConfigIx({ owner }, { ...PARAMS, index: -1 })).toThrow(RangeError);
  });
});
