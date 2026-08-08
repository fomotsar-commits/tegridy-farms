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
} from './ix';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CP_SWAP_PROGRAM_ID,
  IX_DISCRIMINATOR,
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

/** `[base58, isSigner, isWritable]` — the shape Anchor matches POSITIONALLY. */
const keyTable = (ix: TransactionInstruction) =>
  ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable] as const);

describe('buy', () => {
  const ix = buyIx({ trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT }, 5_000_000n, 42n);

  it('is addressed to the program and carries the buy discriminator', () => {
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.buy);
    expect(ix.data.length).toBe(8 + 8 + 8);
  });

  it('encodes both args little-endian, in order', () => {
    expect(u64At(ix, 8)).toBe(5_000_000n);
    expect(u64At(ix, 16)).toBe(42n);
  });

  it('lists all nine Trade accounts in declaration order with the right flags (lib.rs:1461-1500)', () => {
    expect(keyTable(ix)).toEqual([
      [TRADER.toBase58(), true, true],
      [globalPda().toBase58(), false, false],
      [FEE_RECIPIENT.toBase58(), false, true],
      [MINT.toBase58(), false, false],
      [curvePda(MINT).toBase58(), false, true],
      [curveVaultPda(MINT).toBase58(), false, true],
      [associatedTokenAddress(MINT, TRADER).toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
    ]);
  });

  it('accepts a non-ATA token account — the program does not require the ATA', () => {
    const other = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const custom = buyIx(
      { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT, traderTokenAccount: other },
      1n,
      1n,
    );
    expect(custom.keys[6]!.pubkey.equals(other)).toBe(true);
  });

  it('refuses an amount that cannot be encoded, rather than truncating it', () => {
    const accounts = { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT };
    expect(() => buyIx(accounts, U64_MAX + 1n, 0n)).toThrow(RangeError);
    expect(() => buyIx(accounts, -1n, 0n)).toThrow(RangeError);
    expect(() => buyIx(accounts, 0n, U64_MAX + 1n)).toThrow(RangeError);
    // u64::MAX itself is legal.
    expect(u64At(buyIx(accounts, U64_MAX, 0n), 8)).toBe(U64_MAX);
  });
});

describe('sell', () => {
  const accounts = { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT };
  const ix = sellIx(accounts, 1_000n, 7n);

  it('carries the sell discriminator and the same account list as buy', () => {
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.sell);
    expect(u64At(ix, 8)).toBe(1_000n);
    expect(u64At(ix, 16)).toBe(7n);
    expect(keyTable(ix)).toEqual(keyTable(buyIx(accounts, 1n, 1n)));
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

  it('lists the eight accounts in declaration order (lib.rs:1254-1314)', () => {
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
  const ix = migrateToAmmIx({ payer, launchMint: MINT, ammConfig, createPoolFee });

  it('takes no args and needs the compute limit raised', () => {
    expect(ix.data.length).toBe(8);
    expect(disc(ix)).toEqual(IX_DISCRIMINATOR.migrateToAmm);
    // 264,128 CU measured off the CI rehearsal; the default 200,000 does not fit.
    expect(MIGRATE_COMPUTE_UNITS).toBe(400_000);
    expect(MIGRATE_COMPUTE_UNITS).toBeGreaterThan(264_128);
  });

  it('lists all 23 accounts in declaration order (lib.rs:1323-1459)', () => {
    const migAuth = migrationAuthorityPda(MINT);
    const poolState = poolStatePda(MINT);
    const lpMint = cpLpMintPda(poolState);
    const [mint0, mint1] = sortMints(WSOL_MINT, MINT);

    expect(ix.keys.length).toBe(23);
    expect(keyTable(ix)).toEqual([
      [payer.toBase58(), true, true],
      [globalPda().toBase58(), false, false],
      [MINT.toBase58(), false, false],
      [curvePda(MINT).toBase58(), false, true],
      [curveVaultPda(MINT).toBase58(), false, true],
      [WSOL_MINT.toBase58(), false, false],
      [migAuth.toBase58(), false, true],
      [associatedTokenAddress(WSOL_MINT, migAuth).toBase58(), false, true],
      [associatedTokenAddress(MINT, migAuth).toBase58(), false, true],
      [associatedTokenAddress(lpMint, migAuth).toBase58(), false, true],
      [CP_SWAP_PROGRAM_ID.toBase58(), false, false],
      [ammConfig.toBase58(), false, false],
      [cpAmmAuthorityPda().toBase58(), false, false],
      [poolState.toBase58(), false, true],
      [lpMint.toBase58(), false, true],
      [cpPoolVaultPda(poolState, mint0).toBase58(), false, true],
      [cpPoolVaultPda(poolState, mint1).toBase58(), false, true],
      [createPoolFee.toBase58(), false, true],
      [cpObservationPda(poolState).toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
      [SYSVAR_RENT_PUBKEY.toBase58(), false, false],
    ]);
  });

  it('passes the vaults in cp-swap mint order, not argument order', () => {
    // Positions 15 and 16 are token_0_vault / token_1_vault. cp-swap constrains
    // token_0_mint < token_1_mint by raw bytes and reverts hard on the reverse.
    const poolState = poolStatePda(MINT);
    const [mint0, mint1] = sortMints(WSOL_MINT, MINT);
    expect(Buffer.compare(Buffer.from(mint0.toBytes()), Buffer.from(mint1.toBytes()))).toBeLessThan(0);
    expect(ix.keys[15]!.pubkey.equals(cpPoolVaultPda(poolState, mint0))).toBe(true);
    expect(ix.keys[16]!.pubkey.equals(cpPoolVaultPda(poolState, mint1))).toBe(true);
  });

  it('sorts even when the launch mint sorts BEFORE wsol — the case that reverts', () => {
    // WSOL's first byte is 6, so most mints happen to sort after it and a builder
    // that simply passed (wsol, launchMint) would look correct on almost every
    // fixture. This mint starts at 1, so the two orders genuinely differ.
    const lowMint = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    expect(sortMints(WSOL_MINT, lowMint)[0].equals(lowMint)).toBe(true);

    const low = migrateToAmmIx({ payer, launchMint: lowMint, ammConfig, createPoolFee });
    const poolState = poolStatePda(lowMint);
    expect(low.keys[15]!.pubkey.equals(cpPoolVaultPda(poolState, lowMint))).toBe(true);
    expect(low.keys[16]!.pubkey.equals(cpPoolVaultPda(poolState, WSOL_MINT))).toBe(true);
    // i.e. NOT the argument order.
    expect(low.keys[15]!.pubkey.equals(cpPoolVaultPda(poolState, WSOL_MINT))).toBe(false);
  });

  it('uses OUR pool_state, so a squatter on cp-swap canonical cannot redirect it', () => {
    expect(ix.keys[13]!.pubkey.equals(poolStatePda(MINT))).toBe(true);
    // And every cp-swap-side account hangs off it.
    expect(ix.keys[14]!.pubkey.equals(cpLpMintPda(poolStatePda(MINT)))).toBe(true);
    expect(ix.keys[18]!.pubkey.equals(cpObservationPda(poolStatePda(MINT)))).toBe(true);
  });

  it('never invents create_pool_fee — it is a hardcoded, fail-closed address in the fork', () => {
    expect(ix.keys[17]!.pubkey.equals(createPoolFee)).toBe(true);
    const other = migrateToAmmIx({
      payer,
      launchMint: MINT,
      ammConfig,
      createPoolFee: SYSTEM_PROGRAM_ID,
    });
    expect(other.keys[17]!.pubkey.equals(SYSTEM_PROGRAM_ID)).toBe(true);
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
});

describe('program-id override', () => {
  it('retargets every derived account', () => {
    const alt = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ix = buyIx(
      { trader: TRADER, mint: MINT, feeRecipient: FEE_RECIPIENT },
      1n,
      1n,
      { programId: alt },
    );
    expect(ix.programId.equals(alt)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(globalPda(alt))).toBe(true);
    expect(ix.keys[4]!.pubkey.equals(curvePda(MINT, alt))).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(globalPda())).toBe(false);
  });
});
