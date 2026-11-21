// Send a transaction the wallet SIGNED (and did not send) through our own RPC, and watch
// it. Moved here from lib/solana/swap/islandBasketSol.ts (2026-11-17) so the staking cards
// and Claim all can use it without loading the basket's Jupiter code; that file re-exports it.
import { base58 } from '@scure/base';
import type { Connection, VersionedTransaction } from '@solana/web3.js';
import { pollConfirm, type ConfirmOutcome } from './confirm';

export const SEND_COPY = {
  tooSlow: 'It took too long to approve in your wallet, so it ran out of time. Nothing was sent for it.',
  refusedFirst: 'The network refused it before sending it, so nothing was sent for it.',
} as const;

/** The fee payer's signature on a signed transaction, or null when it is not signed. */
export function signatureOf(tx: VersionedTransaction): string | null {
  const s = tx.signatures[0];
  return s && s.some((b) => b !== 0) ? base58.encode(s) : null;
}

/** How often the same signed bytes are sent again while the chain has not answered. */
const RESEND_MS = 2_000;

/**
 * `reason`: the network's own words for a refusal at the first send, and its last log
 * lines, when it gave them (null: it gave none). The swap says them; the basket's row keeps `why`.
 */
export type SendRefusal = { message: string; logs: readonly string[] } | null;
/** `slot`: the slot it confirmed at, when the status carried one (lib/solana/confirm.ts). */
export type SentLeg =
  | { kind: 'not-sent'; why: string; reason?: SendRefusal }
  | { kind: 'sent'; outcome: ConfirmOutcome['outcome']; slot?: number | null };

/** A send error's own message and logs (web3.js SendTransactionError: `transactionLogs`, or `logs`), or null when it has none. */
function refusalOf(e: unknown): SendRefusal {
  const o = (typeof e === 'object' && e !== null ? e : {}) as { transactionMessage?: unknown; transactionLogs?: unknown; logs?: unknown; message?: unknown };
  const message = typeof o.transactionMessage === 'string' ? o.transactionMessage : typeof o.message === 'string' ? o.message : '';
  const raw = Array.isArray(o.transactionLogs) ? o.transactionLogs : Array.isArray(o.logs) ? o.logs : [];
  const logs = raw.filter((l): l is string => typeof l === 'string');
  return message || logs.length ? { message, logs } : null;
}

/** Injected so tests neither sleep nor read the wall clock. */
export interface WatchDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The first send runs the network's own check (preflight on): a refusal there never
 * reached the chain, and is `not-sent`. After that, the same bytes go again every
 * RESEND_MS until the chain answers or `timeoutMs` runs out (same bytes, same signature:
 * a re-send can never pay twice). Any other error at the first send may have come after
 * the RPC passed it on, so it is watched, never said to be "not sent". Never throws.
 */
export async function sendSigned(
  conn: Pick<Connection, 'sendRawTransaction' | 'getSignatureStatuses'>,
  raw: Uint8Array,
  signature: string,
  timeoutMs: number,
  deps: WatchDeps = {},
): Promise<SentLeg> {
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    if (/Blockhash not found/i.test(msg)) return { kind: 'not-sent', why: SEND_COPY.tooSlow, reason: refusalOf(e) };
    if (/simulation failed|preflight/i.test(msg) && !/already been processed/i.test(msg)) return { kind: 'not-sent', why: SEND_COPY.refusedFirst, reason: refusalOf(e) };
  }
  const again = setInterval(() => { void conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); }, RESEND_MS);
  try {
    const { outcome, slot } = await pollConfirm(conn, signature, timeoutMs, deps.sleep, deps.now);
    return { kind: 'sent', outcome, slot };
  } finally {
    clearInterval(again);
  }
}
