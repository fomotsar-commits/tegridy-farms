// Confirming a sent Solana transaction, and saying honestly what was seen.
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
// only a status carrying an error is 'reverted'.
//
// Moved verbatim from lib/ladder/write.ts, which got this right first. The swap page
// kept its own copy that threw on a timeout and on a single RPC error, and called
// both "Swap failed".
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
    if (status) {
      if (status.err) return { outcome: 'reverted', slot: null };
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        const slot = typeof status.slot === 'number' && Number.isSafeInteger(status.slot) ? status.slot : null;
        return { outcome: 'confirmed', slot };
      }
    }
    if (now() - start >= timeoutMs) return { outcome: 'unknown', slot: null };
    await sleep(2_000);
  }
}
