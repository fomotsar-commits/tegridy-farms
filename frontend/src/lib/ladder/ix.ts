// Instruction builders for `bayla-ladder`.
//
// PURE. These open no connection, sign nothing and send nothing — they return
// `TransactionInstruction`s a caller adds to a transaction. Same doctrine as
// `curve/ix.ts`: the param layer and the signing layer stay apart, because a bad
// read shows a wrong number and a bad write spends someone's money.
//
// ⚠️ ACCOUNTS ARE MATCHED BY POSITION, NOT BY NAME. Anchor compares the account
// list ordinally, so a reordered list produces a constraint failure on the WRONG
// account — which reads like a program bug and is not one. Every order below was
// taken from the built IDL and then driven successfully against the live program on
// devnet. A mutation test in the CLI's suite caught exactly this: swapping
// `user_stats` and `position` in `stake` left every flag-shaped assertion green,
// because both are (non-signer, writable). The tests here assert NAMED positions.
//
// Hand-encoded because `@coral-xyz/anchor` is not a dependency of this repo and
// adding it to ship one client is not worth the weight — the same choice
// `curve/ix.ts` makes, for the same reason.
import { Buffer } from 'buffer';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  IX_DISCRIMINATOR,
  SYSTEM_PROGRAM_ID,
  associatedTokenAddress,
  positionPda,
  userStatsPda,
  type LadderPoolView,
} from './program';

/* ─────────────────────────── encoding ─────────────────────────── */

const u64le = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

const i64le = (v: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
};

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) =>
  ({ pubkey, isSigner, isWritable });

/**
 * The pool fields every builder needs, in the shape `read.ts` produces.
 *
 * `tokenProgram` is taken from the POOL, never assumed: it is pinned at init to
 * whatever program actually owns the mint, and the first Streamflow broadcast in
 * this repo died with `IncorrectProgramId` for assuming legacy SPL.
 */
export type PoolAccounts = Pick<
  LadderPoolView, 'mint' | 'tokenProgram' | 'stakeVault' | 'rewardVault'
>;

interface Common {
  programId: PublicKey;
  owner: PublicKey;
  pool: PublicKey;
  poolAccounts: PoolAccounts;
}

const keysOf = (p: PoolAccounts) => ({
  mint: new PublicKey(p.mint),
  tokenProgram: new PublicKey(p.tokenProgram),
  stakeVault: new PublicKey(p.stakeVault),
  rewardVault: new PublicKey(p.rewardVault),
});

/* ─────────────────────────── builders ─────────────────────────── */

/**
 * Open a position.
 *
 * `positionNonce` is PROGRAM-ASSIGNED from `UserStats.next_nonce` — it is not the
 * caller's to choose, and it must be READ before the instruction can be addressed
 * at all. Two concurrent stakes from one wallet therefore collide on the same
 * position address; the second fails rather than overwriting, which is the safe
 * direction, but a UI should not fire them in parallel.
 */
export function stakeIx(
  args: Common & { positionNonce: number; amountRaw: bigint; lockSecs: number },
): TransactionInstruction {
  const k = keysOf(args.poolAccounts);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.owner, true, true),
      meta(args.pool, false, true),
      meta(k.mint, false, false),
      meta(userStatsPda(args.programId, args.pool, args.owner), false, true),
      meta(positionPda(args.programId, args.pool, args.owner, args.positionNonce), false, true),
      meta(associatedTokenAddress(k.mint, args.owner, k.tokenProgram), false, true),
      meta(k.stakeVault, false, true),
      meta(k.tokenProgram, false, false),
      meta(SYSTEM_PROGRAM_ID, false, false),
    ],
    data: Buffer.concat([
      Buffer.from(IX_DISCRIMINATOR.stake),
      u64le(args.amountRaw),
      i64le(BigInt(Math.trunc(args.lockSecs))),
    ]),
  });
}

/** Pay accrued rewards for ONE position. Draws on the REWARD vault only (I-12). */
export function claimIx(args: Common & { positionNonce: number }): TransactionInstruction {
  const k = keysOf(args.poolAccounts);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.owner, true, false),          // signs, but is NOT writable here
      meta(args.pool, false, true),
      meta(k.mint, false, false),
      meta(positionPda(args.programId, args.pool, args.owner, args.positionNonce), false, true),
      meta(associatedTokenAddress(k.mint, args.owner, k.tokenProgram), false, true),
      meta(k.rewardVault, false, true),
      meta(k.tokenProgram, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATOR.claim),
  });
}

/**
 * Close a position through one of the two normal doors.
 *
 * They share an account list and differ ONLY in the discriminator. They also
 * partition time — `withdraw_matured` requires `now >= lock_end`, `early_exit`
 * requires `now <` — so exactly one is open and the other reverts. Use
 * `quoteExit()` to pick, and to show the price before sending.
 */
export function exitIx(
  args: Common & { positionNonce: number; early: boolean },
): TransactionInstruction {
  const k = keysOf(args.poolAccounts);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.owner, true, true),
      meta(args.pool, false, true),
      meta(k.mint, false, false),
      meta(userStatsPda(args.programId, args.pool, args.owner), false, true),
      meta(positionPda(args.programId, args.pool, args.owner, args.positionNonce), false, true),
      meta(associatedTokenAddress(k.mint, args.owner, k.tokenProgram), false, true),
      meta(k.stakeVault, false, true),
      meta(k.rewardVault, false, true),
      meta(k.tokenProgram, false, false),
    ],
    data: Buffer.from(
      args.early ? IX_DISCRIMINATOR.earlyExit : IX_DISCRIMINATOR.withdrawMatured,
    ),
  });
}

/**
 * The hatch. Principal only, no reward accounting — so it cannot revert on an
 * accounting drift or a dry reward vault, which is the whole point of it.
 *
 * ⚠️ NOT FREE WHILE LOCKED: it charges the same flat 25% as `early_exit` unless the
 * position has matured or the pool is `degraded`. Accrued rewards are not lost —
 * they move to `rewards_carried` and stay claimable via `claimCarriedIx`.
 *
 * It NAMES NO REWARD VAULT. That is invariant I-12 enforced by the account list
 * itself rather than by arithmetic: a reward can never be paid out of principal,
 * and principal can never be paid out of the reward vault.
 */
export function emergencyWithdrawIx(
  args: Common & { positionNonce: number },
): TransactionInstruction {
  const k = keysOf(args.poolAccounts);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.owner, true, true),
      meta(args.pool, false, true),
      meta(k.mint, false, false),
      meta(userStatsPda(args.programId, args.pool, args.owner), false, true),
      meta(positionPda(args.programId, args.pool, args.owner, args.positionNonce), false, true),
      meta(associatedTokenAddress(k.mint, args.owner, k.tokenProgram), false, true),
      meta(k.stakeVault, false, true),
      meta(k.tokenProgram, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATOR.emergencyWithdraw),
  });
}

/**
 * Pay out `rewards_carried` — the balance the hatch, and any closing exit whose
 * reward vault was short, deposited. Without this the UI shows a number it cannot
 * move, which is how a balance quietly becomes invisible.
 */
export function claimCarriedIx(args: Common): TransactionInstruction {
  const k = keysOf(args.poolAccounts);
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      meta(args.owner, true, false),
      meta(args.pool, false, true),
      meta(k.mint, false, false),
      meta(userStatsPda(args.programId, args.pool, args.owner), false, true),
      meta(associatedTokenAddress(k.mint, args.owner, k.tokenProgram), false, true),
      meta(k.rewardVault, false, true),
      meta(k.tokenProgram, false, false),
    ],
    data: Buffer.from(IX_DISCRIMINATOR.claimCarried),
  });
}
