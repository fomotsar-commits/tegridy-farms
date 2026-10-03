// SOL in and out of a token-program instruction, through the signer's own
// wrapped-SOL (WSOL) account: the classic associated account for the native mint.
//
//   open:  create that account if it is missing (idempotent, classic Token)
//   wrap:  move lamports into it, then sync its token balance
//   close: send everything in it back to the signer as plain SOL
//
// The close is planned only when the account was absent or held nothing in the
// builder's read, so a wallet's own wrapped SOL is never unwrapped behind its back.
// An account someone else can close, or a kept one an approved spender can draw
// from, is not used at all (`wsolPlanFrom` says why).
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
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatSol } from '../curve/format';
import type { PreToken } from './types';

export interface WsolPlan {
  /** The signer's WSOL associated account. */
  ata: PublicKey;
  /** Close it at the end: only when it was absent or held 0 in the builder's read. */
  closeAfter: boolean;
  /** Its token balance in that read (0 when absent). */
  heldBefore: bigint;
}

/** The parts of a classic token account (165 bytes) this plan needs; null when it is not one. */
function readAccount(data: Uint8Array): { amount: bigint; delegate: PublicKey | null; delegatedAmount: bigint; closeAuthority: PublicKey | null } | null {
  if (data.length < 165) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opt = (at: number) => (v.getUint32(at, true) === 1 ? new PublicKey(data.subarray(at + 4, at + 36)) : null);
  return { amount: v.getBigUint64(64, true), delegate: opt(72), delegatedAmount: v.getBigUint64(121, true), closeAuthority: opt(129) };
}

/**
 * Plan from the builder's read of the signer's WSOL account (`null` = absent).
 * A string = this account cannot be used, said in plain words:
 *  - it is not a readable token account;
 *  - someone other than the signer can close it. Wrapped SOL is native, so its close
 *    authority can close it with SOL inside and send every lamport wherever it likes.
 *    Kept, that would hand over what this transaction leaves in it; closed, the token
 *    program refuses our close (only that authority may sign it), so the transaction
 *    would fail. Either way it is not used. Only that authority can remove itself;
 *  - it is kept (it already holds wrapped SOL, so this transaction leaves SOL in it)
 *    and an approved spender can still move some out. A closed account is emptied and
 *    closed in the same transaction, so a spender there can take nothing.
 */
export function wsolPlanFrom(owner: PublicKey, account: { data: Uint8Array } | null): WsolPlan | string {
  const ata = associatedTokenAddress(WSOL_MINT, owner);
  if (!account) return { ata, closeAfter: true, heldBefore: 0n };
  const acc = readAccount(account.data);
  if (!acc) return 'Your wrapped-SOL account could not be read.';
  if (acc.closeAuthority && !acc.closeAuthority.equals(owner)) {
    return `${acc.closeAuthority.toBase58()} can close your wrapped-SOL account (${ata.toBase58()}) and take what is in it, and only that key can change that. This site will not use that account, so nothing was built.`;
  }
  const closeAfter = acc.amount === 0n;
  if (!closeAfter && acc.delegate && acc.delegatedAmount > 0n) {
    return `An approved spender (${acc.delegate.toBase58()}) can move up to ${formatSol(acc.delegatedAmount, 9)} wrapped SOL out of your wrapped-SOL account, and this would leave SOL in it. Revoke that approval in your wallet, then try again.`;
  }
  return { ata, closeAfter, heldBefore: acc.amount };
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

/**
 * What one sync adds to a wrapped-SOL account's balance on top of what the transaction
 * itself moves: the lamports it already held above today's reserve and its balance, read
 * before the build. Mainnet's token program re-prices the stored reserve to today's rent
 * on every sync: after the 2026 rent cut, an account set up under the old rent gains the
 * 550,840 lamports it had been holding as reserve. Only lamports the account already
 * held are credited, never the wallet's; an account that is missing or not native gets 0.
 * Exact on purpose. A token program that kept the stored reserve, or a rent rise (which
 * would lower the balance), lands off this number and the check refuses: it fails closed.
 */
export function syncCredit(pre: PreToken | undefined, rentNow: bigint): bigint {
  if (!pre || !pre.exists || pre.nativeReserve === null) return 0n;
  const reserve = rentNow < pre.nativeReserve ? rentNow : pre.nativeReserve;
  const above = pre.lamports - reserve - pre.amount;
  return above > 0n ? above : 0n;
}

/** The close back to the signer, or nothing when the plan keeps the account. */
export function closeWsolIxs(plan: WsolPlan, owner: PublicKey): TransactionInstruction[] {
  return plan.closeAfter ? [createCloseAccountInstruction(plan.ata, owner, owner, [], TOKEN_PROGRAM_ID)] : [];
}
