// Confirming a sent Solana transaction, and saying honestly what was seen.
//
// ONE module for every sender that polls: the BAYLA ladder (lib/ladder/write.ts) and
// the swap page's five senders (swap, DCA place and cancel, limit place and cancel).
//
// ── CONFIRMATION IS POLLED, NOT SUBSCRIBED ──────────────────────────────────
// `connection.confirmTransaction` opens a websocket subscription. The browser talks
// to `/api/solrpc`, which is HTTPS-only: there is no wss origin, and the CSP has no
// entry for one. So confirmation polls `getSignatureStatuses`; the proxy's own rate
// limit is written around that cadence (api/solrpc.js).
//
// ⚠️ A FAILED POLL IS NOT A FAILED TRANSACTION. One RPC hiccup mid-flight must not be
// reported as a revert, and a watch that runs out proves nothing either: the
// transaction may still land. So this returns 'unknown' for both, never throws, and
// only a status carrying an error AT 'confirmed' OR 'finalized' is 'reverted'.
//
// ⚠️ AN ERROR SEEN AT 'processed' IS NOT AN ENDING EITHER. A 'processed' status is one
// node's view of a block that can still be dropped with its fork, and the same
// transaction can land later and succeed while its blockhash is valid. Saying
// "reverted" there invites a second buy on top of one that then lands. So while the
// status is only 'processed' (or names no level at all) this keeps polling, whatever
// `err` says.
//
// Moved from lib/ladder/write.ts, which got the first rule right first. The swap page
// kept its own copy that threw on a timeout and on a single RPC error, and called
// both "Swap failed". The second rule came from the swap path's own poller
// (lib/solana/swap/confirm.ts, #703), which this module replaced.
import type { Connection } from '@solana/web3.js';

export type ConfirmOutcome = { outcome: 'confirmed' | 'reverted' | 'unknown'; slot: number | null };

/**
 * Poll `signature` until it is confirmed (or finalized), reverted, or the clock runs out.
 *
 * `slot` is the slot the transaction CONFIRMED at (`value[0].slot`), or null when the
 * status did not carry one.
 */
export async function pollConfirm(
  conn: Pick<Connection, 'getSignatureStatuses'>,
  signature: string,
  timeoutMs = 60_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => number = () => Date.now(),
): Promise<ConfirmOutcome> {
  const start = now();
  for (;;) {
    const status = await (async () => {
      try {
        const r = await conn.getSignatureStatuses([signature]);
        return r?.value?.[0] ?? null;
      } catch {
        return null;
      }
    })();
    // Only a status the cluster has voted on is an ending, for a success AND for an error.
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      if (status.err) return { outcome: 'reverted', slot: null };
      const slot = typeof status.slot === 'number' && Number.isSafeInteger(status.slot) ? status.slot : null;
      return { outcome: 'confirmed', slot };
    }
    if (now() - start >= timeoutMs) return { outcome: 'unknown', slot: null };
    await sleep(2_000);
  }
}
