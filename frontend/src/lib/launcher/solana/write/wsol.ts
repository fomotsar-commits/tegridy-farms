// SOL in and out of a token-program instruction, through the signer's own
// wrapped-SOL (WSOL) account: the classic associated account for the native mint.
//
//   open:  create that account if it is missing (idempotent, classic Token)
//   wrap:  move lamports into it, then sync its token balance
//   close: send everything in it back to the signer as plain SOL
//
// The close is planned only when the account was absent or held nothing in the
// builder's read, so a wallet's own wrapped SOL is never unwrapped behind its back.
// Every builder that uses this also watches the account with a balance row, so
// wrapped SOL that arrives after that read is blocked by the balance check, not paid
// out.
//
// Used by poolSwap.ts. Its instructions are byte-identical to the ones it built
// before this file existed.

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { SystemProgram, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';

export interface WsolPlan {
  /** The signer's WSOL associated account. */
  ata: PublicKey;
  /** Close it at the end: only when it was absent or held 0 in the builder's read. */
  closeAfter: boolean;
  /** Its token balance in that read (0 when absent). */
  heldBefore: bigint;
}

function tokenAmount(data: Uint8Array): bigint | null {
  if (data.length < 72) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/**
 * Plan from the builder's read of the signer's WSOL account (`null` = absent).
 * A string = the account exists but is not a readable token account.
 */
export function wsolPlanFrom(owner: PublicKey, account: { data: Uint8Array } | null): WsolPlan | string {
  const ata = associatedTokenAddress(WSOL_MINT, owner);
  if (!account) return { ata, closeAfter: true, heldBefore: 0n };
  const held = tokenAmount(account.data);
  if (held === null) return 'Your wrapped-SOL account could not be read.';
  return { ata, closeAfter: held === 0n, heldBefore: held };
}

/** Create the signer's WSOL account if it is missing. The signer pays and owns it. */
export function openWsolIx(owner: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    owner,
    associatedTokenAddress(WSOL_MINT, owner),
    owner,
    WSOL_MINT,
    TOKEN_PROGRAM_ID,
  );
}

/** Move `lamports` of the signer's SOL into its WSOL account and sync the token balance. */
export function wrapIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const ata = associatedTokenAddress(WSOL_MINT, owner);
  return [
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
    createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID),
  ];
}

/** The close back to the signer, or nothing when the plan keeps the account. */
export function closeWsolIxs(plan: WsolPlan, owner: PublicKey): TransactionInstruction[] {
  return plan.closeAfter ? [createCloseAccountInstruction(plan.ata, owner, owner, [], TOKEN_PROGRAM_ID)] : [];
}
