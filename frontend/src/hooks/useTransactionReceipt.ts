import { createContext, useContext, useState, useCallback } from 'react';
import { useWaitForTransactionReceipt } from 'wagmi';
import { isRevertedReceiptError, noteReplacement, receiptOutcome } from '../lib/txErrors';

export type ReceiptType = 'swap' | 'stake' | 'unstake' | 'claim' | 'vote' | 'bounty' | 'lock' | 'approve' | 'liquidity_add' | 'liquidity_remove' | 'subscribe' | 'claim_revenue';

export interface ReceiptData {
  type: ReceiptType;
  data: {
    // For swaps
    fromToken?: string;
    fromAmount?: string;
    toToken?: string;
    toAmount?: string;
    rate?: string;
    fee?: string;
    slippage?: string;
    // For staking
    amount?: string;
    token?: string;
    lockDuration?: string;
    boost?: string;
    estimatedAPR?: string;
    // For claims
    rewardAmount?: string;
    // For votes
    poolName?: string;
    voteWeight?: string;
    // For bounties
    bountyTitle?: string;
    bountyReward?: string;
    // For approvals
    spender?: string;
    // For liquidity
    tokenA?: string;
    amountA?: string;
    tokenB?: string;
    amountB?: string;
    percent?: string;
    // For subscriptions
    tier?: string;
    duration?: string;
    // For revenue claims
    epoch?: string;
    // Block info
    blockTimestamp?: string;
    // Common
    txHash?: string;
  };
}

interface TransactionReceiptContextValue {
  receiptData: ReceiptData | null;
  showReceipt: (data: ReceiptData) => void;
  hideReceipt: () => void;
}

export const TransactionReceiptContext = createContext<TransactionReceiptContextValue>({
  receiptData: null,
  showReceipt: () => {},
  hideReceipt: () => {},
});

export function useTransactionReceiptState() {
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);

  const showReceipt = useCallback((data: ReceiptData) => {
    setReceiptData(data);
  }, []);

  const hideReceipt = useCallback(() => {
    setReceiptData(null);
  }, []);

  return { receiptData, showReceipt, hideReceipt };
}

export function useTransactionReceipt() {
  return useContext(TransactionReceiptContext);
}

// ─── R044 H3: tracked receipt hook with reorg defense ──────────────────
// `useWaitForTransactionReceipt` from wagmi only exposes `isLoading /
// isSuccess / isError`. That's not enough to distinguish "succeeded" from
// "reverted" (both flip `isSuccess: true`), or to react to a reorg/replace
// event. This wrapper folds the wagmi result into a discriminated state
// machine so call sites can show the right UX without inspecting the raw
// receipt themselves.
export type TrackedReceiptStatus =
  | 'idle'        // no hash yet
  | 'pending'     // wagmi still confirming
  | 'confirmed'   // receipt.status === 'success' AND >= `confirmations` blocks deep
  | 'failed'      // the tx reverted (wagmi THROWS CallExecutionError for it)
  | 'replaced'    // the wallet cancelled or replaced it: the receipt is ANOTHER tx's
  | 'dropped';    // any other error: the receipt was not read, so NOTHING is known

export interface TrackedReceipt {
  status: TrackedReceiptStatus;
  isPending: boolean;
  isConfirmed: boolean;
  isTerminal: boolean;
  blockNumber?: bigint;
  errorName?: string;
  /** For 'replaced': the transaction that confirmed at this one's nonce instead. */
  replacedBy?: `0x${string}`;
}

/**
 * Default to 2 confirmations — battle-tested L2 floor that survives a
 * single-block reorg without overweighting wait time.
 */
export function useTrackedTransactionReceipt(
  hash: `0x${string}` | undefined,
  confirmations: number = 2,
): TrackedReceipt {
  // AUDIT FIX 2026-08-24: the previous version read `receiptStatus` /
  // `blockNumber` / `errorName` from the TOP LEVEL of wagmi's return — fields
  // that existed only in this hook's own test mock. On real wagmi the receipt
  // lives on `data` (`data.status`, `data.blockNumber`) and the error object on
  // `error`, so the reverted branch could never fire and a reverted tx reported
  // 'confirmed' — the exact bug this wrapper exists to prevent. Read the real
  // shape; the test mock now mirrors real wagmi instead of the fiction.
  const result = useWaitForTransactionReceipt({ hash, confirmations, onReplaced: noteReplacement });
  const receipt = result.data;
  // Widened to string: wagmi's error union is narrower than what the underlying
  // viem calls can throw.
  const errorName: string | undefined = result.error?.name;
  // 2026-09-17: 'replaced' used to key on a thrown TransactionReplacedError, which
  // viem 2 does not define and never throws, so it was unreachable. A replaced
  // transaction RESOLVES, with the replacement's receipt (a cancel's says
  // success), and reported 'confirmed'. The hash mismatch is the signal; a
  // speed-up is the same call and stays 'confirmed'. See lib/txErrors.ts.
  const { isReplaced, replacement } = receiptOutcome(result, hash);

  if (!hash) {
    return { status: 'idle', isPending: false, isConfirmed: false, isTerminal: false };
  }

  if (result.isError) {
    // 2026-09-17: a revert lands HERE, not on `isSuccess` below. wagmi's
    // waitForTransactionReceipt throws on `status === 'reverted'` (it replays the
    // tx to recover a reason), so the `receipt.status !== 'success'` branch below
    // never saw a real revert and every one reported 'dropped'. Only a
    // CallExecutionError is positive evidence of a revert; see lib/txErrors.ts.
    if (isRevertedReceiptError(result.error)) {
      return {
        status: 'failed',
        isPending: false,
        isConfirmed: false,
        isTerminal: true,
        ...(errorName !== undefined ? { errorName } : {}),
      };
    }
    // TransactionNotFoundError + unknown errors fold to "dropped" — safer
    // default than pretending a missing tx is still pending.
    return {
      status: 'dropped',
      isPending: false,
      isConfirmed: false,
      isTerminal: true,
      ...(errorName !== undefined ? { errorName } : {}),
    };
  }

  if (result.isSuccess) {
    if (isReplaced && replacement) {
      return {
        status: 'replaced',
        isPending: false,
        isConfirmed: false,
        isTerminal: true,
        replacedBy: replacement.hash,
      };
    }
    if (receipt && receipt.status !== 'success') {
      return {
        status: 'failed',
        isPending: false,
        isConfirmed: false,
        isTerminal: true,
        ...(receipt.blockNumber !== undefined ? { blockNumber: receipt.blockNumber } : {}),
      };
    }
    return {
      status: 'confirmed',
      isPending: false,
      isConfirmed: true,
      isTerminal: true,
      ...(receipt?.blockNumber !== undefined ? { blockNumber: receipt.blockNumber } : {}),
    };
  }

  if (result.isLoading) {
    return { status: 'pending', isPending: true, isConfirmed: false, isTerminal: false };
  }

  return { status: 'idle', isPending: false, isConfirmed: false, isTerminal: false };
}
