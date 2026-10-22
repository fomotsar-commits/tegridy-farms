import { NoRouteError, type JupiterQuote, type PriorityLevel, type SwapSimulation } from '../../jupiter';
import { minOut, type SolBasketCoin } from '../../islandBasket';
import { prepareJupiterSwap, refusedSaid, NOT_TEST_RUN_COPY, type FeeRetryDeps } from './jupiterFeeRetry';
import { freshDecision } from './ownPoolRoute';
import type { VenuePoolCandidate } from './venuePools';

/**
 * One coin of the island order on Solana, up to the wallet. Each coin is bought in its
 * own transaction, built and test-run just before its own wallet prompt, so no blockhash
 * waits on the others. Jupiter is asked for ONE hop on the DEX of the pool the list
 * names (lib/islandBasket.ts), and an answer through any other pool is refused: a
 * migrated or stray pool is never touched.
 *
 * Our own pools are compared exactly as the swap compares them (swap/ownPoolRoute.ts):
 * one that pays at least as much takes the coin. That coin is NOT sent from here: every
 * swap in our pool shows its own review first (owner, 2026-10-13), so the order hands it
 * to the swap form's review.
 */

export const BASKET_COPY = {
  poolNotNamed: 'Jupiter answered through a different pool than the one this order uses, so nothing was sent for it.',
  noRoute: 'Jupiter has no route through this coin’s pool right now, so nothing was sent for it.',
  moved: 'Its price dropped beyond your slippage since the order was shown, so nothing was sent for it.',
  ownWins: 'Our own pool pays at least as much for this coin. It opens in the swap form, with its review.',
} as const;

/** Jupiter's answer names another pool, or splits the trade: not this order's route. */
export class PoolNotNamedError extends Error {
  constructor() {
    super(BASKET_COPY.poolNotNamed);
    this.name = 'PoolNotNamedError';
  }
}

/** The one pool a quote trades through, or null when it is not a single whole hop. */
export function quotedPool(q: Pick<JupiterQuote, 'routePlan'>): string | null {
  const plan = q.routePlan;
  if (!Array.isArray(plan) || plan.length !== 1) return null;
  const hop = plan[0] as { percent?: unknown; swapInfo?: { ammKey?: unknown } } | null;
  if (!hop || hop.percent !== 100 || typeof hop.swapInfo?.ammKey !== 'string') return null;
  return hop.swapInfo.ammKey;
}

type GetQuote = (p: Parameters<FeeRetryDeps['getQuote']>[0] & { pin?: { dex: string } }) => Promise<JupiterQuote>;

/**
 * `getQuote`, asked again after each wait in `waitsMs` when it fails for any reason but
 * Jupiter's own "no route". Jupiter's keyless tier refuses a burst of quotes (the sixth in
 * a row, 2026-10-18, and still refusing 3 s later) and the order asks for one per coin: a
 * refusal is a wait, not a missing price.
 */
export function retryingGetQuote(
  getQuote: GetQuote,
  waitsMs: readonly number[] = [2_500],
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): GetQuote {
  return async (p) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getQuote(p);
      } catch (e) {
        if (e instanceof NoRouteError || attempt >= waitsMs.length) throw e;
        await sleep(waitsMs[attempt]!);
      }
    }
  };
}

/** `getQuote`, held to `coin`'s pool: every answer, the no-fee retry's included, must name it. */
export function pinnedGetQuote(getQuote: GetQuote, coin: SolBasketCoin): FeeRetryDeps['getQuote'] {
  return async (p) => {
    const q = await getQuote({ ...p, pin: { dex: coin.pool.jupiterLabel } });
    if (q.outputMint !== coin.mint || quotedPool(q) !== coin.pool.address) throw new PoolNotNamedError();
    return q;
  };
}

/** Where a coin goes on these quotes: our pool on a tie or better, Jupiter otherwise. */
export function solLegRoute(jupiterOut: bigint | null, own: readonly VenuePoolCandidate[]): 'own' | 'jupiter' | 'none' {
  const chosen = freshDecision(own, jupiterOut).chosen;
  if (!chosen) return 'none';
  return chosen.venue === 'own-pool' ? 'own' : 'jupiter';
}

export interface SolLegDeps {
  /** Already pinned to the coin (pinnedGetQuote). */
  getQuote: FeeRetryDeps['getQuote'];
  buildSwapTransaction: FeeRetryDeps['buildSwapTransaction'];
  simulateSwap(b64: string): Promise<SwapSimulation>;
  swapCarriesPlatformFee(inputMint: string, outputMint: string): boolean;
  /** Our pools for this coin, read again now and quoted for `amountIn`. Null: the read did not answer. */
  ownPools(): Promise<VenuePoolCandidate[] | null>;
}

export type PreparedSolLeg =
  /** Hand `swapTransaction` to the wallet: it passed its test run. Show `quote`'s amounts. */
  | { kind: 'ready'; quote: JupiterQuote; swapTransaction: string; siteFeeWaived: boolean }
  /** Our pool takes it: the swap form's review buys it. */
  | { kind: 'own' }
  | { kind: 'not-sent'; why: string };

/**
 * Build one coin's transaction, or say why not. `shown` is the quote the order showed for
 * it, `shownOwn` what our pools quoted then (null: unread then). Mirrors the swap's press:
 * re-quote, hold the price to the one shown, compare our pools on what Jupiter's
 * transaction FROM THIS SITE pays, build, test-run.
 */
export async function prepareSolLeg(
  deps: SolLegDeps,
  a: {
    coin: SolBasketCoin;
    inputMint: string;
    amountIn: bigint;
    shown: JupiterQuote;
    shownOwn: readonly VenuePoolCandidate[] | null;
    slippageBps: number;
    user: string;
    priority?: PriorityLevel;
  },
): Promise<PreparedSolLeg> {
  const amount = a.amountIn.toString();
  // Our pools now. A read that fails changes nothing: what was on screen stands, and an
  // unread read on screen is no pool, as on the swap (ownPoolTakesIt: only a comparison that
  // never answered at all holds a trade, and the order is only shown once every read answered).
  const ownTakes = async (out: bigint): Promise<boolean> => {
    const own = (await deps.ownPools().catch(() => null)) ?? a.shownOwn ?? [];
    return solLegRoute(out, own) === 'own';
  };

  let fresh: JupiterQuote;
  try {
    fresh = await deps.getQuote({ inputMint: a.inputMint, outputMint: a.coin.mint, amount, slippageBps: a.slippageBps });
  } catch (e) {
    if (e instanceof PoolNotNamedError) return { kind: 'not-sent', why: BASKET_COPY.poolNotNamed };
    if (e instanceof NoRouteError) return { kind: 'not-sent', why: BASKET_COPY.noRoute };
    return { kind: 'not-sent', why: 'Jupiter’s price could not be read just now, so nothing was sent for it.' };
  }
  let freshOut: bigint;
  let shownOut: bigint;
  try {
    freshOut = BigInt(fresh.outAmount);
    shownOut = BigInt(a.shown.outAmount);
  } catch {
    return { kind: 'not-sent', why: BASKET_COPY.moved };
  }
  const floor = minOut(shownOut, a.slippageBps);
  if (floor === null || freshOut < floor) return { kind: 'not-sent', why: BASKET_COPY.moved };

  const carriesFee = deps.swapCarriesPlatformFee(a.inputMint, a.coin.mint);
  if (!carriesFee && (await ownTakes(freshOut))) return { kind: 'own' };

  let prepared: Awaited<ReturnType<typeof prepareJupiterSwap>>;
  try {
    prepared = await prepareJupiterSwap(
      { getQuote: deps.getQuote, buildSwapTransaction: deps.buildSwapTransaction, simulateSwap: deps.simulateSwap, swapCarriesPlatformFee: deps.swapCarriesPlatformFee },
      { fresh, shown: a.shown, inputMint: a.inputMint, outputMint: a.coin.mint, amount, slippageBps: a.slippageBps, user: a.user, priority: a.priority },
    );
  } catch {
    return { kind: 'not-sent', why: 'Jupiter’s transaction for it could not be built just now, so nothing was sent for it.' };
  }
  if (prepared.status === 'blocked') return { kind: 'not-sent', why: prepared.unchecked ? NOT_TEST_RUN_COPY : refusedSaid(prepared, a.slippageBps) };
  if (prepared.status === 'moved') return { kind: 'not-sent', why: BASKET_COPY.moved };

  if (carriesFee) {
    let sentOut: bigint;
    try {
      sentOut = BigInt(prepared.quote.outAmount);
    } catch {
      return { kind: 'not-sent', why: BASKET_COPY.moved };
    }
    if (await ownTakes(sentOut)) return { kind: 'own' };
  }
  return { kind: 'ready', quote: prepared.quote, swapTransaction: prepared.swapTransaction, siteFeeWaived: prepared.siteFeeWaived };
}
