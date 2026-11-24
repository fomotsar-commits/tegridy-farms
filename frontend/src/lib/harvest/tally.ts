// Harvest's totals bar (owner, 2026-11-14: "the bar that adds them all together plus shows %
// and daily yield"): per coin, the claims added up, and what the stake behind them earns a day.
//
// Pure, like types.ts: no chain code, so the Earn page can import it without loading Solana.
//
// ⚠️ ONE COIN, ONE SUM. Claims are added only to claims in the same coin: no price is read
// here, so a BAYLA amount and a PEPE amount have no sum. The daily figure and its yearly rate
// are not worked out here either: they arrive as the pool's reader stated them (HarvestEarning),
// or not at all.
import type { HarvestChain, HarvestClaim, HarvestEarning } from './types';

export interface TallyCoin {
  key: string;
  roomId: string;
  symbol: string;
  chain: HarvestChain;
  decimals: number;
  /** This coin's claims added up. Null when it has none in the list. */
  totalRaw: bigint | null;
  /** How many claims `totalRaw` adds up. */
  claims: number;
  /** The daily figures stated for this coin's pools: one per pool, never added across pools here. */
  earning: HarvestEarning[];
}

/**
 * The bar's rows: one per coin with something to add up or a daily figure to state, in the
 * order the claims run, then any coin that is only earning.
 *
 * A coin with a single claim and no daily figure is left out: its one row already says it, and
 * a "total" of one amount is a second line of the same words. A claim whose amount is in a
 * different number of decimals than its coin's others is never folded into their sum.
 */
export function harvestTally(claims: readonly HarvestClaim[], earning: readonly HarvestEarning[] = []): TallyCoin[] {
  const coins = new Map<string, TallyCoin>();
  const coinOf = (c: { roomId: string; symbol: string; chain: HarvestChain; decimals: number }) => {
    const key = `${c.chain}:${c.roomId}:${c.symbol}:${c.decimals}`;
    let coin = coins.get(key);
    if (!coin) {
      coin = { key, roomId: c.roomId, symbol: c.symbol, chain: c.chain, decimals: c.decimals, totalRaw: null, claims: 0, earning: [] };
      coins.set(key, coin);
    }
    return coin;
  };
  for (const c of claims) {
    const coin = coinOf(c);
    coin.totalRaw = (coin.totalRaw ?? 0n) + c.amountRaw;
    coin.claims += 1;
  }
  for (const e of earning) coinOf(e).earning.push(e);
  return [...coins.values()].filter((c) => c.claims >= 2 || c.earning.length > 0);
}
