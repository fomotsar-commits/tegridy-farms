import type { PoolView } from './poolFinder';
import { SOL_QUOTE, quoteCoin, type QuoteCoin } from './quotes';

/**
 * "PRICED IN X" (spec 2026-11-14, community quote coins, phase 1). A coin's community shares
 * /pools?mint=<the coin's whole address>; when that coin is a pairing coin, the pool list under
 * the finder shows every pool here priced in it, the oldest first, instead of every pool
 * (VenuePoolList.tsx). It filters the list the page already read (poolList.ts `listPools`, the
 * index's cached ?all=1 answer): no endpoint and no chain read of its own.
 */

/**
 * The coin whose "Priced in" list a ?mint= opens: any pairing coin but SOL, so USDC and the
 * island's coins. SOL ranks first (quotes.ts), so every pool that holds SOL is priced in SOL:
 * that is most of the venue, the full list already puts those pools first, and a SOL link is
 * refused by the finder anyway (mintInput.ts). Null for any other mint, and for none.
 */
export function pricedInCoin(mint: string | null): QuoteCoin | null {
  const coin = mint ? quoteCoin(mint) : null;
  return coin && coin.mint !== SOL_QUOTE.mint ? coin : null;
}

/**
 * The pools whose QUOTE side is `coin`, as each pool was read (quotes.ts `readPair` gave its
 * `quote`): a BOBO and BAYLA pool is priced in BAYLA, and BAYLA's own pool with SOL is not.
 * The oldest first, by the pool's `open_time` (the program sets it at or after the pool's
 * opening, so a pool whose trading starts later counts from then), then by address so the
 * order never shuffles. Whatever Jupiter's prices say: a pool cannot buy its way up this list.
 */
export function pricedInPools(pools: readonly PoolView[], coin: QuoteCoin): PoolView[] {
  return pools
    .filter((v) => v.quote.mint === coin.mint)
    .sort((a, b) => {
      const ta = a.snapshot.pool.openTime;
      const tb = b.snapshot.pool.openTime;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    });
}

/**
 * The address's query with no token in it: the list's "Every pool", back to every pool. The
 * LP door's `task` and `pool` go too, since they only ever name a token's pool.
 */
export function everyPoolSearch(search: string): string {
  const next = new URLSearchParams(search);
  for (const name of ['mint', 'task', 'pool']) next.delete(name);
  const s = next.toString();
  return s ? `?${s}` : '';
}
