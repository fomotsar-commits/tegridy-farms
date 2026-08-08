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
// ⚠ The program is NOT DEPLOYED. Anything built here is unsendable today; that is
// deliberate and `read.ts` is where a surface finds out.

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

/**
 * Which pricing curve a launch runs on — mirrors `CurveMode` in state.rs.
 * Anchor serialises a fieldless enum as its u8 discriminant, in declaration order.
 */
// A const object, not a TS `enum`: this project sets `erasableSyntaxOnly`, under
// which `enum` emits runtime code and is rejected.
export const CurveMode = {
  /** Constant product over virtual reserves — the pump.fun shape. */
  ConstantProduct: 0,
  /** Up to 16 (sqrt_price, liquidity) segments — the Meteora shape. */
  Segmented: 1,
} as const;
export type CurveMode = (typeof CurveMode)[keyof typeof CurveMode];

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

  /** A bare `u8`. Range-checked for the same reason `u64` is: a silently truncated
   *  discriminant would select a DIFFERENT curve mode than the caller asked for. */
  u8(v: number, label: string): this {
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new RangeError(`${label} must be an integer in 0..255, got ${v}`);
    }
    this.bytes.push(v);
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

// ── buy / sell (the `Trade` context, lib.rs:1461-1500) ───────────────────────

export interface TradeAccounts {
  trader: PublicKey;
  mint: PublicKey;
  /** MUST equal `global.fee_recipient` (lib.rs:1470) — read it, do not assume it. */
  feeRecipient: PublicKey;
  /**
   * Any token account of `mint` the trader owns; the program does NOT require the
   * ATA (lib.rs:1493-1494). Use the ATA and CREATE IT YOURSELF FIRST — nothing in
   * `buy` creates it. Defaults to `associatedTokenAddress(mint, trader)`.
   */
  traderTokenAccount?: PublicKey;
}

function tradeKeys(a: TradeAccounts, programId: PublicKey) {
  return [
    acc(a.trader, true, true),
    acc(globalPda(programId), false, false),
    acc(a.feeRecipient, false, true),
    acc(a.mint, false, false),
    acc(curvePda(a.mint, programId), false, true),
    acc(curveVaultPda(a.mint, programId), false, true),
    acc(a.traderTokenAccount ?? associatedTokenAddress(a.mint, a.trader), false, true),
    acc(TOKEN_PROGRAM_ID, false, false),
    acc(SYSTEM_PROGRAM_ID, false, false),
  ];
}

/**
 * `buy(max_lamports_in, min_tokens_out)` — lib.rs:452.
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
 * `sell(tokens_in, min_lamports_out)` — lib.rs:565.
 *
 * Deliberately NOT gated on `global.paused` (lib.rs:563-564): a pause stops new
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

// ── create_launch (lib.rs:1254-1314) ─────────────────────────────────────────

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
 */
export function createLaunchIx(
  accounts: { creator: PublicKey; mint: PublicKey },
  /** 0 = ConstantProduct (pump.fun shape), 1 = Segmented (Meteora shape). */
  mode: CurveMode = CurveMode.ConstantProduct,
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
    data: new Writer().disc(IX_DISCRIMINATOR.createLaunch).u8(mode, 'mode').finish(),
  });
}

// ── migrate_to_amm (lib.rs:1323-1459) ────────────────────────────────────────

export interface MigrateAccounts {
  /** Funds rent along the way and is fully reimbursed by the sweep (lib.rs:1075-1162). */
  payer: PublicKey;
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
}

/**
 * `migrate_to_amm()` — no args, permissionless by design (lib.rs:686-692): no
 * caller-chosen parameters, pays the caller nothing, exactly one legal outcome.
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
      acc(launchMint, false, false),
      acc(curvePda(launchMint, programId), false, true),
      acc(curveVaultPda(launchMint, programId), false, true),
      acc(WSOL_MINT, false, false),
      acc(migrationAuthority, false, true),
      acc(associatedTokenAddress(WSOL_MINT, migrationAuthority), false, true),
      acc(associatedTokenAddress(launchMint, migrationAuthority), false, true),
      acc(associatedTokenAddress(lpMint, migrationAuthority), false, true),
      acc(cpSwapProgram, false, false),
      acc(accounts.ammConfig, false, false),
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
      acc(SYSVAR_RENT_PUBKEY, false, false),
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
