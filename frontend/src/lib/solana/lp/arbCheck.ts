import { quoteOwnPool } from '../cpswap/read';
import { poolFeesOf } from './liquidityMath';
import type { LegQuote } from './outsidePrice';
import { ARB_FLOOR_USD, rowTokenFee, type Opportunity } from './poolList';

/**
 * A row of the Arbitrage card held to Jupiter's live quote, not its listed price, which on a
 * thin coin can sit points above what Jupiter pays. Like the price keeper's Jupiter trip:
 * buy here, then sell what came out on Jupiter; or buy on Jupiter with the coin the trade's
 * tokens are worth at the listed price, then sell what that buys here (the pool's maths).
 */

/** Rows checked, top of the listed ranking down: each is one Jupiter quote, and the site's key allows one request a second for everyone. */
export const ARB_CHECK_MAX = 5;

/** The other leg of a row's round trip, as Jupiter is asked for it: ExactIn, in base units. */
export interface OtherLeg {
  inputMint: string;
  outputMint: string;
  amount: bigint;
}

export function otherLeg(o: Opportunity, usd: ReadonlyMap<string, number>): OtherLeg | null {
  const { view, arb } = o;
  if (arb.side === 'buy') return { inputMint: view.tokenMint, outputMint: view.quote.mint, amount: arb.outAmount };
  const coinUsd = usd.get(view.quote.mint);
  const coins = coinUsd === undefined ? NaN : Math.floor((arb.tradeUsd / coinUsd) * 10 ** view.quote.decimals);
  if (!Number.isFinite(coins) || coins <= 0) return null;
  return { inputMint: view.quote.mint, outputMint: view.tokenMint, amount: BigInt(coins) };
}

/** The same leg asked for again is the same key: one answer per pool, direction and amount. */
export function legKey(pool: string, leg: OtherLeg): string {
  return `${pool}:${leg.inputMint}:${leg.outputMint}:${leg.amount}`;
}

/**
 * `unchecked`: not asked, or not read, so the row's figure stays at the listed price.
 * `profit` and `loss` carry the round trip's result in USD at the coin's price (a loss below zero).
 */
export type RowCheck = { kind: 'profit'; usd: number } | { kind: 'loss'; usd: number } | { kind: 'no-route' } | { kind: 'checking' } | { kind: 'unchecked' };

/**
 * `answer`: Jupiter's quote, 'checking' while it is asked, null when it is not asked. A quote
 * through one of our own pools (`ours`) is not an outside price, and counts as not read.
 */
export function rowCheck(
  o: Opportunity,
  leg: OtherLeg | null,
  answer: LegQuote | 'checking' | null,
  usd: ReadonlyMap<string, number>,
  chainNow: bigint | null,
  ours: ReadonlySet<string>,
): RowCheck {
  if (leg === null || answer === null) return { kind: 'unchecked' };
  if (answer === 'checking') return { kind: 'checking' };
  if (answer.kind === 'no-route') return { kind: 'no-route' };
  if (answer.kind === 'unread' || answer.pools.some((p) => ours.has(p))) return { kind: 'unchecked' };
  const { view, arb } = o;
  let back: bigint | null = answer.out;
  if (arb.side === 'sell') {
    const tokenFee = rowTokenFee(view, o.safety);
    if (!view.config || chainNow === null || tokenFee === 'unread') return { kind: 'unchecked' };
    back = quoteOwnPool(view.snapshot, view.config, view.tokenMint, answer.out, Number(chainNow), poolFeesOf(view.quoteIsToken0, tokenFee))?.outAmount ?? null;
  }
  const coinUsd = usd.get(view.quote.mint);
  if (back === null || coinUsd === undefined) return { kind: 'unchecked' };
  const paid = arb.side === 'buy' ? arb.amountIn : leg.amount;
  const made = (Number(back - paid) * coinUsd) / 10 ** view.quote.decimals;
  return made >= ARB_FLOOR_USD ? { kind: 'profit', usd: made } : { kind: 'loss', usd: made };
}

/**
 * What the card shows (owner, 2026-11-01: "only show actual profitable arbs not distractions"):
 * the round trips that pay, most first (ties by address), and only counts for the rest: still
 * being checked, within Jupiter's costs (a loss, or no route back), and not checked at all.
 */
export function paying<T extends { o: Opportunity; check: RowCheck }>(rows: readonly T[]): { rows: T[]; checking: number; within: number; unchecked: number } {
  const usd = (r: T) => (r.check.kind === 'profit' ? r.check.usd : 0);
  const count = (...kinds: RowCheck['kind'][]) => rows.filter((r) => kinds.includes(r.check.kind)).length;
  return {
    rows: rows.filter((r) => r.check.kind === 'profit').sort((a, b) => usd(b) - usd(a) || (a.o.view.address < b.o.view.address ? -1 : 1)),
    checking: count('checking'),
    within: count('loss', 'no-route'),
    unchecked: count('unchecked'),
  };
}
