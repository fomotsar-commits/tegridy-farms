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
import { UserRejectedRequestError, type ReplacementReason } from 'viem';

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
// A FAILED RECEIPT WAIT IS TWO DIFFERENT FACTS.
//
// `useWaitForTransactionReceipt().isError` covers two outcomes that need
// OPPOSITE advice, and every hook here used to treat them as one:
//
//   1. THE TRANSACTION REVERTED. @wagmi/core's waitForTransactionReceipt does
//      not return a reverted receipt, it THROWS: on `status === 'reverted'` it
//      replays the tx with `call` to recover a reason and throws the result.
//      So a real revert never reaches `isSuccess` / `data.status`, and every
//      `receipt.status !== 'success'` branch keyed off `isSuccess` was dead
//      code. Advice: nothing moved, fix it and try again.
//
//   2. WE COULD NOT READ THE RECEIPT. The node was down, rate-limited, or had
//      not indexed the tx; viem gave up. Nothing is known about what the
//      transaction did. Advice: look before you resend, because if it landed a
//      resend pays twice.
//
// Measured 2026-09-17 against the installed @wagmi/core 3.6.5 / viem 2.56.5 on
// a local anvil, driving the real action through a proxy:
//
//   genuine revert                           -> CallExecutionError
//   genuine revert, state moved since        -> CallExecutionError (replay is
//                                               pinned to the tx's own block)
//   genuine revert, replay slower than 10s   -> Error('unknown reason')
//   success, receipts answered {result:null} -> TransactionReceiptNotFoundError
//   REVERT,  receipts answered {result:null} -> TransactionReceiptNotFoundError
//   success, receipt/tx reads HTTP 500       -> HttpRequestError
//   revert, getTransaction 500s mid-replay   -> HttpRequestError
//   node down / 429 on every call            -> never errors (stays loading)
//
// Rows 3, 5 and 7 are real reverts that land on the unreadable side (row 3 by
// choice, below), which is why the unconfirmed copy never says the transaction
// "may have succeeded". It says we cannot tell.
// ─────────────────────────────────────────────────────────────────────────

/**
 * True only on POSITIVE evidence that the receipt was read and said `reverted`.
 *
 * Anything else is "we could not read it". That default is deliberate: calling an
 * unreadable success a revert says "nothing moved, try again", and the retry pays
 * twice. Calling a revert unreadable says "check the explorer first", which costs a
 * click. Pinned against the real library by txErrors.receipt.test.ts.
 */
export function isRevertedReceiptError(error: unknown): boolean {
  // wagmi's revert replay goes through viem's `call`, which wraps EVERY failure
  // (a revert, or the replay's own transport error) in CallExecutionError and
  // wagmi throws it as-is. viem's receipt waiter never calls `call`, so this
  // error means a receipt was read with status 'reverted'. Matched by `name`,
  // which viem sets explicitly, so a second bundled copy of viem still matches.
  //
  // wagmi's revert branch has two other exits, a bare `new Error(reason)` and a
  // bare `new Error('unknown reason')` when the replay outlasts 10s. They are NOT
  // counted: a bare Error is a shape anything can throw, and the cost of being
  // wrong about it is a user told "try again" about a transaction that landed.
  return (error as { name?: unknown } | null)?.name === 'CallExecutionError';
}

// ─────────────────────────────────────────────────────────────────────────
// A RECEIPT IS ONLY PROOF OF ITS OWN TRANSACTION.
//
// When a wallet replaces a pending transaction (same sender, same nonce), viem's
// waitForTransactionReceipt does not fail. It finds the replacement in a block
// and RESOLVES with the replacement's receipt, whatever the reason. The only
// signs are its `onReplaced` callback and a `data.transactionHash` that is not
// the hash we submitted. A wallet "cancel" is a 0-value send to yourself, so its
// receipt says `status: 'success'`, and `isSuccess` fired every surface's success
// path for an action that never ran.
//
// Measured 2026-09-17 against @wagmi/core 3.6.5 / viem 2.56.5, the original's
// receipt missing and the next block holding a same-nonce tx whose receipt is
// success (pinned by txErrors.receipt.test.ts):
//
//   cancel: 0-value self-send       -> resolves, the cancel's receipt,   reason 'cancelled'
//   speed-up: same to/value/input   -> resolves, the speed-up's receipt, reason 'repriced'
//   any other tx at that nonce      -> resolves, that tx's receipt,      reason 'replaced'
//
// Nothing throws. viem 2 does not define TransactionReplacedError at all.
//
// A speed-up IS the action: the same call with more gas. So the check cannot be a
// bare hash comparison, which would tell a sped-up user their swap did not happen
// and invite a second one that pays twice. A receipt cannot tell a speed-up from
// a different call to the same contract, so the reason is viem's own: every
// receipt wait passes `onReplaced: noteReplacement`. A foreign receipt with no
// recorded reason is never a success, and is not called a cancel either.
// ─────────────────────────────────────────────────────────────────────────

/** viem's verdict, per submitted hash. A hash is replaced at most once. */
const replacementReasons = new Map<string, ReplacementReason>();

/**
 * Pass as `onReplaced` to every `useWaitForTransactionReceipt`. viem says WHY a
 * transaction was replaced only here, and calls it just before it resolves with
 * the replacement's receipt, so the reason is on record before any render sees
 * that receipt.
 */
export function noteReplacement(r: { reason: ReplacementReason; replacedTransaction: { hash: string } }): void {
  replacementReasons.set(r.replacedTransaction.hash.toLowerCase(), r.reason);
}

export type ReceiptReplacement = {
  /** The transaction that confirmed in place of the one submitted. */
  hash: `0x${string}`;
  /** viem's reason, or 'unknown' when no receipt wait recorded one. */
  reason: ReplacementReason | 'unknown';
};

/**
 * The transaction that confirmed in place of `submitted`, or null when `data` is
 * `submitted`'s own receipt (or there is no receipt yet).
 */
export function receiptReplacement(
  data: { transactionHash: string } | undefined,
  submitted: string | undefined,
): ReceiptReplacement | null {
  // wagmi's receipt always carries its hash. A shape without one names no other
  // transaction either, so it is not called a replacement (nor crashes a render).
  if (!data || typeof data.transactionHash !== 'string') return null;
  if (submitted && data.transactionHash.toLowerCase() === submitted.toLowerCase()) return null;
  return {
    hash: data.transactionHash as `0x${string}`,
    reason: (submitted && replacementReasons.get(submitted.toLowerCase())) || 'unknown',
  };
}

/** The subset of `useWaitForTransactionReceipt()` the outcome is derived from. */
export type ReceiptQueryLike = {
  data?: { status: string; transactionHash: string } | undefined;
  isSuccess: boolean;
  isError: boolean;
  error?: unknown;
};

/**
 * Split a receipt wait into the outcomes that need different words.
 *
 * `hash` is the hash the surface SUBMITTED, the one it passed to the wait. The
 * receipt only counts for the surface if it is that transaction's own.
 *
 * `isSuccess` — `hash`'s receipt came back and says success (or a speed-up of it did).
 * `isReverted` — the transaction reverted (thrown by wagmi, or a reverted receipt
 *   delivered as data, which wagmi 3 never does but costs nothing to honour).
 * `isReceiptUnreadable` — nothing is known. Never call this a failure.
 * `isReplaced` — another transaction confirmed at `hash`'s nonce: a cancel, a
 *   different call, or one whose reason was never recorded. What was sent did not
 *   run as sent. Terminal, like the other two.
 * `replacement` — set whenever the receipt is not `hash`'s own, a speed-up included.
 */
export function receiptOutcome(q: ReceiptQueryLike, hash: string | undefined): {
  isSuccess: boolean;
  isReverted: boolean;
  isReceiptUnreadable: boolean;
  isReplaced: boolean;
  replacement: ReceiptReplacement | null;
} {
  const thrownRevert = q.isError && isRevertedReceiptError(q.error);
  const isReverted = thrownRevert || (q.isSuccess && !!q.data && q.data.status !== 'success');
  const replacement = q.isSuccess ? receiptReplacement(q.data, hash) : null;
  const isReplaced = !isReverted && !!replacement && replacement.reason !== 'repriced';
  return {
    isSuccess: q.isSuccess && !isReverted && !isReplaced,
    isReverted,
    isReceiptUnreadable: q.isError && !thrownRevert,
    isReplaced,
    replacement,
  };
}

/** Toast surface this helper needs — sonner's `warning(title, opts)`. */
export type UnconfirmedToastLike = {
  warning: (msg: string, opts?: {
    id?: string;
    description?: string;
    duration?: number;
    action?: { label: string; onClick: () => void };
  }) => void;
};

/** `0x1234abcd…9876fedc` — enough to match against an explorer, short enough for a toast. */
export function shortHash(hash: string): string {
  return hash.length > 22 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

/**
 * Tell the user we could not confirm their transaction, and that we cannot tell
 * whether it went through.
 *
 * Measured 2026-09-10 by fault injection on an anvil fork: answering every
 * `eth_getTransactionReceipt` with `{result: null}` made an addLiquidityETH that
 * was MINED AND SUCCESSFUL toast "Transaction failed". "Failed" is an instruction
 * to resend, and a resent add, stake or swap pays twice.
 *
 * `repeatCost` completes "…before you send it again: if it landed, ___" and is
 * written per call site, because a duplicate add, swap and claim cost different
 * things.
 *
 * Deliberately `warning`, not `error`: nothing is known to have gone wrong.
 * Deliberately long-lived: the 4s the surrounding effects reset in is not long
 * enough to read this, let alone act on it.
 */
export function surfaceUnconfirmedTx(
  toast: UnconfirmedToastLike,
  opts: { hash: string; explorerUrl: string; repeatCost: string },
): void {
  toast.warning("We couldn't confirm this transaction", {
    id: `unconfirmed-${opts.hash}`,
    description:
      `${shortHash(opts.hash)} was sent, but we couldn't read its result, so we can't tell ` +
      `whether it went through. Check it on the explorer before you send it again: if it ` +
      `landed, ${opts.repeatCost}`,
    action: { label: 'Check on Explorer', onClick: () => window.open(opts.explorerUrl, '_blank') },
    duration: 30_000,
  });
}

/**
 * Tell the user that another transaction from their wallet confirmed in place of
 * the one they sent, so what they sent did not happen.
 *
 * Only for `receiptOutcome().isReplaced`. A speed-up is never passed here: it is
 * the same call, it ran, and saying otherwise invites a second one.
 *
 * `explorerUrl` should point at the REPLACEMENT, the transaction that did confirm.
 * With no recorded reason the copy makes no claim either way: the replacement may
 * be a speed-up, so the only honest advice is to look before sending again.
 */
export function surfaceReplacedTx(
  toast: UnconfirmedToastLike,
  opts: { hash: string; replacement: ReceiptReplacement; explorerUrl: string },
): void {
  const sent = shortHash(opts.hash);
  const took = shortHash(opts.replacement.hash);
  const { reason } = opts.replacement;
  const title = reason === 'cancelled' ? 'Transaction cancelled' : 'Transaction replaced';
  const description =
    reason === 'cancelled'
      ? `${sent} was cancelled in your wallet: an empty transaction (${took}) confirmed in its ` +
        `place, so what you sent did not happen.`
      : reason === 'replaced'
        ? `Your wallet replaced ${sent} with a different transaction (${took}), which confirmed ` +
          `in its place. What you sent did not happen as sent.`
        : `Another transaction from your wallet (${took}) confirmed in place of ${sent}. If you ` +
          `sped it up, it went through; if you cancelled or changed it, it did not. Check it on ` +
          `the explorer before you send it again.`;
  toast.warning(title, {
    id: `replaced-${opts.hash}`,
    description,
    action: { label: 'Check on Explorer', onClick: () => window.open(opts.explorerUrl, '_blank') },
    duration: 30_000,
  });
}
