import { FEE_RATE_DENOMINATOR } from '../cpswap/math';
import { minuteText } from './format';
import { LEDGER_COPY } from './ledger';
import { isqrt } from './liquidityMath';
import { paceText, percentText } from './pace';
import type { PoolView } from './poolFinder';
import { lastTrade, lastTradeText } from './poolPast';

/**
 * How much more backs one share than at opening: isqrt(coin reserve x token reserve) less
 * lp_supply, over lp_supply. Reserves are the vaults less the venue, fund and creator counters.
 * Zero at opening: initialize.rs sets lp_supply to that very root. It never falls: a swap must
 * leave the product no lower (swap_base_input.rs require_gte) and the LPs' part of the fee stays
 * on top; deposit.rs rounds what it takes up, withdraw.rs what it pays down. So it rises with
 * fees, with tokens sent straight to a vault, and by a few units of rounding on every deposit.
 */
export function shareGrowth(view: PoolView): { growth: bigint; supply: bigint } | null {
  const supply = view.snapshot.pool.lpSupply;
  if (supply <= 0n || view.quoteReserve <= 0n || view.tokenReserve <= 0n) return null;
  const growth = isqrt(view.quoteReserve * view.tokenReserve) - supply;
  // Below zero cannot come from a pool this program opened: no figure, never a negative one.
  return growth < 0n ? null : { growth, supply };
}

/**
 * Can trades account for the pool's growth? The one trace of fees its state keeps is the
 * venue's uncollected cut on each side (calculator.rs: the trade fee x the protocol rate);
 * the LPs' part of those trades is that cut x (1 - venue and fund share) / venue share.
 * True when taking that part back out of the reserves undoes at least half the growth.
 * Tokens sent to a vault, a collected cut or a tier with no cut leave it false: no pace
 * is said then, because "Past trades" could not be shown to be true.
 */
export function tradesExplain(view: PoolView): boolean {
  const g = shareGrowth(view);
  const cfg = view.config;
  if (!g || g.growth === 0n || !cfg || cfg.protocolFeeRate <= 0n) return false;
  const lpShare = FEE_RATE_DENOMINATOR - cfg.protocolFeeRate - cfg.fundFeeRate;
  if (lpShare <= 0n) return false;
  const p = view.snapshot.pool;
  const lpPart = (cut: bigint): bigint => (cut * lpShare) / cfg.protocolFeeRate;
  const [coinCut, tokenCut] = view.quoteIsToken0 ? [p.protocolFeesToken0, p.protocolFeesToken1] : [p.protocolFeesToken1, p.protocolFeesToken0];
  const left = (reserve: bigint, fees: bigint): bigint => (fees >= reserve ? 0n : reserve - fees);
  const without = isqrt(left(view.quoteReserve, lpPart(coinCut)) * left(view.tokenReserve, lpPart(tokenCut)));
  return (isqrt(view.quoteReserve * view.tokenReserve) - without) * 2n >= g.growth;
}

/** What the pool card says its shares have earned. The card prints these and nothing of its own. */
export interface PoolEarned {
  /** When the pool last traded, that no trade has reached it, or that its record could not be read. */
  trade: string;
  /** What each share has grown since the pool opened; null when no measure can be said. */
  growth: string | null;
  /** pace.ts's sentence for that growth over the time since the pool opened, by the chain's clock. */
  pace: string | null;
}

export const POOL_FEES_TOO_SMALL = 'The fees so far are too small to show.';

/**
 * Needs no history read: the pool state, its two vaults and its price record are read with
 * every pool (poolFinder.ts). Growth is called fees only when the record shows a trade
 * (`lastTrade`): before the first swap the ratio is already a hair over zero from deposit
 * rounding, so "no fees yet" is the record's answer, never a test for zero. An unread record
 * gets no figure, and a growth trades cannot account for gets no pace (`tradesExplain`).
 * `open_time` is when the pool's swaps opened, at or after its creation.
 */
export function poolEarned(view: PoolView, chainNow: bigint | null): PoolEarned | null {
  if (view.history.kind === 'not-read') return null;
  const trade = lastTrade(view);
  if (trade.kind === 'none') return { trade: LEDGER_COPY.noTradeYet, growth: null, pace: null };
  const said: PoolEarned = { trade: lastTradeText(trade), growth: null, pace: null };
  if (trade.kind === 'unread') return said;
  const g = shareGrowth(view);
  const opened = Number(view.snapshot.pool.openTime);
  // A date no calendar holds is not printed (Date throws past 8.64e15 ms).
  if (!g || !Number.isSafeInteger(opened) || opened * 1000 > 8.64e15) return said;
  const percent = percentText(g.growth, g.supply);
  if (percent === null) return { ...said, growth: POOL_FEES_TOO_SMALL };
  return {
    trade: said.trade,
    growth: `Since this pool opened on ${minuteText(opened)}, each share has grown ${percent} from trading fees and anything else sent into the pool.`,
    pace: chainNow === null || !tradesExplain(view) ? null : paceText({ growth: g.growth, against: g.supply, seconds: Number(chainNow) - opened }),
  };
}
