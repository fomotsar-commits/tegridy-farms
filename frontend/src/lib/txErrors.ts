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

type ToastLike = {
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
 */
export function isUserRejection(err: unknown): boolean {
  if (err instanceof UserRejectedRequestError) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number; message?: string };
  if (e.code === 4001) return true; // EIP-1193 standard
  if (e.name === 'UserRejectedRequestError') return true;
  const msg = (e.message ?? '').toLowerCase();
  return msg.includes('user rejected') || msg.includes('user denied');
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
  // eslint-disable-next-line no-console
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
