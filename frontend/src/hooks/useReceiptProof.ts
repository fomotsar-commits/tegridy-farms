import { useBlock, useWaitForTransactionReceipt } from 'wagmi';
import type { Hex } from 'viem';
import type { Invoice } from '../lib/commerce/invoice';
import { judgeReceipt, type ReceiptVerdict } from '../lib/commerce/receiptProof';
import { useTrackedTransactionReceipt } from './useTransactionReceipt';

// Turning a transaction hash into a verdict about one invoice.
//
// ─── NO NEW STATE MACHINE ───────────────────────────────────────────────────
//
// `useTrackedTransactionReceipt` already folds wagmi's flags into
// pending / confirmed / failed / replaced / dropped, including the correction
// that `isSuccess` means "receipt FETCHED" and latches true for a REVERTED
// transaction. Writing a second machine here would be a second opinion about
// what a reverted receipt means, and the two would drift.
//
// It is called alongside `useWaitForTransactionReceipt` with IDENTICAL arguments
// rather than being widened to return the receipt itself. Two calls with the
// same arguments share one TanStack query, so this is one request, not two — and
// `TrackedReceipt` stays the narrow value type that a dozen other surfaces
// consume without a viem `Log` in their types. Only this file needs the logs.
//
// One confirmation, not the tracker's default two: the judge reads what the
// receipt CONTAINS, which does not change with depth, and reorg depth is
// reported separately from a real head read rather than being waited for here.
//
// ─── A HASH NOBODY FOUND IS NOT A REFUTATION ────────────────────────────────
//
// dropped / replaced map to `unread`, never to `chain-refuted`. A merchant told
// "this receipt does NOT contain the transfer to you" about a hash the RPC
// simply did not answer for has been told they were not paid, which may be
// false, and it is the sentence they decide whether to ship against.

export type ReceiptProofState =
  | { status: 'idle' }
  | { status: 'reading' }
  /** A statement about this browser's connection. Never about the payment. */
  | { status: 'unread'; detail: string }
  | { status: 'judged'; verdict: ReceiptVerdict; blockNumber: bigint | null };

export function useReceiptProof(invoice: Invoice | null, txHash: Hex | null): ReceiptProofState {
  const hash = txHash ?? undefined;
  const chainId = invoice?.chainId;

  const tracked = useTrackedTransactionReceipt(hash, 1);
  const { data: receipt } = useWaitForTransactionReceipt({ hash, confirmations: 1, chainId });

  const blockNumber = receipt?.blockNumber ?? tracked.blockNumber ?? null;
  // The block is read for its own timestamp — chain time, never Date.now(). A
  // failed block read leaves the verdict's `minedAt` null and the surface says
  // "block time not read" rather than filling in the reader's clock.
  const { data: block } = useBlock({
    blockNumber: blockNumber ?? undefined,
    chainId,
    query: { enabled: blockNumber !== null && chainId !== undefined },
  });

  if (!invoice || !hash) return { status: 'idle' };

  switch (tracked.status) {
    case 'idle':
    case 'pending':
      return { status: 'reading' };
    case 'dropped':
    case 'replaced':
      return {
        status: 'unread',
        detail:
          `No transaction with this hash was found on chain ${invoice.chainId} by this RPC (not mined yet, ` +
          'dropped, or the RPC did not answer). This is not a payment record and it is not a refutation of one.',
      };
    case 'confirmed':
    case 'failed': {
      if (!receipt) {
        // The tracker reached a terminal state and the receipt is not in hand.
        // Nothing can be judged from that, and guessing would be inventing one.
        return { status: 'reading' };
      }
      return {
        status: 'judged',
        verdict: judgeReceipt(
          invoice,
          { status: receipt.status, logs: receipt.logs },
          block ? { timestamp: block.timestamp } : null,
        ),
        blockNumber,
      };
    }
  }
}
