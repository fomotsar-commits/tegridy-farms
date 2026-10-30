import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { FEE_RATE_DENOMINATOR } from '../cpswap/math';
import { depositEnabled, swapEnabled, withdrawEnabled } from '../cpswap/program';
import { quoteOwnPool } from '../cpswap/read';
import { chargedCreatorFeeRate } from '../cpswap/venue';
import { quoteText } from './format';
import { readPoolIndex } from './poolIndex';
import { readPools, type PoolView, type ReadPoolsOptions } from './poolFinder';
import { PRICE_TOLERANCE, comparePrice, poolPricePerToken } from './poolHealth';
import { siteNamed } from './identity';
import { poolFeesOf } from './liquidityMath';
import { lastTrade } from './poolPast';
import { QUOTE_COINS, SOL_QUOTE, USDC_QUOTE, orList, type QuoteCoin } from './quotes';
import { TOKEN_PROGRAM, readTokenSafety, type TokenSafety } from './tokenSafety';
import { MAX_FEE_BASIS_POINTS, feeNow, preFeeAmountOf, type TransferFee } from './transferFee';

/**
 * Every pool on the venue, for the list a visitor sees before picking a token.
 *
 * Same trust rules as the finder (poolFinder.ts): the index (`/api/pools?all=1`) is asked
 * for ADDRESSES only, and every address is then read and checked on chain in the browser.
 * A wrong index can leave a pool out, which the list says it might; it cannot put words in
 * a pool's mouth. An index that did not answer is `unread`, never "no pools".
 */

export interface PoolList {
  /** Every address that read as one of our pools with a pairing coin: SOL's first, then USDC's, then BAYLA's, deepest first in each. */
  pools: PoolView[];
  /** Addresses the index named that could not be read this time. */
  unread: number;
  /** The index holds more pools than it returns: the rest are found by searching a token. */
  truncated: boolean;
  /** The chain's clock, read with the pools; null when it was not read, or no pool was. */
  chainNow: bigint | null;
  /** Each listed coin's check, by mint, for its ticker (identity.ts): one batch for the whole list. Coins the site names itself are not read. */
  safety: ReadonlyMap<string, TokenSafety>;
}

export type PoolListRead = { kind: 'ok'; list: PoolList } | { kind: 'unread'; detail: string };

export async function listPools(rpc: SolanaRpc, opts: ReadPoolsOptions & { fetchImpl?: typeof fetch }): Promise<PoolListRead> {
  const index = await readPoolIndex({ all: true }, opts.programId.toBase58(), opts.fetchImpl);
  if (index.kind === 'unread') return { kind: 'unread', detail: index.detail };
  if (index.pools.length === 0) return { kind: 'ok', list: { pools: [], unread: 0, truncated: index.truncated, chainNow: null, safety: new Map() } };
  const read = await readPools(rpc, index.pools, opts);
  if (read.kind === 'unread') return { kind: 'unread', detail: read.detail };
  const pools: PoolView[] = [];
  let unread = 0;
  for (const e of read.entries) {
    // A pool on the launch tier that is not the launch pool is read and not listed (poolFinder.ts).
    if (e.kind === 'pool') {
      if (!e.view.launchTierWithoutLaunch) pools.push(e.view);
    } else if (e.kind === 'unread') unread++;
    // `absent`, `not-a-pool`, `other-pair`: the index was wrong about an address; nothing to list.
  }
  // The index ranks too, by a read of its own; the order shown is the order just read.
  // Amounts of different coins are never compared: each coin's pools stay together.
  const rank = (v: PoolView) => QUOTE_COINS.findIndex((q) => q.mint === v.quote.mint);
  pools.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.quoteReserve !== b.quoteReserve) return a.quoteReserve > b.quoteReserve ? -1 : 1;
    return a.address < b.address ? -1 : 1;
  });
  // Never throws: a coin whose check was not read is headed by its short address.
  const safety = await readTokenSafety(rpc, pools.map((v) => v.tokenMint).filter((m) => !siteNamed(m)));
  return { kind: 'ok', list: { pools, unread, truncated: index.truncated, chainNow: read.chainNow, safety } };
}

/**
 * A short tag on a row of the list, from what the list already read: the pool's own
 * switches, its vaults, its coin side, its open time and its trade record, and its price
 * against Jupiter's market price (`marketGap`). Warnings only: a fact that was not read
 * gives no tag, and no tag ever says a pool is fine. The pool's full price check is on its
 * card, one View away.
 */
export interface PoolTag {
  text: string;
  tone: 'bad' | 'warn';
}

/**
 * Under this much on its coin side, a pool is "Little money in pool". BAYLA has no fixed
 * worth to measure a pool by, so a pool priced in BAYLA is never tagged this way. BAYLA /
 * SOL is priced in SOL, and is measured like any SOL pool.
 */
export const LITTLE_MONEY: readonly { quote: QuoteCoin; under: bigint }[] = [
  { quote: SOL_QUOTE, under: 1_000_000_000n },
  { quote: USDC_QUOTE, under: 100_000_000n },
];
/** "under 1 SOL or 100 USDC": the line, said from the figures above. */
export const LITTLE_MONEY_TEXT = `under ${orList(LITTLE_MONEY.map((l) => quoteText(l.under, l.quote)))}`;
/** No trade for this long, by the chain's clock, is "No trades in 7 days". */
export const QUIET_SECS = 7n * 24n * 3600n;

/**
 * The tags for one row, worst first. `chainNow` null: nothing that needs the clock is said.
 * `priceGap`: the row's `marketGap`, the way round the visitor reads the prices (turnedDiff
 * when they are turned), or null for no price tag. The tag names no figure: Jupiter's market
 * price and the card's two quotes differ by several points on a thin coin (walked 2026-10-29:
 * GRR 23.4% against the card's 16.5%), and the list must not say a number its card contradicts.
 */
export function poolTags(view: PoolView, chainNow: bigint | null, priceGap: number | null = null): PoolTag[] {
  const { pool } = view.snapshot;
  const tags: PoolTag[] = [];
  if (!swapEnabled(pool)) tags.push({ text: 'Trading off', tone: 'bad' });
  if (!depositEnabled(pool)) tags.push({ text: 'Adding off', tone: 'bad' });
  if (!withdrawEnabled(pool)) tags.push({ text: 'Removing off', tone: 'bad' });
  if (view.vaultsFrozen) tags.push({ text: 'Frozen', tone: 'bad' });
  if (priceGap !== null) tags.push({ text: `Price over ${PRICE_TOLERANCE * 100}% ${priceGap >= 0 ? 'above' : 'below'} Jupiter`, tone: 'bad' });
  if (swapEnabled(pool) && chainNow !== null && chainNow < pool.openTime) tags.push({ text: 'Trading not open yet', tone: 'warn' });
  const little = LITTLE_MONEY.find((l) => l.quote.mint === view.quote.mint);
  if (little && view.quoteReserve < little.under) tags.push({ text: 'Little money in pool', tone: 'warn' });
  const last = lastTrade(view);
  if (last.kind === 'none') tags.push({ text: 'No trades yet', tone: 'warn' });
  else if (last.kind === 'at' && chainNow !== null && chainNow - last.time >= QUIET_SECS) tags.push({ text: 'No trades in 7 days', tone: 'warn' });
  return tags;
}

/**
 * Jupiter's market prices for the listed coins, in USD by mint: what each row's price is
 * held against for its price tag. ONE read for the whole list (price/v3), kept at the edge
 * for 30 seconds and shared by every visitor (lib/jupiter.ts `getUsdPrices`, `shared`):
 * the site's Jupiter key allows one request a second for everyone together, and the card's
 * own check costs two quotes a pool, too many for a list. A coin Jupiter gives no price for
 * is not in the map, and its row gets no price tag.
 */
export type MarketPrices = { kind: 'ok'; usd: ReadonlyMap<string, number> } | { kind: 'unread' };

/** Jupiter's price read takes at most this many coins at once (price/v3 `ids`). */
export const PRICE_IDS_MAX = 50;

/** Every listed token and pairing coin, sorted: every visitor asks the same address, so the edge shares it. */
export function marketPriceIds(pools: readonly PoolView[]): string[] {
  return [...new Set(pools.flatMap((v) => [v.tokenMint, v.quote.mint]))].sort();
}

export async function readMarketPrices(pools: readonly PoolView[], priceOf: (mints: string[]) => Promise<Record<string, number>>): Promise<MarketPrices> {
  const ids = marketPriceIds(pools);
  const usd = new Map<string, number>();
  try {
    // One read after another, never together: the key's one request a second is the whole site's.
    for (let i = 0; i < ids.length; i += PRICE_IDS_MAX) {
      const asked = ids.slice(i, i + PRICE_IDS_MAX);
      const got = await priceOf(asked);
      for (const mint of asked) {
        const p = got[mint];
        if (typeof p === 'number' && Number.isFinite(p) && p > 0) usd.set(mint, p);
      }
    }
  } catch {
    return { kind: 'unread' };
  }
  return { kind: 'ok', usd };
}

/**
 * How far a row's price is from Jupiter's, `pool / market - 1`, when it is further than the
 * card's own check allows (`comparePrice`: more than PRICE_TOLERANCE, and exactly 3% is
 * within). Null when it is within, or when the pool, the token or its pairing coin has no price.
 */
export function marketGap(view: PoolView, usd: ReadonlyMap<string, number>): number | null {
  const { pool } = view.snapshot;
  const here = poolPricePerToken(view.snapshot, view.tokenMint, view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals);
  const token = usd.get(view.tokenMint);
  const coin = usd.get(view.quote.mint);
  if (here === null || token === undefined || coin === undefined) return null;
  const check = comparePrice(here, token / coin, 'outside');
  return check.state === 'disagrees' ? check.diff : null;
}

/**
 * What one trade could take from a row's gap, in USD at Jupiter's market prices. `buy`: the
 * token is cheap here, so the trade buys it with the pool's coin; `sell`: it is dear here, so
 * the trade sells it in. The trade is sized to where the next bit no longer pays after the
 * pool's fee (x·y = k with the fee off the input: buying, the coin side reaches
 * √(k·m·(1−fee)); selling, the token side reaches √(k·(1−fee)/m)), and is then priced by the
 * pool program's own maths (quoteOwnPool), so its output and its fee are the chain's.
 *
 * A token with a transfer fee (`tokenFee`, from rowTokenFee) keeps back its rate of the token
 * side too: of what leaves the pool buying, of what the trader sends selling. Its rate joins
 * the pool's fee in the sizing (a fee's cap only lowers it on a big trade), and quoteOwnPool
 * then takes it exactly, the pool program's way.
 *
 * The profit comes out of the pool's LPs: the pool sells below the market or buys above it.
 * The trade's fee splits as on chain: the LPs' part, the venue's (protocol + fund), and the
 * pool creator's when the pool charges one; a transfer fee goes to whoever collects the
 * token's fee. Before the trader's own costs anywhere else, so at most. Null when the gap is
 * inside the fees, the pool cannot be traded now, or a price, the fee settings or the chain's
 * clock was not read.
 */
export interface Arbitrage {
  side: 'buy' | 'sell';
  /** The trade's size: what goes in, at Jupiter's price. */
  tradeUsd: number;
  profitUsd: number;
  lpFeeUsd: number;
  venueFeeUsd: number;
  creatorFeeUsd: number;
  /** What the token's own transfer fee keeps back of the trade; 0 for a token with none. */
  transferFeeUsd: number;
}

/**
 * The token's transfer fee as a row's arbitrage counts it. None for a classic token, which
 * cannot carry one. For a Token-2022 token, the one its safety read found (`feeNow` with no
 * epoch: the larger setting while a change is pending, as every page estimate takes it).
 * 'unread' when there is no such read, so no figure leaves a fee out.
 */
export function rowTokenFee(view: PoolView, safety: TokenSafety | null): TransferFee | null | 'unread' {
  const { pool } = view.snapshot;
  if ((view.quoteIsToken0 ? pool.token1Program : pool.token0Program) === TOKEN_PROGRAM) return null;
  if (safety?.kind !== 'read' || !safety.facts) return 'unread';
  return feeNow(safety.facts.transferFee, null);
}

export function arbitrage(view: PoolView, usd: ReadonlyMap<string, number>, chainNow: bigint | null, tokenFee: TransferFee | null = null): Arbitrage | null {
  const { pool } = view.snapshot;
  const coinUsd = usd.get(view.quote.mint);
  const tokenUsd = usd.get(view.tokenMint);
  if (!view.config || chainNow === null || coinUsd === undefined || tokenUsd === undefined) return null;
  const Q = Number(view.quoteReserve);
  const T = Number(view.tokenReserve);
  if (!(Q > 0 && T > 0)) return null;
  // Each side's base unit in USD, and the market price in coin units per token unit.
  const coinUnit = coinUsd / 10 ** view.quote.decimals;
  const tokenUnit = tokenUsd / 10 ** (view.quoteIsToken0 ? pool.mint1Decimals : pool.mint0Decimals);
  const m = tokenUnit / coinUnit;
  const fee = Number(view.config.tradeFeeRate + chargedCreatorFeeRate(view.config, pool.enableCreatorFee)) / Number(FEE_RATE_DENOMINATOR);
  const tax = tokenFee ? tokenFee.basisPoints / MAX_FEE_BASIS_POINTS : 0;
  if (!(fee < 1 && tax < 1)) return null;
  const buyTo = Math.sqrt(Q * T * m * (1 - fee) * (1 - tax));
  const sellTo = Math.sqrt((Q * T * (1 - fee) * (1 - tax)) / m);
  const side = buyTo > Q ? 'buy' : sellTo > T ? 'sell' : null;
  if (side === null) return null;
  const intoPool = BigInt(Math.floor(side === 'buy' ? (buyTo - Q) / (1 - fee) : (sellTo - T) / (1 - fee)));
  // Selling, that is what reaches the pool: the trader sends it with the token's fee on top.
  const amountIn = side === 'sell' && tokenFee ? preFeeAmountOf(tokenFee, intoPool) : intoPool;
  if (amountIn === null || amountIn <= 0n) return null;
  const inputMint = side === 'buy' ? view.quote.mint : view.tokenMint;
  const q = quoteOwnPool(view.snapshot, view.config, inputMint, amountIn, Number(chainNow), poolFeesOf(view.quoteIsToken0, tokenFee));
  if (!q) return null;
  const inUnit = side === 'buy' ? coinUnit : tokenUnit;
  const outUnit = side === 'buy' ? tokenUnit : coinUnit;
  const tradeUsd = Number(amountIn) * inUnit;
  const profitUsd = Number(q.outAmount) * outUnit - tradeUsd;
  if (!(profitUsd > 0)) return null;
  const r = q.result;
  return {
    side,
    tradeUsd,
    profitUsd,
    lpFeeUsd: Number(r.tradeFee - r.protocolFee - r.fundFee) * inUnit,
    venueFeeUsd: Number(r.protocolFee + r.fundFee) * inUnit,
    creatorFeeUsd: Number(r.creatorFee) * (q.creatorFeeOnInput ? inUnit : outUnit),
    transferFeeUsd: Number(q.transferFees?.input ?? 0n) * inUnit + Number(q.transferFees?.output ?? 0n) * outUnit,
  };
}
