// Which route a Solana swap takes: one of our own pools, or Jupiter. Pure: every input
// was read elsewhere; nothing here fetches, signs, or knows what a wallet is.
//
// The same functions run twice: when a quote is shown (on the pool finder's read), and
// inside the transaction builder at send time (on its own one-slot read). Only the
// builder's answer moves money.
//
// THE RULES, in the order they are applied:
//   1. Which pools may compete at all (`routeExclusion`). Every fact is read from the
//      chain, and a fact that could not be read EXCLUDES the pool. It never admits it.
//   2. What a pool pays for this trade (`routeQuote`): the pool's OWN fee settings, the
//      CHAIN's clock, and the site's 0.5% fee taken off on the same side Jupiter takes
//      it (the SOL side). This is the one place that fee is taken off.
//   3. The best of our pools (`bestOwn`): one pool per swap, never a split.
//   4. Ours against Jupiter (`decideRoute`): the higher amount after the same fee wins,
//      a tie is ours, and there is no band. Our pool NEVER competes against nothing:
//        - Jupiter unread: no route at all;
//        - Jupiter's number not proven to be "after our fee": Jupiter runs, ours does
//          not compete;
//        - Jupiter answered "no route": only the token's launch pool may run, and only
//          while its price is provably its own (`launchPriceProblem`): it has never
//          traded and still holds exactly what its shares account for, or it has traded
//          steadily for the whole of the last half hour and its price agrees with that
//          average. A pool anyone could open is never routed to on its own, because its
//          opener set its price.
//      And ours competes only on a pair whose site fee is taken in SOL, against a
//      Jupiter trade that really carries that fee (`jupiterSideOf`).

import type { PublicKey } from '@solana/web3.js';
import { jupiterNet, pickFeeMint, type QuoteRead } from '../../jupiter';
import { applySlippage, isU64 } from '../../launcher/solana/curve/math';
import { POOL_STATUS_DISABLE_SWAP, deriveAmmConfig, swapEnabled } from '../cpswap/program';
import { quoteOwnPool, type OwnPoolQuote } from '../cpswap/read';
import { recordSilence } from '../lp/ownPrice';
import type { PoolView } from '../lp/poolFinder';
import { assessPool, formatWhen, tokenReasons } from '../lp/poolHealth';
import { WSOL_MINT, type TokenSafety } from '../lp/tokenSafety';
import { chooseRoute } from '../route';
import { siteFee } from './siteFee';

export interface RouteQuote {
  side: 'buy' | 'sell';
  /** The site fee the transaction carries. Buy: siteFee(amountIn). Sell: siteFee(minOut). */
  fee: bigint;
  /** What goes into the pool. Buy: amountIn - fee. Sell: amountIn. */
  swapIn: bigint;
  /** The pool's output for `swapIn` (on a sell: SOL before the site fee). */
  quoteOut: bigint;
  /** applySlippage(quoteOut, slippageBps): the pool program's minimum_amount_out. */
  minOut: bigint;
  /** The RANKING number. Buy: quoteOut. Sell: quoteOut - siteFee(quoteOut). */
  netExpected: bigint;
  /** The least the trader ends up with if the swap lands. Buy: minOut. Sell: minOut - fee. */
  netGuaranteed: bigint;
  /** The pool's own breakdown, for the pool-fee, creator-fee and impact rows. */
  quote: OwnPoolQuote;
}

/**
 * What this pool pays for this trade after the site fee, or null when there is nothing
 * honest to say: its fee settings are unread, the amount is not a positive u64, the
 * pool program would refuse (switched off, not open at the CHAIN's time, a fee mode we
 * cannot price, arithmetic it aborts on), the output or the minimum rounds to 0, or the
 * site fee rounds to 0 (Jupiter charges 0 there too; such an amount is never ours).
 *
 * WHY A SELL RANKS ON `quoteOut - siteFee(quoteOut)` WHILE THE TRANSACTION CHARGES
 * `siteFee(minOut)`: the fee in the transaction must be an exact number the checker can
 * recompute from the bytes, and the only output amount in the bytes is the minimum. That
 * charges slightly LESS than 0.5% of what arrives. Ranking on the fee Jupiter would take
 * at the quote keeps that small undercharge from ever winning us a trade.
 */
export function routeQuote(view: PoolView, side: 'buy' | 'sell', amountIn: bigint, slippageBps: bigint, chainNow: bigint): RouteQuote | null {
  if (view.config === null) return null;
  if (amountIn <= 0n || !isU64(amountIn)) return null;
  // The chain's clock, compared exactly here; never this device's clock, which
  // quoteOwnPool would fall back to if it were not handed a time.
  if (chainNow < view.snapshot.pool.openTime) return null;
  const now = Number(chainNow);
  if (!Number.isSafeInteger(now)) return null;

  const buy = side === 'buy';
  const buyFee = buy ? siteFee(amountIn) : 0n;
  const swapIn = amountIn - buyFee;
  if (swapIn <= 0n) return null;

  const quote = quoteOwnPool(view.snapshot, view.config, buy ? WSOL_MINT : view.tokenMint, swapIn, now);
  if (!quote) return null;
  const quoteOut = quote.outAmount;
  if (quoteOut <= 0n) return null;
  const minOut = applySlippage(quoteOut, slippageBps);
  if (minOut === null || minOut <= 0n) return null;

  const fee = buy ? buyFee : siteFee(minOut);
  if (fee <= 0n) return null;

  return {
    side,
    fee,
    swapIn,
    quoteOut,
    minOut,
    netExpected: buy ? quoteOut : quoteOut - siteFee(quoteOut),
    netGuaranteed: buy ? minOut : minOut - fee,
    quote,
  };
}

/** 0 or 1 when `configAddress` is the pool program's fee tier 0 or 1 (derived, never read); null otherwise. */
export function routedTier(cp: PublicKey, configAddress: string): 0 | 1 | null {
  if (configAddress === deriveAmmConfig(cp, 0).toBase58()) return 0;
  if (configAddress === deriveAmmConfig(cp, 1).toBase58()) return 1;
  return null;
}

/** Said when `routeQuote` is null for the amount (the caller knows the amount; `routeExclusion` does not). */
export const ROUTE_TOO_SMALL = 'it can’t take an amount this size';

/**
 * Is the site fee on TOKEN/SOL taken in SOL? Jupiter's route takes it in USDC whenever
 * USDC is on either side (lib/jupiter.ts pickFeeMint), and our route can only take it in
 * wrapped SOL. So a USDC/SOL pool is never ours: the fee would land on another side and
 * in another account than on Jupiter's route (SPEC_S3 D3).
 */
export function siteFeeIsInSol(tokenMint: string): boolean {
  return pickFeeMint(WSOL_MINT, tokenMint) === WSOL_MINT && pickFeeMint(tokenMint, WSOL_MINT) === WSOL_MINT;
}

/** Said by `routeExclusion` and by the builder for a pair `siteFeeIsInSol` refuses. */
export const ROUTE_FEE_NOT_IN_SOL = 'the site fee on this pair is taken in USDC, not in SOL';

/**
 * Why this pool may not take a routed swap, in plain words that finish "Our pool can't
 * take this trade right now: …"; null when it may. The first reason that applies.
 *
 * `chainNow` null = the clock was not read. `safety` null = the token was not read.
 * `demoted` = pools a swap of ours landed in and reverted on price this session.
 */
export function routeExclusion(
  view: PoolView,
  a: { cp: PublicKey; chainNow: bigint | null; safety: TokenSafety | null; demoted: ReadonlySet<string> },
): string | null {
  const { pool } = view.snapshot;
  if (!siteFeeIsInSol(view.tokenMint)) return ROUTE_FEE_NOT_IN_SOL;
  if (!swapEnabled(pool)) return 'swaps are switched off on it';
  // Any other bit, known or not. The program only checks the swap bit on a swap, but a
  // pool whose admin has switched deposits or withdrawals off is not one to send trades to.
  if ((pool.status & ~POOL_STATUS_DISABLE_SWAP) !== 0) return 'the pool program’s admin has changed its settings';
  if (a.chainNow === null) return 'the network clock could not be read';
  if (a.chainNow < pool.openTime) return `it does not open for trading until ${formatWhen(pool.openTime)}`;
  if (view.vaultsFrozen) return 'one of its vaults is frozen by the token’s issuer';
  if (view.solReserve <= 0n || view.tokenReserve <= 0n) return 'it is empty on one side';
  if (view.config === null) return 'its fee settings could not be read';
  if (routedTier(a.cp, pool.ammConfig) === null) return 'it is on a fee tier this site does not route to';
  if (pool.creatorFeeOn !== 0 && pool.creatorFeeOn !== 1 && pool.creatorFeeOn !== 2) return 'it uses a fee mode this site cannot price';
  const token = tokenReasons(a.safety, 'swaps');
  const tokenReason = token.refused[0] ?? token.unchecked[0];
  if (tokenReason !== undefined) return tokenReason;
  if (a.demoted.has(view.address)) return 'a swap through it just failed on price, so it is skipped for now';
  return null;
}

export interface OwnCandidate {
  view: PoolView;
  q: RouteQuote;
}

/**
 * The one pool of ours that competes: the most `netExpected`. On an exact tie: the
 * launch pool (only the launch program can open it), then the larger SOL side, then the
 * lower address, so the answer never depends on the order the pools were read in.
 */
export function bestOwn(c: readonly OwnCandidate[]): OwnCandidate | null {
  let best: OwnCandidate | null = null;
  for (const x of c) {
    if (best === null || beats(x, best)) best = x;
  }
  return best;
}

function beats(a: OwnCandidate, b: OwnCandidate): boolean {
  if (a.q.netExpected !== b.q.netExpected) return a.q.netExpected > b.q.netExpected;
  const aLaunch = a.view.origin === 'launch-pool';
  const bLaunch = b.view.origin === 'launch-pool';
  if (aLaunch !== bLaunch) return aLaunch;
  if (a.view.solReserve !== b.view.solReserve) return a.view.solReserve > b.view.solReserve;
  return a.view.address < b.view.address;
}

/**
 * A launch pool that has never traded must still hold what its shares account for.
 * The pool program opens a pool with `lp_supply = floor(sqrt(side0 x side1))`, and a
 * deposit or a withdrawal moves both sides and the shares together, so until the first
 * swap `side0 x side1` stays at `lp_supply^2` (a hair above, from rounding in the pool's
 * favour). Tokens or SOL sent STRAIGHT into a vault raise the product and move the
 * price without a trade; this tolerance is the most such a transfer may have moved it.
 */
export const UNTRADED_RESERVES_TOLERANCE_BPS = 10n;

export function reservesMatchShares(view: PoolView): boolean {
  const lp = view.snapshot.pool.lpSupply;
  if (lp <= 0n || view.solReserve <= 0n || view.tokenReserve <= 0n) return false;
  const product = view.solReserve * view.tokenReserve;
  const shares = lp * lp;
  // Below the shares is a state the pool program never produces: unread, not fine.
  return product >= shares && product * 10_000n <= shares * (10_000n + UNTRADED_RESERVES_TOLERANCE_BPS);
}

/**
 * A traded launch pool's average counts only while it traded steadily: no stretch
 * without a recorded swap longer than a sixth of the window (5 minutes of 30). A price
 * moved inside such a stretch is then at most a sixth of the average, so a move past
 * about 3.6% still shows as more than the 3% tolerance (lp/ownPrice.ts recordSilence).
 */
export const LAUNCH_MAX_SILENCE_DIVISOR = 6n;

export type LaunchPriceProblem =
  | 'not-launch-pool'
  /** The token, its decimals, the clock or the pool's price record could not be read or used. */
  | 'unread'
  /** More than 3% from its own average over the last half hour. */
  | 'disagrees'
  /** Never traded, yet its two sides no longer match its shares. */
  | 'reserves-moved'
  /** It agrees with its average, but the average has a long stretch with no trade in it. */
  | 'too-quiet';

/**
 * Why the token's launch pool may NOT run when Jupiter has no route; null when it may.
 *
 * With no outside price, the only evidence that the pool's price is honest is the pool
 * itself, and its price can be moved WITHOUT a trade: its reserves are its vaults' live
 * balances, and a plain transfer into a vault leaves no mark in its price record. So
 * "agrees with its own average" and "has never traded" are not enough on their own:
 *   - never traded: its two sides must still match its shares (`reservesMatchShares`);
 *   - traded: within 3% of its half-hour average, AND that average must be made of
 *     steady trading (`LAUNCH_MAX_SILENCE_DIVISOR`). Time with no recorded swap is not
 *     evidence: the average fills it with whatever the price is now, and a dust swap
 *     after a transfer writes the moved price over the whole quiet stretch.
 * Anything unread is a problem, never a pass. Any pool but a launch pool is a problem.
 */
export function launchPriceProblem(view: PoolView, a: { chainNow: bigint | null; safety: TokenSafety | null }): LaunchPriceProblem | null {
  if (view.origin !== 'launch-pool') return 'not-launch-pool';
  if (a.safety?.kind !== 'read' || a.safety.facts === null) return 'unread';
  const { price } = assessPool({
    view,
    tokenDecimals: a.safety.facts.decimals,
    chainNow: a.chainNow,
    outside: { kind: 'no-route', detail: 'Jupiter has no route for this token' },
    safety: a.safety,
  });
  if (price.state === 'disagrees') return 'disagrees';
  if (price.state === 'no-trades-yet') return reservesMatchShares(view) ? null : 'reserves-moved';
  if (price.state !== 'agrees' || view.history.kind !== 'ok' || a.chainNow === null) return 'unread';
  const quiet = recordSilence(view.history.obs, a.chainNow);
  if (quiet === null) return 'unread';
  return quiet.longestSecs * LAUNCH_MAX_SILENCE_DIVISOR > quiet.windowSecs ? 'too-quiet' : null;
}

/** May the token's launch pool run when Jupiter has no route? (`launchPriceProblem` is null.) */
export function launchPriceOk(view: PoolView, a: { chainNow: bigint | null; safety: TokenSafety | null }): boolean {
  return launchPriceProblem(view, a) === null;
}

/** What Jupiter said, as the route rule sees it. `net` is lib/jupiter.ts jupiterNet(): proven to be after our fee. */
export type JupiterSide =
  | { kind: 'net'; net: bigint }
  /** A quote whose outAmount could not be proven to be "after our fee". */
  | { kind: 'meaning-unread' }
  /** Jupiter ANSWERED that it has no route (the proxy's 404 NO_ROUTE). */
  | { kind: 'no-route' }
  /** No answer: a 502, a 429, a network error, bad JSON. */
  | { kind: 'unread' };

/**
 * What the route rule may be told about Jupiter, from a quote read.
 *
 * `feeWaivedOnPair`: the page knows Jupiter's trade on this pair goes out WITHOUT the
 * site fee (jupiterFeeRetry.ts: Jupiter's own program refuses the fee on that route, so
 * the same trade is rebuilt with no fee and pays the trader about 0.5% more than the
 * fee-bearing quote says). The fee-bearing number is then not what Jupiter would pay,
 * and "after the same fee" would be untrue, so our pool does not compete: Jupiter runs.
 * The builder holds the same line at send time with a proof (jupiterFeeProbe.ts).
 */
export function jupiterSideOf(
  read: QuoteRead,
  asked: { inputMint: string; outputMint: string; amount: string },
  o: { feeWaivedOnPair: boolean },
): JupiterSide {
  if (read.kind === 'unread') return { kind: 'unread' };
  if (read.kind === 'no-route') return { kind: 'no-route' };
  if (o.feeWaivedOnPair) return { kind: 'meaning-unread' };
  const net = jupiterNet(read, asked);
  return net === null ? { kind: 'meaning-unread' } : { kind: 'net', net };
}

export type RouteChoice =
  /** `versus` null: Jupiter answered no-route (so there is no edge and no tie). `edge`: how much more ours pays, as a fraction of Jupiter's. */
  | { route: 'own'; own: OwnCandidate; versus: bigint | null; edge: number | null; tie: boolean }
  /** `own`: our best pool, when one was quoted. `edge`: how much more Jupiter pays, when the two were compared. */
  | { route: 'jupiter'; why: 'pays-more' | 'no-eligible-pool' | 'meaning-unread'; own: OwnCandidate | null; edge: number | null }
  | { route: 'none'; why: 'jupiter-unread' | 'no-route' };

/**
 * The route rule (the header's rule 4). `best` is `bestOwn` over the eligible, quoted
 * pools. `launch` is the eligible launch pool's candidate with `launchPriceOk`, or null.
 */
export function decideRoute(a: { best: OwnCandidate | null; launch: (OwnCandidate & { priceOk: boolean }) | null; jupiter: JupiterSide }): RouteChoice {
  const { best, launch, jupiter } = a;
  // A "net" that is not a positive amount is not a price. Treat it as unread rather
  // than let our pool win against nothing.
  if (jupiter.kind === 'unread' || (jupiter.kind === 'net' && jupiter.net <= 0n)) return { route: 'none', why: 'jupiter-unread' };
  if (jupiter.kind === 'meaning-unread') return { route: 'jupiter', why: 'meaning-unread', own: best, edge: null };
  if (jupiter.kind === 'no-route') {
    if (launch && launch.priceOk && launch.view.origin === 'launch-pool') {
      return { route: 'own', own: { view: launch.view, q: launch.q }, versus: null, edge: null, tie: false };
    }
    return { route: 'none', why: 'no-route' };
  }
  if (best === null) return { route: 'jupiter', why: 'no-eligible-pool', own: null, edge: null };

  // Both candidates present, always: chooseRoute picks a lone candidate.
  const d = chooseRoute([
    { venue: 'own-pool', outAmount: best.q.netExpected, label: 'our pool', poolAddress: best.view.address },
    { venue: 'aggregator', outAmount: jupiter.net, label: 'Jupiter' },
  ]);
  if (d.chosen?.venue === 'own-pool' && d.runnerUp?.venue === 'aggregator') {
    return { route: 'own', own: best, versus: jupiter.net, edge: d.edge, tie: best.q.netExpected === jupiter.net };
  }
  // Jupiter pays more. Also where an own quote of 0 would land (routeQuote never makes one).
  return { route: 'jupiter', why: 'pays-more', own: best, edge: d.runnerUp ? d.edge : null };
}
