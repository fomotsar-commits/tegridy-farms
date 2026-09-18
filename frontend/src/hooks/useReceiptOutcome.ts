import { useEffect } from 'react';
import { toast } from 'sonner';
import { getTxUrl } from '../lib/explorer';
import { receiptOutcome, surfaceUnconfirmedTx, type ReceiptQueryLike } from '../lib/txErrors';

/**
 * `receiptOutcome()` plus the one warning every receipt wait owes an unreadable
 * receipt.
 *
 * wagmi THROWS on a reverted receipt, so a real revert arrives on `isError` next
 * to "we could not read the receipt" (see the measurement table in
 * lib/txErrors.ts). The surfaces that call this used to derive a revert as
 * `isSuccess && data.status !== 'success'`, a shape wagmi 3 never produces, and
 * never read `isError` at all: a revert and an unread receipt were both silent,
 * or left a step latched on "confirming".
 *
 * The revert is left to the caller. Its words, and what it resets or refetches,
 * belong to the surface. The unreadable warning does not: it is the same
 * sentence everywhere, keyed on the hash, with only the cost of a resend
 * written per call site.
 */
export function useReceiptOutcome(
  query: ReceiptQueryLike,
  opts: { hash: `0x${string}` | undefined; chainId: number; repeatCost: string },
): ReturnType<typeof receiptOutcome> {
  const outcome = receiptOutcome(query);
  const { isReceiptUnreadable } = outcome;
  const { hash, chainId, repeatCost } = opts;
  useEffect(() => {
    if (!isReceiptUnreadable || !hash) return;
    surfaceUnconfirmedTx(toast, { hash, explorerUrl: getTxUrl(chainId, hash), repeatCost });
  }, [isReceiptUnreadable, hash, chainId, repeatCost]);
  return outcome;
}
