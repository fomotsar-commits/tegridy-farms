// THE WRITE-SLOT FENCE — one rule, shared by the ladder card and the lighthouse card.
//
// Same-slot makes a share's two inputs CONSISTENT; it does not make them RECENT. After
// your own confirmed write, a read served by an RPC node still behind that write is a
// consistent picture of the past: after an exit the true share (W-w)/(T-w) is below
// W/T, so the old pair over-reads. So the slot the write CONFIRMED at is held, keyed to
// the wallet that wrote, and a share basis is stale while its own slot is below it — or
// when EITHER slot is unknown. Fail closed: stale renders "updating…", never the old
// figure. A basis at or past the write's slot is a share again.
//
// (dc2a4578 introduced this on the ladder card inline; it lives here so the two cards
// cannot drift into two copies of it.)

/** How often a card re-reads while its share is fenced (so "updating…" cannot stick). */
export const FENCE_RETRY_MS = 15_000;

export interface WriteFence {
  /** The wallet that wrote (base58). A fence never applies to another wallet. */
  key: string;
  /** The slot the write CONFIRMED at, or null when that could not be read. */
  slot: number | null;
}

/** A slot as the RPC gave it, or null — never a guess. */
export function slotOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * True when a PRESENT share basis must not be shown for `walletKey`: a fence of this
 * wallet exists, and its slot, or the basis's, is unknown, or the basis is older.
 * (No basis at all is the caller's business — it already prints no share.)
 */
export function basisBehindWrite(
  fence: WriteFence | null,
  walletKey: string,
  basisSlot: number | null | undefined,
): boolean {
  if (fence === null || fence.key !== walletKey) return false;
  if (fence.slot === null) return true;
  if (typeof basisSlot !== 'number' || !Number.isSafeInteger(basisSlot)) return true;
  return basisSlot < fence.slot;
}

/**
 * The slot a signature confirmed at (getSignatureStatuses `value[0].slot`), or null
 * when the status carries none or the call fails. Null is not "no fence" — the card
 * treats it as stale.
 */
export async function confirmedSlotOf(
  conn: { getSignatureStatuses: (sigs: string[]) => Promise<{ value: ({ slot?: unknown } | null)[] } | null | undefined> },
  signature: string,
): Promise<number | null> {
  try {
    const st = await conn.getSignatureStatuses([signature]);
    return slotOrNull(st?.value?.[0]?.slot);
  } catch {
    return null;
  }
}
