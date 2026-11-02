import { SOL_MINT } from '../../solana';
import type { OutsidePrice } from './outsidePrice';

/**
 * ONE READ FOR EVERYONE (island answer twenty-four, build 1b). api/outside-prices.js prices
 * every listed pool's token once, paced to the key's plan, and Vercel's edge keeps the
 * answer for ten minutes past its age; a page reads that list and never asks Jupiter for a
 * listed token itself (`readListedOrOutsidePrice`). A price up to ten minutes old passes
 * the deposit check; only a token with no price in the last ten minutes holds the Add form,
 * in one row. A token the list does not carry (a coin with no pool here yet), a list that
 * did not answer, and every `fresh` read (the check run again at Review) use the two
 * quotes below, as before.
 */
export const SHARED_PRICES_PATH = '/api/outside-prices';
export const FRESH_FOR_MS = 10 * 60_000;
/** A page re-asks the list this often at most; the edge answers the repeats. */
export const SHARED_FOR_MS = 20_000;
export type SharedEntry =
  | { state: 'ok'; sol_per_token: number; read_at: number }
  | { state: 'no-route'; read_at: number }
  | { state: 'unread'; detail: string; last: { sol_per_token: number; read_at: number } | null };
export interface SharedPrices {
  read_at: number;
  prices: Record<string, SharedEntry>;
  /** Every listed token's dollar price and SOL's, from the loop's one price/v3 call; null when it could not be read. */
  usd?: Record<string, number> | null;
  usd_read_at?: number | null;
  /** The mints that call asked about: one of them missing from `usd` has no price at Jupiter, which is an answer. */
  usd_asked?: string[] | null;
}

let shared: { at: number; answer: Promise<SharedPrices | null> } | null = null;
/** This tab's last good read per token: the list's `last` is one server instance's memory; this is ours. */
const remembered = new Map<string, { solPerToken: number; readAtMs: number }>();
/** Tests only. */
export function __resetSharedPrices(): void {
  shared = null;
  remembered.clear();
}

/** The list, once per SHARED_FOR_MS per tab, every caller sharing the read in flight. Null when it did not answer; never throws. */
export function readSharedPrices(fetchImpl: typeof fetch = fetch, nowMs = Date.now()): Promise<SharedPrices | null> {
  if (shared && nowMs - shared.at < SHARED_FOR_MS) return shared.answer;
  const answer = (async (): Promise<SharedPrices | null> => {
    try {
      const res = await fetchImpl(SHARED_PRICES_PATH, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<SharedPrices> | null;
      if (!body || typeof body.read_at !== 'number' || !body.prices || typeof body.prices !== 'object') return null;
      const usd = body.usd && typeof body.usd === 'object' ? body.usd : null;
      const asked = Array.isArray(body.usd_asked) ? body.usd_asked.filter((m): m is string => typeof m === 'string') : null;
      return { read_at: body.read_at, prices: body.prices, usd, usd_read_at: typeof body.usd_read_at === 'number' ? body.usd_read_at : null, usd_asked: asked };
    } catch {
      return null;
    }
  })();
  const mine = { at: nowMs, answer };
  shared = mine;
  // A list that answered nothing is not kept: the next ask tries again.
  void answer.then((a) => {
    if (a === null && shared === mine) shared = null;
  });
  return answer;
}

/** How long ago a price was read, as a row says it: "read 40 s ago", "read 3 min ago". */
export function readAgo(readAtMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - readAtMs) / 1000));
  return s < 60 ? `read ${s} s ago` : `read ${Math.round(s / 60)} min ago`;
}

/**
 * The list's entry for one token as a price. Ok when a read is at most ten minutes old (the
 * list's, the list's last good, or this tab's own); no-route is Jupiter's answer; anything
 * older is the one-row hold. Null for a token the list does not carry.
 */
export function fromShared(entry: SharedEntry | undefined, mint: string, nowMs = Date.now()): OutsidePrice | null {
  if (!entry) return null;
  if (entry.state === 'no-route') return { kind: 'no-route', detail: 'Jupiter has no route for this token' };
  type Read = { solPerToken: number; readAtMs: number };
  const listed: Read | null =
    entry.state === 'ok'
      ? { solPerToken: entry.sol_per_token, readAtMs: entry.read_at }
      : entry.last
        ? { solPerToken: entry.last.sol_per_token, readAtMs: entry.last.read_at }
        : null;
  const usable = (c: Read | null): c is Read => c !== null && Number.isFinite(c.solPerToken) && c.solPerToken > 0 && Number.isFinite(c.readAtMs);
  const mine = remembered.get(mint) ?? null;
  const best = [listed, mine].filter(usable).sort((a, b) => b.readAtMs - a.readAtMs)[0] ?? null;
  if (best && nowMs - best.readAtMs <= FRESH_FOR_MS) {
    remembered.set(mint, best);
    return { kind: 'ok', solPerToken: best.solPerToken, source: 'Jupiter', readAtMs: best.readAtMs };
  }
  const detail = best
    ? `Outside price not read for ${Math.max(1, Math.round((nowMs - best.readAtMs) / 60_000))} min; adding waits`
    : `Outside price not read (${entry.state === 'unread' ? entry.detail : 'no usable price'}); adding waits`;
  return { kind: 'unread', detail, hold: true };
}

/**
 * Dollar prices from the shared list (the loop's one price/v3 call), for every $ figure a
 * page shows. `prices` holds what the loop read; a mint the loop asked about and Jupiter did
 * not price is left out, as price/v3 leaves it out; `unknown` names the mints the loop never
 * asked about (a coin outside the venue's pools), for the caller to read itself. Null when
 * the list is absent or its dollar read is over ten minutes old.
 */
export async function listedUsdPrices(
  mints: readonly string[],
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now(),
): Promise<{ prices: Record<string, number>; unknown: string[] } | null> {
  const ids = [...new Set(mints.filter(Boolean))];
  const list = await readSharedPrices(fetchImpl);
  if (!list?.usd || typeof list.usd_read_at !== 'number' || nowMs - list.usd_read_at > FRESH_FOR_MS) return null;
  const asked = new Set(list.usd_asked ?? Object.keys(list.usd));
  const prices: Record<string, number> = {};
  const unknown: string[] = [];
  for (const m of ids) {
    const v = list.usd[m];
    if (typeof v === 'number' && v > 0) prices[m] = v;
    else if (!asked.has(m)) unknown.push(m);
  }
  return { prices, unknown };
}


/** The shared list's price for one token, or null when the list does not carry it or did not answer. Never throws. */
export async function listedOutsidePrice(mint: string, fetchImpl: typeof fetch = fetch): Promise<OutsidePrice | null> {
  if (mint === SOL_MINT) return null;
  const list = await readSharedPrices(fetchImpl);
  return list ? fromShared(list.prices[mint], mint) : null;
}
