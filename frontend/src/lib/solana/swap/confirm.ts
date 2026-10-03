// One honest wait for a signature that has ALREADY been sent.
//
// Once a wallet has returned a signature the swap may be on chain, so there
// are exactly three things this can truthfully say: it landed, the chain
// refused it, or we do not know yet. "We do not know" is never "failed": a
// trader told "failed" buys again and pays twice.
//
// The shape is SPEC_S3's `lib/solana/swap/confirm.ts` (step S1), which will
// also move the Limit and DCA sends onto it. Today only the Jupiter swap send
// in SolanaSwapPage uses it.

export type SignatureEnding = 'confirmed' | 'reverted' | 'unknown';

export type SignatureStatusReader = (
  sigs: string[],
) => Promise<{ value: Array<{ err: unknown; confirmationStatus?: string | null } | null> }>;

/**
 * Polls every 2 s by signature status (no websocket, so the RPC needs only an
 * https CSP entry). `err` counts only at confirmed or finalized; an `err` seen
 * at processed, and a read that throws, are not endings; the time limit is
 * 'unknown'. Never throws.
 */
export async function pollSignature(
  getSignatureStatuses: SignatureStatusReader,
  signature: string,
  o: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<SignatureEnding> {
  const timeoutMs = o.timeoutMs ?? 90_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const start = now();
  while (now() - start < timeoutMs) {
    try {
      const { value } = await getSignatureStatuses([signature]);
      const st = value[0];
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        return st.err ? 'reverted' : 'confirmed';
      }
    } catch {
      /* an unread status is not an ending: keep waiting */
    }
    await sleep(2000);
  }
  return 'unknown';
}
