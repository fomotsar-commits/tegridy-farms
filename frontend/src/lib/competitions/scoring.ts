// Season scoring: the indexer's swap rows, adapted onto the shared round-trip
// rule in legs.ts, plus the sentences the surfaces render.
//
// ─── THE RULE ────────────────────────────────────────────────────────────────
//
// A competitor who trades with themselves must not climb. Concretely, and this
// is the whole of it:
//
//   1. Only swaps that SPEND the season's quote token add to volume. A swap
//      spending anything else is counted as a trade and contributes nothing to
//      the total, because the indexer stores no rate and a cross-token sum would
//      be a number with no unit that still looked like money.
//
//   2. If a wallet reverses one of its own swaps on the same token pair inside
//      WASH_WINDOW_SECONDS — buys X with the quote token, then spends X back for
//      the quote token — BOTH legs are discarded. Not netted, not halved:
//      removed. A round trip moves no position and its only effect on a
//      volume board is the one the board must not reward.
//
// ─── NATIVE ETH AND WETH ARE ONE SIDE ────────────────────────────────────────
//
// SwapFeeRouter emits `address(0)` for the ETH leg of a native swap
// (contracts/src/SwapFeeRouter.sol:720 and :920 for ETH in, :790 and :983 for
// ETH out) and the real WETH address on its wrapped path (:837, :1047). Read
// literally, that made a WETH season blind to its own dominant path: an ETH-in
// buy spent "0x000…0", which is not the quote token, so it scored zero — and
// worse, an ETH-in buy followed by a sell back to WETH was keyed on two
// different pair strings, so the two halves of an obvious round trip never met
// and BOTH counted.
//
// `canonicalSide` folds the sentinel onto the quote token, and it is applied to
// the pair key as well as to the count. Doing only the count is the trap: the
// ETH leg starts scoring while the wash rule still cannot see the round trip,
// which is strictly worse than before.
//
// The alias is GATED on the season's quote actually being mainnet WETH.
// `address(0)` is an event sentinel meaning "the chain's native asset", not a
// registered token, and a season quoted in anything else must not absorb it.
//
// ─── AND WHAT THE RULE DOES NOT CATCH ────────────────────────────────────────
//
// Saying "wash-trade resistant" without saying where the resistance ends is the
// same failure as a fabricated figure, one level up. Two things get through, and
// `RESISTANCE_LIMITS` puts both on the page:
//
//   · TWO WALLETS. An indexed swap row records the trader and the router, never
//     a counterparty (indexer/ponder.schema.ts). One person operating two
//     addresses that trade against each other is invisible here, and no rule
//     written over this table can see them.
//   · SLOW ROUND TRIPS. A reversal outside the window is indistinguishable from
//     a position that was genuinely held and later exited, so it is left alone.
//     Widening the window would start erasing real trading instead.

import type { IndexedSwap } from '../indexer/queries';
import { rankLegs, washedLegIndices, WASH_WINDOW_SECONDS, type Leg } from './legs';
import type { Season } from './season';

export { WASH_WINDOW_SECONDS };

/**
 * The `address(0)` the router emits for a native-ETH leg.
 *
 * Not a token and never treated as one outside `canonicalSide`: it is the
 * event's way of saying "this side was the chain's own asset".
 */
export const NATIVE_SENTINEL = '0x0000000000000000000000000000000000000000';

/** Mainnet WETH, lowercased. The one quote whose native sentinel is an alias. */
const WETH_MAINNET = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

/**
 * The side a token belongs to for one season, lowercased.
 *
 * Everything is lowercased here because the indexer's rows are EVM hex and hex
 * is case-insensitive. This function is the ONLY place that decision is taken
 * for this source — the shared rule in legs.ts re-cases nothing.
 */
export function canonicalSide(token: string, season: Season): string {
  const lower = token.toLowerCase();
  if (lower !== NATIVE_SENTINEL) return lower;
  const quote = season.quoteToken.toLowerCase();
  return quote === WETH_MAINNET ? quote : lower;
}

export const RESISTANCE_RULE =
  'A swap and its reversal by the same wallet on the same token pair within one hour are both struck from the score. Selling back what you just bought moves no position, so it earns nothing here. Native ETH and WETH count as the same side, so a buy paid in ETH and a sell back to WETH is still a round trip.';

export const RESISTANCE_LIMITS =
  'Two limits, stated because a resistance claim without them is worse than none. One person using two wallets to trade against each other is not detectable from this data — an indexed swap records the trader and the router, never a counterparty. And a round trip slower than an hour is left alone, because it cannot be told apart from a position that was genuinely held.';

export const PNL_SCORING =
  'No profit-and-loss board is offered. Indexed swaps record what was spent and never what came back, so a season return cannot be computed for anybody — and a volume rank presented as a performance rank is the claim this page exists not to make.';

export interface CompetitorRow {
  wallet: string;
  /** Quote token spent, in its smallest unit, after the round-trip rule. */
  countedVolume: bigint;
  /** Swaps that survived the rule and spent the quote token. */
  countedTrades: number;
  /** Legs struck by the round-trip rule. Shown, never hidden. */
  washedLegs: number;
  /** Swaps spending something other than the quote token. Counted, never summed. */
  offQuoteTrades: number;
  lastTradeAt: bigint;
}

export interface Standings {
  season: Season;
  rows: CompetitorRow[];
  /** Rows read before scoring. */
  swapsRead: number;
  /** Legs struck across every competitor. */
  washedLegs: number;
  /**
   * The read filled its page, so the window was not fully covered. Totals are
   * floors and the ORDER is provisional — the wallet in first place is first
   * inside one page, which is not the same statement.
   */
  truncated: boolean;
  window: { from: bigint; to: bigint } | null;
}

export const TRUNCATED_NOTICE =
  'The read filled its page before covering the whole season, so these are partial totals over the newest slice of it. The ranking is provisional and a competitor missing from it has not been shown to be absent.';

/**
 * One indexed swap as a `Leg`.
 *
 * This is the whole of the indexer's dialect: wallets are EVM hex so they are
 * lowercased HERE (never inside the rule), the native sentinel is folded onto
 * the quote, and the unordered pair key is built from the canonical sides so
 * that a buy and its reversal produce the same key with opposite directions.
 *
 * `id` is the indexer's own row id, which is unique per log — the leg does not
 * need to invent one.
 */
export function swapToLeg(swap: IndexedSwap, season: Season): Leg {
  const tokenIn = canonicalSide(swap.tokenIn, season);
  const tokenOut = canonicalSide(swap.tokenOut, season);
  const low = tokenIn < tokenOut ? tokenIn : tokenOut;
  const high = tokenIn < tokenOut ? tokenOut : tokenIn;
  return {
    id: swap.id,
    wallet: swap.user.toLowerCase(),
    pairKey: `${low}|${high}`,
    direction: tokenIn === low ? 'a>b' : 'b>a',
    amount: swap.amountIn,
    counted: tokenIn === season.quoteToken.toLowerCase(),
    at: Number(swap.timestamp),
    txHash: swap.txHash,
  };
}

/**
 * Indices of the swaps struck by the round-trip rule.
 *
 * Takes the season because the native-ETH alias is season-dependent: the same
 * two swaps are a round trip under a WETH season and two unrelated trades under
 * any other.
 */
export function washedIndices(swaps: readonly IndexedSwap[], season: Season): Set<number> {
  return washedLegIndices(swaps.map((swap) => swapToLeg(swap, season)));
}

export interface ScoreOptions {
  season: Season;
  truncated: boolean;
}

export function scoreSeason(swaps: readonly IndexedSwap[], opts: ScoreOptions): Standings {
  const ranked = rankLegs(swaps.map((swap) => swapToLeg(swap, opts.season)));

  return {
    season: opts.season,
    rows: ranked.rows.map((row) => ({
      wallet: row.wallet,
      countedVolume: row.countedVolume,
      countedTrades: row.countedTrades,
      washedLegs: row.washedLegs,
      offQuoteTrades: row.uncountedTrades,
      lastTradeAt: BigInt(row.lastTradeAt),
    })),
    swapsRead: ranked.legsRead,
    washedLegs: ranked.washedLegs,
    truncated: opts.truncated,
    window: ranked.window ? { from: BigInt(ranked.window.from), to: BigInt(ranked.window.to) } : null,
  };
}
