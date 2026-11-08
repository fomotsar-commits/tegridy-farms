// One read of each Solana pool per dashboard load, shared by the board and Harvest (poolReads.ts):
// a read is shared while in flight and for HOLD_MS after it lands, as boardPrices holds prices.
// Only a whole answer is held; a failed or partly unread one is asked again by the next caller.
// No imports on purpose: stakesChanged.ts forgets through this file on every page.

export const HOLD_MS = 30_000;

type Held = { read: Promise<unknown>; landedAt: number | null };
const held = new Map<string, Held>();

/** The read held under `key`, or a new one from `make`, held once it lands whole. */
export function heldRead<T>(key: string, make: () => Promise<T>, whole: (answer: T) => boolean, now: () => number = Date.now): Promise<T> {
  const h = held.get(key);
  if (h && (h.landedAt === null || now() - h.landedAt < HOLD_MS)) return h.read as Promise<T>;
  const read = make();
  const mine: Held = { read, landedAt: null };
  held.set(key, mine);
  const drop = () => {
    if (held.get(key) === mine) held.delete(key);
  };
  read.then((answer) => {
    let keep = false;
    try {
      keep = whole(answer);
    } catch { /* an answer of a shape we cannot judge is not held */ }
    if (keep) mine.landedAt = now();
    else drop();
  }, drop);
  return read;
}

/** A staking note (a write, or the dashboard's Refresh) or a Check again: the next caller reads afresh. */
export function forgetHeldReads(): void {
  held.clear();
}
