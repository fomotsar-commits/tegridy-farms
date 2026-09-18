import { useEffect } from 'react';
import { toast } from 'sonner';
import { getTxUrl } from '../lib/explorer';
import {
  receiptOutcome,
  surfaceReplacedTx,
  surfaceUnconfirmedTx,
  type ReceiptQueryLike,
  type ReceiptReplacement,
} from '../lib/txErrors';

/**
 * `receiptOutcome()` plus the warnings every receipt wait owes an unreadable
 * receipt and a replaced transaction.
 *
 * wagmi THROWS on a reverted receipt, so a real revert arrives on `isError` next
 * to "we could not read the receipt" (see the measurement table in
 * lib/txErrors.ts). The surfaces that call this used to derive a revert as
 * `isSuccess && data.status !== 'success'`, a shape wagmi 3 never produces, and
 * never read `isError` at all: a revert and an unread receipt were both silent,
 * or left a step latched on "confirming".
 *
 * The revert is left to the caller. Its words, and what it resets or refetches,
 * belong to the surface. The unreadable and replaced warnings do not: each is the
 * same sentence everywhere, keyed on the hash, with only the cost of a resend
 * written per call site.
 */
export function useReceiptOutcome(
  query: ReceiptQueryLike,
  opts: { hash: `0x${string}` | undefined; chainId: number; repeatCost: string },
): ReturnType<typeof receiptOutcome> {
  const { hash, chainId, repeatCost } = opts;
  const outcome = receiptOutcome(query, hash);
  const { isReceiptUnreadable } = outcome;
  useEffect(() => {
    if (!isReceiptUnreadable || !hash) return;
    surfaceUnconfirmedTx(toast, { hash, explorerUrl: getTxUrl(chainId, hash), repeatCost });
  }, [isReceiptUnreadable, hash, chainId, repeatCost]);
  useReplacedTxNotice(outcome, hash, chainId);
  return outcome;
}

/**
 * The "cancelled" / "replaced" warning for a receipt wait whose receipt turned out
 * to be another transaction's (see lib/txErrors.ts). For surfaces that call
 * `receiptOutcome()` directly; `useReceiptOutcome()` already includes it.
 */
export function useReplacedTxNotice(
  outcome: { isReplaced: boolean; replacement: ReceiptReplacement | null },
  hash: `0x${string}` | undefined,
  chainId: number,
): void {
  const { isReplaced, replacement } = outcome;
  const replacementHash = replacement?.hash;
  const reason = replacement?.reason;
  useEffect(() => {
    if (!isReplaced || !hash || !replacementHash || !reason) return;
    surfaceReplacedTx(toast, {
      hash,
      replacement: { hash: replacementHash, reason },
      explorerUrl: getTxUrl(chainId, replacementHash),
    });
  }, [isReplaced, hash, replacementHash, reason, chainId]);
}
