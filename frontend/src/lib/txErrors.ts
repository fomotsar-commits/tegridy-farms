/**
 * txErrors.ts — Differentiated error surfacing for wagmi / viem transactions.
 *
 * Why this exists:
 *   Before this helper, components swallowed errors with `.catch(() => {})`
 *   or funneled everything to a generic toast. User cancellations looked the
 *   same as on-chain reverts, so users couldn't tell "I rejected" from
 *   "the contract rejected". This helper:
 *
 *   1. Treats `UserRejectedRequestError` as a soft "Cancelled" info message.
 *   2. Surfaces viem's `shortMessage` (human-readable revert reason) first.
 *   3. Falls back to the long message, then a generic string.
 *   4. Logs the full error to console for debugging.
 *
 * Usage:
 *   import { surfaceTxError } from '@/lib/txErrors';
 *   import { toast } from 'sonner';
 *
 *   try { await writeContractAsync(...) }
 *   catch (err) { surfaceTxError(err, toast, { component: 'StakingCard' }); }
 */
import { UserRejectedRequestError } from 'viem';

// R080: exported so test mocks can be typed against the same shape. Tests
// pass vitest mocks (a callable + constructor intersection) which match
// this only under `strictFunctionTypes: false` — that flag is now off in
// `tsconfig.test.json` so production code stays strict and tests still
// compile without `as unknown as ToastLike` boilerplate.
export type ToastLike = {
  error: (msg: string) => void;
  info?: (msg: string) => void;
  message?: (msg: string) => void;
};

interface SurfaceOpts {
  /** Optional label prefixed to console.error for component attribution. */
  component?: string;
  /** Override the "cancelled" message shown for UserRejectedRequestError. */
  cancelledMessage?: string;
  /** Treat the error as silent (log only, no toast). */
  silent?: boolean;
}

/**
 * Check whether an error was caused by the user rejecting the wallet prompt.
 * Handles both viem's explicit error class and common string signatures
 * from older wallet providers.
 *
 * AUDIT R074: viem wraps errors so the `UserRejectedRequestError` is usually
 * nested inside a `ContractFunctionExecutionError.cause` (or deeper). The
 * legacy check only looked at the outer error and produced false-negative
 * "real failure" toasts for cancelled wallet prompts. Walk the `.cause`
 * chain (cycle-safe via a depth cap) so any layer surfacing the rejection
 * is detected.
 */
export function isUserRejection(err: unknown): boolean {
  // AUDIT R074: walk the cause chain — viem nests rejection errors several
  // layers deep when the prompt comes from a contract write. 8 hops is
  // plenty (every layer we control is at most 3).
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current instanceof UserRejectedRequestError) return true;
    if (typeof current !== 'object' || current === null) break;
    const e = current as { name?: string; code?: number; message?: string; cause?: unknown };
    if (e.code === 4001) return true; // EIP-1193 standard
    if (e.name === 'UserRejectedRequestError') return true;
    const msg = (e.message ?? '').toLowerCase();
    if (msg.includes('user rejected') || msg.includes('user denied')) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Extract the most human-readable message from a viem / wagmi error.
 * Prefers `shortMessage` (e.g. "Insufficient funds for gas"),
 * falls back to `message`, then a generic default.
 */
export function extractErrorMessage(err: unknown, fallback = 'Transaction failed'): string {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  const e = err as { shortMessage?: string; message?: string };
  return e.shortMessage?.trim() || e.message?.trim() || fallback;
}

/**
 * Surface a transaction error to the user via toast, differentiating
 * user-rejections from real failures. Always logs to console.
 */
export function surfaceTxError(err: unknown, toast: ToastLike, opts: SurfaceOpts = {}): void {
  const tag = opts.component ? `[${opts.component}]` : '[tx]';
  // Always log — silent mode suppresses only the toast, not the log.
   
  console.error(tag, err);

  if (opts.silent) return;

  if (isUserRejection(err)) {
    const msg = opts.cancelledMessage ?? 'Cancelled';
    if (toast.info) toast.info(msg);
    else if (toast.message) toast.message(msg);
    else toast.error(msg);
    return;
  }

  toast.error(extractErrorMessage(err));
}

// ─────────────────────────────────────────────────────────────────────────
// WHAT A RECEIPT QUERY ACTUALLY TOLD US.
//
// `useWaitForTransactionReceipt` has three terminal outcomes and exposes them as
// two flags that do not mean what their names suggest. Measured 2026-09-17 with
// the installed @wagmi/core 3.6.5 / viem 2.56.5 against a local anvil node:
//
//   the tx succeeded                  → isSuccess, data.status === 'success'
//   the tx REVERTED                   → isError, error.name === 'CallExecutionError'
//   the node never returned a receipt → isError, error.name ===
//                                       'TransactionReceiptNotFoundError'
//                                       (or an HTTP/RPC error), for a tx that
//                                       succeeded just as often as one that did not
//
// wagmi does NOT return a reverted receipt: on `status === 'reverted'` it replays
// the call to fetch a reason and THROWS the result. So `isSuccess` with
// `data.status === 'reverted'` never happens through wagmi, and every branch that
// waited for it was unreachable. A real revert and an unread receipt both arrived
// as `isError`, and both were called "Transaction failed".
//
// That is right for a revert and wrong for the other one. "Failed" tells the user
// to send it again, and if the transaction landed, an add, stake or swap sent again
// pays twice.
//
// Only `CallExecutionError` counts as a revert. wagmi's revert branch is the only
// place a receipt wait runs `eth_call`, so that error cannot come from a failed
// read. Everything else, including shapes nobody has seen yet, is reported as
// unconfirmed: the wrong answer there costs the user a look at the explorer, while
// the wrong answer the other way costs them a duplicate transaction.
// ─────────────────────────────────────────────────────────────────────────

/** The subset of wagmi's `useWaitForTransactionReceipt` result this reads. */
export type ReceiptQueryLike = {
  data?: { status?: string } | undefined;
  isSuccess: boolean;
  isError: boolean;
  error?: unknown;
};

export type ReceiptOutcome = {
  /** Mined and succeeded. */
  isSuccess: boolean;
  /** Mined and reverted: nothing moved, and "try again" is correct advice. */
  isReverted: boolean;
  /** No receipt came back. Nothing is known, so the only honest advice is "look first". */
  isUnconfirmed: boolean;
};

/** A receipt-wait error that can only have come from a transaction that reverted. */
export function isRevertedReceiptError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'CallExecutionError';
}

export function receiptOutcome(q: ReceiptQueryLike): ReceiptOutcome {
  // A fetched receipt that is not 'success' is kept as a revert even though wagmi
  // never produces one, so a future wagmi that stops throwing cannot turn a
  // revert into a success.
  const fetchedReverted = q.isSuccess && !!q.data && q.data.status !== 'success';
  const erroredReverted = q.isError && isRevertedReceiptError(q.error);
  return {
    isSuccess: q.isSuccess && !fetchedReverted,
    isReverted: fetchedReverted || erroredReverted,
    isUnconfirmed: q.isError && !erroredReverted,
  };
}

/** Toast surface `surfaceUnconfirmedTx` needs: sonner's `warning(title, opts)`. */
export type UnconfirmedToastLike = {
  warning: (msg: string, opts?: {
    id?: string;
    description?: string;
    duration?: number;
    action?: { label: string; onClick: () => void };
  }) => void;
};

/** `0x1234abcd…9876fedc`: enough to match on an explorer, short enough for a toast. */
export function shortHash(hash: string): string {
  return hash.length > 22 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

/**
 * Tell the user we could not confirm their transaction, and that it may well have
 * succeeded.
 *
 * `repeatCost` finishes the sentence "…before you send it again: if it landed, ___".
 * It is written per call site because a duplicate costs something different for an
 * add, a swap and a claim.
 *
 * A warning, not an error, because nothing is known to have gone wrong. It stays up
 * for 30s because it is the only thing between the user and a duplicate spend, and
 * the 4s the surrounding effects reset in is too short to read it.
 */
export function surfaceUnconfirmedTx(
  toast: UnconfirmedToastLike,
  opts: { hash: string; explorerUrl: string; repeatCost: string },
): void {
  toast.warning("We couldn't confirm this transaction", {
    id: `unconfirmed-${opts.hash}`,
    description:
      `${shortHash(opts.hash)} was submitted, but its receipt never came back. That is our read of ` +
      `the network failing, not the transaction — it may well have succeeded. Open it on the ` +
      `explorer before you send it again: if it landed, ${opts.repeatCost}`,
    action: { label: 'Check on Explorer', onClick: () => window.open(opts.explorerUrl, '_blank') },
    duration: 30_000,
  });
}
