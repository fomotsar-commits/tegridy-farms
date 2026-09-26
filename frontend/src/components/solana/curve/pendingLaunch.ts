// A per-viewer note of "I just sent a launch for this mint", kept so the launch page
// can say "not found yet, it may still be landing" instead of "no such launch".
//
// sessionStorage, and only as a convenience: it can be empty, blocked or throw (a
// private window, cleared site data), and the page must still be right without it.
// The chain is the truth; this only changes the words shown while the chain has
// not caught up.

const KEY = 'curve-launch:pending:';
/** Past this, a pending note is ignored: a launch that has not landed by now will not. */
export const PENDING_TTL_MS = 10 * 60_000;

export interface PendingLaunch {
  signature: string;
  sentAt: number;
  /** The blockhash window of the sent transaction, so a later check can say "expired". */
  lastValidBlockHeight: number | null;
}

export function savePendingLaunch(
  mint: string,
  signature: string,
  lastValidBlockHeight: number | null,
  now: number = Date.now(),
): void {
  try {
    sessionStorage.setItem(KEY + mint, JSON.stringify({ signature, sentAt: now, lastValidBlockHeight }));
  } catch {
    /* storage unavailable: the page still works, it just cannot say "still landing" */
  }
}

export function readPendingLaunch(mint: string, now: number = Date.now()): PendingLaunch | null {
  try {
    const raw = sessionStorage.getItem(KEY + mint);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingLaunch>;
    if (typeof v.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v.signature)) return null;
    if (typeof v.sentAt !== 'number' || now - v.sentAt > PENDING_TTL_MS || v.sentAt > now + 60_000) return null;
    const lvbh =
      typeof v.lastValidBlockHeight === 'number' && Number.isSafeInteger(v.lastValidBlockHeight) && v.lastValidBlockHeight > 0
        ? v.lastValidBlockHeight
        : null;
    return { signature: v.signature, sentAt: v.sentAt, lastValidBlockHeight: lvbh };
  } catch {
    return null;
  }
}

export function clearPendingLaunch(mint: string): void {
  try {
    sessionStorage.removeItem(KEY + mint);
  } catch {
    /* nothing to clear */
  }
}
