import { base58 } from '@scure/base';
import type { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';
import { NoRouteError, type JupiterQuote, type PriorityLevel, type SwapSimulation } from '../../jupiter';
import type { AggregatorSeen } from '../../launcher/solana/write/types';
import { pollConfirm, type ConfirmOutcome } from '../confirm';
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
 * one that pays at least as much takes the coin, and the order buys it there itself. The
 * order sheet, each coin with its pool and figure, is that coin's review (owner,
 * 2026-10-24: "buy all these tokens for me when i click buy, not just route me to the
 * swap"). Until then a coin our pool won was handed to the swap form's own review.
 */

export const BASKET_COPY = {
  poolNotNamed: 'Jupiter answered through a different pool than the one this order uses, so nothing was sent for it.',
  noRoute: 'Jupiter has no route through this coin’s pool right now, so nothing was sent for it.',
  moved: 'Its price dropped beyond your slippage since the order was shown, so nothing was sent for it.',
  tooSlow: 'It took too long to approve in your wallet, so it ran out of time. Nothing was sent for it.',
  refusedFirst: 'The network refused it before sending it, so nothing was sent for it.',
} as const;

/** Jupiter's answer names another pool, or splits the trade: not this order's route. */
export class PoolNotNamedError extends Error {
  constructor() {
    super(BASKET_COPY.poolNotNamed);
    this.name = 'PoolNotNamedError';
  }
}

/**
 * The one pool a quote trades through, or null when it is not a single whole hop. A hop's
 * share is `percent` (100) or, in a quote asked with instructionVersion V2, `bps` (10000)
 * with `percent` null. Reading `percent` alone threw out every V2 quote from 2026-10-23
 * to 10-24, and our pool then took every coin, whatever it paid.
 */
export function quotedPool(q: Pick<JupiterQuote, 'routePlan'>): string | null {
  const plan = q.routePlan;
  if (!Array.isArray(plan) || plan.length !== 1) return null;
  const hop = plan[0] as { percent?: unknown; bps?: unknown; swapInfo?: { ammKey?: unknown } } | null;
  if (!hop || !(hop.percent === 100 || hop.bps === 10_000) || typeof hop.swapInfo?.ammKey !== 'string') return null;
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
  /** Our pool `pool` takes it, held to what Jupiter was seen to pay for the same share (`aggregator`). */
  | { kind: 'own'; pool: string; aggregator: AggregatorSeen }
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
  const ownTakes = async (out: bigint): Promise<PreparedSolLeg | null> => {
    const own = (await deps.ownPools().catch(() => null)) ?? a.shownOwn ?? [];
    const chosen = freshDecision(own, out).chosen;
    return chosen?.venue === 'own-pool' && chosen.poolAddress ? { kind: 'own', pool: chosen.poolAddress, aggregator: { kind: 'quoted', out, when: 'now' } } : null;
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
  const ownFirst = carriesFee ? null : await ownTakes(freshOut);
  if (ownFirst) return ownFirst;

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
    const ownNow = await ownTakes(sentOut);
    if (ownNow) return ownNow;
  }
  return { kind: 'ready', quote: prepared.quote, swapTransaction: prepared.swapTransaction, siteFeeWaived: prepared.siteFeeWaived };
}

/**
 * Every transaction of one press on the same fresh blockhash, set just before the one
 * wallet prompt that signs them all: each was built a few seconds apart (Jupiter answers
 * one call a second), and a blockhash lasts about 40 s here, so the first one built would
 * otherwise run out while the wallet is open. The blockhash is no part of what a test run
 * checked. Nothing is signed yet, so nothing signed changes.
 */
export function stampBlockhash(txs: readonly (Transaction | VersionedTransaction)[], blockhash: string): void {
  for (const tx of txs) {
    if ('version' in tx) tx.message.recentBlockhash = blockhash;
    else tx.recentBlockhash = blockhash;
  }
}

/** The fee payer's signature on a signed transaction, or null when it is not signed. */
export function signatureOf(tx: VersionedTransaction): string | null {
  const s = tx.signatures[0];
  return s && s.some((b) => b !== 0) ? base58.encode(s) : null;
}

/** How often the same signed bytes are sent again while the chain has not answered. */
const RESEND_MS = 2_000;

export type SentLeg = { kind: 'not-sent'; why: string } | { kind: 'sent'; outcome: ConfirmOutcome['outcome'] };

/**
 * Send a transaction the wallet signed (and did not send) through our own RPC, and watch
 * it. The first send runs the network's own check: a refusal there never reached the
 * chain, and is `not-sent`. After that, the same bytes go again every RESEND_MS until the
 * chain answers or `timeoutMs` runs out (same bytes, same signature: a re-send can never
 * buy twice). Any other error at the first send may have come after the RPC passed it on,
 * so it is watched, never said to be "not sent". Never throws.
 */
export async function sendSigned(
  conn: Pick<Connection, 'sendRawTransaction' | 'getSignatureStatuses'>,
  raw: Uint8Array,
  signature: string,
  timeoutMs: number,
): Promise<SentLeg> {
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    if (/Blockhash not found/i.test(msg)) return { kind: 'not-sent', why: BASKET_COPY.tooSlow };
    if (/simulation failed|preflight/i.test(msg) && !/already been processed/i.test(msg)) return { kind: 'not-sent', why: BASKET_COPY.refusedFirst };
  }
  const again = setInterval(() => { void conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {}); }, RESEND_MS);
  try {
    const { outcome } = await pollConfirm(conn, signature, timeoutMs);
    return { kind: 'sent', outcome };
  } finally {
    clearInterval(again);
  }
}
