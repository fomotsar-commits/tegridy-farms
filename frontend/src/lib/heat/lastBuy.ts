import { getActiveBungalow, type Bungalow } from '../bungalows';
import { safeGetItem, safeSetItem } from '../storage';

/**
 * WAVE SEVEN, element O: THE LATCH BEHIND THE COMMITMENT LINE.
 *
 * The island ruled the moment after a buy, and ruled it as a latch rather than
 * a toast: no timer, the line stays until the next submit or until the buyer
 * leaves the room, and "Post" becomes "Posted." once and stays that way.
 *
 * WHY STORAGE AND NOT PAGE STATE. The buy and the line are not always the same
 * render tree — the EVM rail writes this from `useSwap`'s success effect, which
 * serves both /swap and the terminal's quick-buy panel — and a page that
 * remounts mid-flow would otherwise forget a buy the buyer just made.
 *
 * "LEAVING THE ROOM" IS THE ROOM CHANGING, NOT A ROUTE CHANGE, and that is the
 * one place this departs from the ruling's words rather than its sense: no buy
 * completes inside a room. The buy happens on /swap or /solana, which are not
 * rooms, while the room itself is a persisted identity that follows the visitor
 * across every route. So the key carries the active bungalow id: walk into
 * another door and the latch is unreadable, which is what leaving is.
 *
 * NOTHING HERE READS THE NETWORK. The line's warm branch peeks at a reading the
 * venue already holds (heatClient.peekHeat); this module only remembers what
 * was bought, by whom, and whether the buyer has posted it.
 */
export interface LastBuy {
  /** The transaction that made it true. Also what makes a replay distinguishable. */
  hash: string;
  symbol: string;
  /** Token contract (EVM) or mint (Solana), verbatim from the buy. */
  tokenAddress: string;
  chain: Bungalow['chain'];
  /** The wallet that bought, which is the wallet whose clock the line is about. */
  buyer: string;
  atUnix: number;
  /** Set once, by the buyer's own click on the composer door. */
  posted: boolean;
}

const KEY_PREFIX = 'tf_last_buy:';

/** The venue's own id when no door is stored, so `/` has a key like any room. */
const VENUE_KEY = 'venue';

function storageKey(): string {
  return KEY_PREFIX + (getActiveBungalow()?.id ?? VENUE_KEY);
}

/**
 * Replace the latch. THIS IS ALSO HOW IT CLEARS: the next submit overwrites it,
 * and stepping into another door changes the key out from under it. There is no
 * remove() here because nothing needs one, and a clear nobody calls is a door
 * left open for a caller that does not exist.
 */
export function setLastBuy(buy: Omit<LastBuy, 'posted'>): void {
  safeSetItem(storageKey(), JSON.stringify({ ...buy, posted: false }));
}

/**
 * The latch for the room the visitor is in NOW, or null.
 *
 * A latch written in another room is not returned, and not deleted either: a
 * visitor who steps into a second door and back has not un-bought anything.
 */
export function readLastBuy(): LastBuy | null {
  const raw = safeGetItem(storageKey());
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastBuy>;
    if (!v || typeof v.hash !== 'string' || typeof v.symbol !== 'string') return null;
    if (typeof v.tokenAddress !== 'string' || typeof v.buyer !== 'string') return null;
    if (typeof v.atUnix !== 'number' || !Number.isFinite(v.atUnix)) return null;
    return {
      hash: v.hash,
      symbol: v.symbol,
      tokenAddress: v.tokenAddress,
      chain: (v.chain ?? 'ethereum') as Bungalow['chain'],
      buyer: v.buyer,
      atUnix: v.atUnix,
      posted: v.posted === true,
    };
  } catch {
    // A hand-edited or half-written entry is not a buy. Say nothing.
    return null;
  }
}

/** The buyer opened the composer. The door says "Posted." from here on. */
export function markLastBuyPosted(): void {
  const cur = readLastBuy();
  if (!cur || cur.posted) return;
  safeSetItem(storageKey(), JSON.stringify({ ...cur, posted: true }));
}
