// Instruction builders for `tegridy-launch`.
//
// Hand-encoded, because there is no committed IDL and `[features] seeds = false`
// means Anchor's JS client could not auto-derive an address even if there were
// one (see `program.ts`). Every account is supplied explicitly, in DECLARATION
// order — Anchor matches by position, not by name, so a reordered list produces a
// confusing constraint failure rather than an obvious one.
//
// These builders are PURE: they open no connection, sign nothing, and send
// nothing. They return `TransactionInstruction`s a caller adds to a transaction.
// Same doctrine as `dbc.ts` — the param layer and the signing layer stay apart.
//
// ⛔ NOTHING BUILT HERE CAN EXECUTE TODAY. Every instruction below is addressed to
// `PROGRAM_ID` or `CP_SWAP_PROGRAM_ID`, and both of those ids were closed on mainnet
// 2026-08-13 (ProgramData deleted, verified on two RPCs —
// docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md). A closed upgradeable program id cannot
// be redeployed, so a restart means NEW ids from fresh keypairs and new `declare_id!`
// values, and every address in this file moves with them.
//
// This header has carried both wrong answers in turn — an absent-program banner for
// four days after the 2026-08-08 deploy, then a sendable-on-mainnet banner for nine
// days after the close. Neither the builders nor a comment can settle it, and
// `readDeployment` in `read.ts` cannot either on its own: a closed program's stub
// stays executable-flagged, so it answers `deployed` for both spent ids (see
// `program.ts`). What these builders encode is the program's instruction FORMAT, a
// property of the SOURCE, worth keeping correct for whatever is deployed next.
//
// `migrateToAmmIx` additionally requires `global.cp_swap_program` and
// `global.amm_config` to be set; while they are zero, `migrate_to_amm` fails
// AmmNotConfigured (6015) no matter how well-formed the transaction is. That was never
// cleared before the close, so graduation never ran once.

// `Buffer` is imported explicitly rather than taken off `globalThis`: the browser
// only has it once `solanaPolyfill.ts` has run, and this module must not depend
// on an import-order side effect it cannot see. (web3.js types
// `TransactionInstruction.data` as `Buffer`.)
import { Buffer } from 'buffer';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CP_SWAP_PROGRAM_ID,
  IX_DISCRIMINATOR,
  CP_SWAP_IX_DISCRIMINATOR,
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_PUBKEY,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  cpAmmAuthorityPda,
  cpAmmConfigPda,
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
} from './program';
import { U64_MAX, isU64 } from './math';

/**
 * `migrate_to_amm` measured at **264,128 CU** off the confirmed CI rehearsal
 * (MIGRATE_DESIGN.md:220-239). Solana's default is 200,000 per instruction, so it
 * does not fit: a caller MUST prepend
 * `ComputeBudgetProgram.setComputeUnitLimit({ units: MIGRATE_COMPUTE_UNITS })`.
 * Omit it and the transaction fails with `Program failed to complete`, which
 * reads like a program bug and has already cost one debugging cycle here.
 *
 * 400,000 is the value CI uses (tests/tegridy-launch-migration.test.ts:425).
 *
 * `buy` and `sell` CU cost is UNMEASURED — no test in the repo measures it. There
 * is deliberately no constant for them: a made-up number in a file like this one
 * gets quoted back as fact.
 */
export const MIGRATE_COMPUTE_UNITS = 400_000;

// ── encoding ─────────────────────────────────────────────────────────────────

/**
 * Args are Borsh: little-endian, appended after the 8-byte discriminator.
 * `u64` → 8 bytes LE · `Pubkey` → 32 raw bytes · `bool` → 1 byte ·
 * `Option<T>` → `0x00` for `None`, `0x01` then `T` for `Some`.
 */
class Writer {
  private readonly bytes: number[] = [];

  disc(d: Uint8Array): this {
    this.bytes.push(...d);
    return this;
  }

  u64(v: bigint, label: string): this {
    if (!isU64(v)) throw new RangeError(`${label} must fit in a u64 (0..${U64_MAX}), got ${v}`);
    for (let i = 0n; i < 8n; i++) this.bytes.push(Number((v >> (8n * i)) & 0xffn));
    return this;
  }

  pubkey(k: PublicKey): this {
    this.bytes.push(...k.toBytes());
    return this;
  }

  /** Borsh `u16`, little-endian. NOTE the AmmConfig PDA seed uses BIG-endian for
   *  the same value — the instruction arg and the seed disagree on purpose
   *  (cp-swap `create_config.rs:20-22`), so they are encoded by different helpers. */
  u16(v: number, label: string): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff_ff) {
      throw new RangeError(`${label} must be an integer in 0..65535, got ${v}`);
    }
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }

  bool(v: boolean): this {
    this.bytes.push(v ? 1 : 0);
    return this;
  }

  /** `Option<u64>` — `undefined` and `null` both mean `None` ("leave unchanged"). */
  optU64(v: bigint | null | undefined, label: string): this {
    if (v === null || v === undefined) return this.bool(false);
    return this.bool(true).u64(v, label);
  }

  optPubkey(v: PublicKey | null | undefined): this {
    if (!v) return this.bool(false);
    return this.bool(true).pubkey(v);
  }

  optBool(v: boolean | null | undefined): this {
    if (v === null || v === undefined) return this.bool(false);
    return this.bool(true).bool(v);
  }

  finish(): Buffer {
    return Buffer.from(this.bytes);
  }
}

/**
 * Associated Token Account address, derived directly rather than via
 * `@solana/spl-token`.
 *
 * This is the `allowOwnerOffCurve = true` behaviour unconditionally, which is
 * what migration needs: `auth_wsol` / `auth_token` / `auth_lp` are owned by the
 * `migration_authority` PDA, and spl-token's helper throws for an off-curve owner
 * unless that flag is passed (tests/tegridy-launch-migration.test.ts:434-436).
 */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Shorthand for the account-meta lists below. */
const acc = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
  pubkey,
  isSigner,
  isWritable,
});

/** Optional program-id overrides, for a devnet deploy or a future real id. */
export interface ProgramIds {
  programId?: PublicKey;
  cpSwapProgram?: PublicKey;
}

// ── buy / sell (the `Trade` context struct in lib.rs) ────────────────────────
//
// Line citations are deliberately absent: the previous ones pointed ~390 lines
// short of the struct in a 1,900-line file, so an engineer checking this list
// against them confirmed nothing. Name the symbol; a symbol survives an edit.

export interface TradeAccounts {
  trader: PublicKey;
  mint: PublicKey;
  /** MUST equal `global.fee_recipient` — read it, do not assume it. */
  feeRecipient: PublicKey;
  /**
   * MUST equal `curve.creator` — the address `create_launch` recorded, read off the
   * DECODED CURVE and never derived or guessed. It takes the creator's share of the
   * trade fee on every buy and sell, and the program pins it (`address =
   * curve.creator`), so a wrong value reverts with `CreatorMismatch` rather than
   * paying the wrong person.
   */
  creator: PublicKey;
  /**
   * Any token account of `mint` the trader owns; the program does NOT require the
   * ATA. Use the ATA and CREATE IT YOURSELF FIRST — nothing in `buy` creates it.
   * Defaults to `associatedTokenAddress(mint, trader)`.
   */
  traderTokenAccount?: PublicKey;
}

/**
 * The ten `Trade` accounts, in declaration order.
 *
 * `creator` was missing, so every buy and sell this module could build carried nine
 * accounts for ten declared fields. Anchor matches POSITIONALLY, so `curve_vault`
 * arrived in the `creator` slot and the transaction reverted — `CreatorMismatch`, or
 * `NotEnoughAccountKeys` if the trailing shift was caught first. Nothing failed in
 * CI because the test pinned the count the encoder produced instead of the count the
 * program declares.
 */
function tradeKeys(a: TradeAccounts, programId: PublicKey) {
  return [
    acc(a.trader, true, true),
    acc(globalPda(programId), false, false),
    acc(a.feeRecipient, false, true),
    acc(a.mint, false, false),
    acc(curvePda(a.mint, programId), false, true),
    acc(a.creator, false, true),
    acc(curveVaultPda(a.mint, programId), false, true),
    acc(a.traderTokenAccount ?? associatedTokenAddress(a.mint, a.trader), false, true),
    acc(TOKEN_PROGRAM_ID, false, false),
    acc(SYSTEM_PROGRAM_ID, false, false),
  ];
}

/**
 * `buy(max_lamports_in, min_tokens_out)`.
 *
 * ⚠ `maxLamportsIn` is a CEILING, not a spend. A buy that would carry the curve
 * past `graduation_target + migration_reserve` is capped there and the remainder
 * is never taken; there is no refund transfer (lib.rs:466-480). Show the user the
 * CAPPED debit from `quoteBuyOnCurve(...).lamportsIn`, not this argument.
 *
 * `minTokensOut` is required, not defaulted. A quote is computed from an account
 * snapshot and is stale on arrival, so a user surface must always send a real
 * slippage floor — the on-chain tests pass 0 only because they are tests.
 */
export function buyIx(
  accounts: TradeAccounts,
  maxLamportsIn: bigint,
  minTokensOut: bigint,
  ids: ProgramIds = {},
): TransactionInstruction {
  const programId = ids.programId ?? PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: tradeKeys(accounts, programId),
    data: new Writer()
      .disc(IX_DISCRIMINATOR.buy)
      .u64(maxLamportsIn, 'maxLamportsIn')
      .u64(minTokensOut, 'minTokensOut')
      .finish(),
  });
}

/**
 * `sell(tokens_in, min_lamports_out)`.
 *
 * Deliberately NOT gated on `global.paused`: a pause stops new
 * money entering and must never trap holders. A paused UI must keep this
 * available and say so.
 */
export function sellIx(
  accounts: TradeAccounts,
  tokensIn: bigint,
  minLamportsOut: bigint,
  ids: ProgramIds = {},
): TransactionInstruction {
  const programId = ids.programId ?? PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: tradeKeys(accounts, programId),
    data: new Writer()
      .disc(IX_DISCRIMINATOR.sell)
      .u64(tokensIn, 'tokensIn')
      .u64(minLamportsOut, 'minLamportsOut')
      .finish(),
  });
}

// ── create_launch (the `CreateLaunch` context struct in lib.rs) ──────────────

/**
 * `create_launch()` — no args. Supply, virtual reserves, fee, target and reserve
 * are all read from `global` and SNAPSHOTTED onto the curve (lib.rs:426-432).
 *
 * The caller must have created `mint` FIRST with:
 *   • `mintAuthority = creator` — this instruction mints the supply and then
 *     permanently revokes it (lib.rs:395-421);
 *   • `supply = 0`;
 *   • **`freezeAuthority = null`** — a retained freeze authority can freeze
 *     `curve_vault`, whose address is publicly derivable from creation, and lock
 *     100% of raised SOL forever. Rejected with `MintHasFreezeAuthority` (6011);
 *     the full argument is at lib.rs:1265-1282 and a create UI should say why.
 *   • the LEGACY token program. Token-2022 is not supported anywhere in the
 *     program and will fail account validation.
 *
 * Decimals are NOT constrained by the program. Read them off the mint; never
 * assume 9.
 *
 * The payload is the bare 8-byte discriminator. It briefly carried a trailing
 * `mode: u8` selecting constant-product or the segmented curve; segmented mode is
 * gone and so is the byte, and a 9-byte payload against the reworked handler fails
 * to deserialize just as an 8-byte one did against the old.
 */
export function createLaunchIx(
  accounts: { creator: PublicKey; mint: PublicKey },
  ids: ProgramIds = {},
): TransactionInstruction {
  const programId = ids.programId ?? PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      acc(accounts.creator, true, true),
      acc(globalPda(programId), false, false),
      acc(accounts.mint, false, true),
      acc(curvePda(accounts.mint, programId), false, true),
      acc(curveVaultPda(accounts.mint, programId), false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
      acc(SYSTEM_PROGRAM_ID, false, false),
      acc(SYSVAR_RENT_PUBKEY, false, false),
    ],
    data: new Writer().disc(IX_DISCRIMINATOR.createLaunch).finish(),
  });
}

// ── migrate_to_amm (the `MigrateToAmm` context struct in lib.rs) ─────────────

export interface MigrateAccounts {
  /** Funds rent along the way and is fully reimbursed by the sweep. */
  payer: PublicKey;
  /**
   * MUST equal `curve.creator`, read off the DECODED CURVE — same doctrine and same
   * failure as {@link TradeAccounts.creator}. It is handed through to cp-swap as the
   * graduated pool's `creator`, which is who its creator-fee stream pays, so a
   * derived or defaulted value either reverts on the address constraint or hands a
   * launch's pool income to a stranger for the life of the pool.
   */
  creator: PublicKey;
  /**
   * MUST equal `global.fee_recipient` — read it off the decoded global, never
   * derived and never defaulted. It receives the unspent migration reserve, and the
   * program pins it (`address = global.fee_recipient`), so a wrong value fails
   * ACCOUNT VALIDATION with `Unauthorized` (6008) before the handler ever runs.
   */
  feeRecipient: PublicKey;
  launchMint: PublicKey;
  /** `global.amm_config`. Read it; it is not derivable and may be unset. */
  ammConfig: PublicKey;
  /**
   * cp-swap's `create_pool_fee_reveiver::ID` — a **WSOL TOKEN ACCOUNT**, not a
   * wallet (cp-swap/src/lib.rs:57-68). It is a hardcoded address in the fork and
   * is a fail-closed sentinel in the non-devnet build, so a caller must supply
   * the real one rather than have this module invent it.
   */
  createPoolFee: PublicKey;
  /**
   * cp-swap's `permission` PDA, defaulting to
   * `cpPermissionPda(migrationAuthorityPda(launchMint))`.
   *
   * The override exists because the default is an INFERENCE — see
   * `POST_REMOVAL_PROGRAM.UNVERIFIED`. `initialize_with_permission` seeds the
   * account from its own `payer`, and the migration authority is what fronts the
   * pool rent today; if the reworked program pays from something else, the address
   * moves and this field is how an operator supplies the real one without waiting
   * on a code change.
   *
   * Either way the account must already EXIST — only cp-swap's compile-time admin
   * can create one (`create_permission_pda.rs:10`), so migration is blocked until
   * they have, exactly as it is blocked by the missing AmmConfig.
   */
  permission?: PublicKey;
}

/**
 * `migrate_to_amm()` — no args, permissionless by design: no caller-chosen
 * parameters, pays the caller nothing, exactly one legal outcome.
 *
 * All TWENTY-SIX accounts, in declaration order. `fee_recipient` (index 2) was once
 * missing, which shifted the remaining 21 by one: `launch_mint` landed in the
 * `fee_recipient` slot and every build reverted at account validation with
 * `Unauthorized` (6008). Note the diagnostic cost — validation runs before the
 * handler, so this builder could never produce the `AmmNotConfigured` (6015) the
 * operator ledger records as migration's blocker, and anyone debugging graduation
 * with it chased the wrong error.
 *
 * `creator` and `permission` are the two the post-removal program added, and their
 * POSITIONS are inferred rather than read — `POST_REMOVAL_PROGRAM.UNVERIFIED` names
 * both. A position that is wrong here reverts the same silent, shifted way
 * `fee_recipient` did, so re-check them against `MigrateToAmm` before a real
 * graduation is attempted.
 *
 * The caller MUST prepend `setComputeUnitLimit({ units: MIGRATE_COMPUTE_UNITS })`.
 *
 * Preconditions worth checking before offering the button (all read-only, see
 * `phase.ts`): not paused · the AMM configured · `!curve.complete` ·
 * `real_sol_reserves >= graduation_target` · and the binding one,
 * `curveLamports - rentExempt >= target + reserve`, which reads the PDA's ACTUAL
 * lamport balance, not `real_sol_reserves`.
 *
 * A failure is RETRYABLE, not a broken launch: on an exactly-funded curve a
 * 1-lamport `sell` front-run makes migration revert until someone buys again, and
 * `sell` is unpausable by design (MIGRATE_DESIGN.md:294-304).
 */
export function migrateToAmmIx(
  accounts: MigrateAccounts,
  ids: ProgramIds = {},
): TransactionInstruction {
  const programId = ids.programId ?? PROGRAM_ID;
  const cpSwapProgram = ids.cpSwapProgram ?? CP_SWAP_PROGRAM_ID;
  const { launchMint } = accounts;

  const migrationAuthority = migrationAuthorityPda(launchMint, programId);
  // OURS, not cp-swap's canonical derivation — see LAUNCH_POOL_SEED.
  const poolState = poolStatePda(launchMint, programId);
  const lpMint = cpLpMintPda(poolState, cpSwapProgram);
  // cp-swap constrains token_0_mint < token_1_mint by RAW BYTES; backwards reverts.
  const [mint0, mint1] = sortMints(WSOL_MINT, launchMint);

  return new TransactionInstruction({
    programId,
    keys: [
      acc(accounts.payer, true, true),
      acc(globalPda(programId), false, false),
      acc(accounts.feeRecipient, false, true),
      acc(launchMint, false, false),
      acc(curvePda(launchMint, programId), false, true),
      acc(curveVaultPda(launchMint, programId), false, true),
      acc(WSOL_MINT, false, false),
      // Position 8, AFTER wsol_mint — transcribed from the program's MigrateToAmm
      // context, not inferred from Trade's ordering. Read-only: the constraint is
      // `address = curve.creator` with no `mut`, so the account is proof of identity
      // for the pool's creator field and never a payee here.
      acc(accounts.creator, false, false),
      acc(migrationAuthority, false, true),
      acc(associatedTokenAddress(WSOL_MINT, migrationAuthority), false, true),
      acc(associatedTokenAddress(launchMint, migrationAuthority), false, true),
      acc(associatedTokenAddress(lpMint, migrationAuthority), false, true),
      acc(cpSwapProgram, false, false),
      acc(accounts.ammConfig, false, false),
      // Position 15, between amm_config and amm_authority — the program's own
      // ordering, which is NOT where cp-swap places it in InitializeWithPermission.
      // Mirroring the CPI callee instead of the caller's context would shift every
      // account from here down by one and fail the whole graduation.
      acc(accounts.permission ?? cpPermissionPda(migrationAuthority, cpSwapProgram), false, false),
      acc(cpAmmAuthorityPda(cpSwapProgram), false, false),
      acc(poolState, false, true),
      acc(lpMint, false, true),
      acc(cpPoolVaultPda(poolState, mint0, cpSwapProgram), false, true),
      acc(cpPoolVaultPda(poolState, mint1, cpSwapProgram), false, true),
      acc(accounts.createPoolFee, false, true),
      acc(cpObservationPda(poolState, cpSwapProgram), false, true),
      acc(TOKEN_PROGRAM_ID, false, false),
      acc(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      acc(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: new Writer().disc(IX_DISCRIMINATOR.migrateToAmm).finish(),
  });
}

// ── operator-only (lib.rs:1222-1252) ─────────────────────────────────────────
//
// Neither of these belongs on a user-facing surface. They are here because there
// is no IDL, so an operator runbook has nowhere else to get the encoding from.

/**
 * `initialize_global(...)` — one-time protocol setup, lib.rs:189-197.
 *
 * `authority` must equal `deployer::ID`. In a NON-DEVNET build that is
 * `11111111111111111111111111111111`, the System Program sentinel (lib.rs:128-129),
 * which nobody can sign for — so this cannot succeed at all until an operator sets
 * a real key and rebuilds. That is also why `global` may legitimately be absent
 * after a deploy.
 */
export function initializeGlobalIx(
  accounts: { authority: PublicKey; feeRecipient: PublicKey },
  args: {
    tradeFeeBps: bigint;
    /**
     * The creator's share OF THE TRADE FEE, in bps of the fee. SECOND argument,
     * not last — Borsh is positional, so its place in this object is irrelevant
     * but its place in the Writer chain below is everything.
     */
    creatorFeeShareBps: bigint;
    initialVirtualSol: bigint;
    initialVirtualToken: bigint;
    tokenTotalSupply: bigint;
    graduationTargetLamports: bigint;
    migrationReserveLamports: bigint;
    cpSwapProgram: PublicKey;
    ammConfig: PublicKey;
  },
  ids: ProgramIds = {},
): TransactionInstruction {
  const programId = ids.programId ?? PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      acc(accounts.authority, true, true),
      acc(accounts.feeRecipient, false, false),
      acc(globalPda(programId), false, true),
      acc(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: new Writer()
      .disc(IX_DISCRIMINATOR.initializeGlobal)
      .u64(args.tradeFeeBps, 'tradeFeeBps')
      .u64(args.creatorFeeShareBps, 'creatorFeeShareBps')
      .u64(args.initialVirtualSol, 'initialVirtualSol')
      .u64(args.initialVirtualToken, 'initialVirtualToken')
      .u64(args.tokenTotalSupply, 'tokenTotalSupply')
      .u64(args.graduationTargetLamports, 'graduationTargetLamports')
      .u64(args.migrationReserveLamports, 'migrationReserveLamports')
      .pubkey(args.cpSwapProgram)
      .pubkey(args.ammConfig)
      .finish(),
  });
}

/**
 * `update_global(...)` — authority-only, lib.rs:276-285. Every field is
 * `Option`; omit one to leave it unchanged.
 *
 * This NEVER affects a live curve: every launch snapshots its own terms at
 * creation (lib.rs:426-432), which is the whole point (design note 1,
 * lib.rs:18-21). `paused` is the intended kill switch, and it does not stop
 * sells.
 */
export interface UpdateGlobalArgs {
  tradeFeeBps?: bigint | null;
  graduationTargetLamports?: bigint | null;
  paused?: boolean | null;
  newAuthority?: PublicKey | null;
  newFeeRecipient?: PublicKey | null;
  migrationReserveLamports?: bigint | null;
  newCpSwapProgram?: PublicKey | null;
  newAmmConfig?: PublicKey | null;
  newInitialVirtualSol?: bigint | null;
  /**
   * The TENTH and last `Option` (lib.rs:476). Omitting it did not produce a
   * mis-shifted argument the way a missing REQUIRED field does — a trailing
   * `Option` that is never written simply leaves the buffer one byte short of the
   * minimum, so Borsh cannot deserialize and the program rejects the instruction
   * outright. Every `update_global` reverted, which meant the AMM addresses could
   * not be set and authority could not be handed over.
   */
  newCreatorFeeShareBps?: bigint | null;
}

export function updateGlobalIx(
  accounts: { authority: PublicKey },
  args: UpdateGlobalArgs,
  ids: ProgramIds = {},
): TransactionInstruction {
  const programId = ids.programId ?? PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [acc(globalPda(programId), false, true), acc(accounts.authority, true, false)],
    data: new Writer()
      .disc(IX_DISCRIMINATOR.updateGlobal)
      .optU64(args.tradeFeeBps, 'tradeFeeBps')
      .optU64(args.graduationTargetLamports, 'graduationTargetLamports')
      .optBool(args.paused)
      .optPubkey(args.newAuthority)
      .optPubkey(args.newFeeRecipient)
      .optU64(args.migrationReserveLamports, 'migrationReserveLamports')
      .optPubkey(args.newCpSwapProgram)
      .optPubkey(args.newAmmConfig)
      .optU64(args.newInitialVirtualSol, 'newInitialVirtualSol')
      .optU64(args.newCreatorFeeShareBps, 'newCreatorFeeShareBps')
      .finish(),
  });
}

// ── cp-swap: create_amm_config ───────────────────────────────────────────────

/**
 * The six numbers baked into an AmmConfig. All the `*_rate` fields are **out of
 * 1,000,000**, not basis points (`cp-swap curve/fees.rs`).
 */
export interface AmmConfigParams {
  /** Config slot. PERMANENT — it is a PDA seed, so a wrong index is a new config. */
  index: number;
  /** Total swap fee on the graduated pool. `2500` = 0.25%. */
  tradeFeeRate: bigint;
  /** Our share OF THE TRADE FEE. `120000` = 12% of the fee (Raydium's default). */
  protocolFeeRate: bigint;
  /** A second treasury share of the fee. */
  fundFeeRate: bigint;
  /**
   * Flat lamports charged once at pool creation, paid by the migrating curve out of
   * `global.migration_reserve_lamports`.
   *
   * ⚠️ CEILING: `migration_reserve - MIN_MIGRATION_RESERVE_LAMPORTS`. With the live
   * reserve of 250,000,000 and 42,156,720 of account rent, that is **207,843,280
   * lamports**. Above it, migration cannot pay, and because the reserve is
   * snapshotted onto every curve at creation, EVERY launch made before the change
   * becomes permanently unmigratable — discovered at the finish line with the pool
   * half-built (state.rs:40-50). Raydium's usual 150,000,000 fits.
   */
  createPoolFee: bigint;
  /** Pool-creator cut. Distinct from the launch creator split in `global`. */
  creatorFeeRate: bigint;
}

/**
 * cp-swap `create_amm_config` — the graduated pool's fee schedule. Runs ONCE per
 * index; the AmmConfig is a PDA, so an index cannot be reused.
 *
 * `owner` must equal cp-swap's compile-time `admin::ID` AND is the `payer` for the
 * account (`create_config.rs:10-27`), so it has to be an address that can both sign
 * and be debited by the System Program. The multisig CONFIG account can do neither;
 * only a vault PDA or a plain wallet works. Getting this wrong is what made the
 * instruction uncallable on the first mainnet deploy.
 *
 * It also sets `protocol_owner = fund_owner = owner`, so whoever calls this becomes
 * the fee collector until `update_config` params 3 and 4 move it.
 */
export function createAmmConfigIx(
  accounts: { owner: PublicKey },
  params: AmmConfigParams,
  ids: ProgramIds = {},
): TransactionInstruction {
  const cpSwapProgram = ids.cpSwapProgram ?? CP_SWAP_PROGRAM_ID;
  return new TransactionInstruction({
    programId: cpSwapProgram,
    keys: [
      acc(accounts.owner, true, true),
      acc(cpAmmConfigPda(params.index, cpSwapProgram), false, true),
      acc(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: new Writer()
      .disc(CP_SWAP_IX_DISCRIMINATOR.createAmmConfig)
      .u16(params.index, 'index')
      .u64(params.tradeFeeRate, 'tradeFeeRate')
      .u64(params.protocolFeeRate, 'protocolFeeRate')
      .u64(params.fundFeeRate, 'fundFeeRate')
      .u64(params.createPoolFee, 'createPoolFee')
      .u64(params.creatorFeeRate, 'creatorFeeRate')
      .finish(),
  });
}
