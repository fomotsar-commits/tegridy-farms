import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { depositEnabled, swapEnabled, withdrawEnabled } from '../cpswap/program';
import { quoteText } from './format';
import { readPoolIndex } from './poolIndex';
import { readPools, type PoolView, type ReadPoolsOptions } from './poolFinder';
import { siteNamed } from './identity';
import { lastTrade } from './poolPast';
import { QUOTE_COINS, SOL_QUOTE, USDC_QUOTE, orList, type QuoteCoin } from './quotes';
import { readTokenSafety, type TokenSafety } from './tokenSafety';

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
    if (e.kind === 'pool') pools.push(e.view);
    else if (e.kind === 'unread') unread++;
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
 * switches, its vaults, its coin side, its open time and its trade record. Warnings only:
 * a fact that was not read gives no tag, and no tag ever says a pool is fine. Its price is
 * not among them: that check needs Jupiter, and is on the pool's card, one View away.
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

/** The tags for one row, worst first. `chainNow` null: nothing that needs the clock is said. */
export function poolTags(view: PoolView, chainNow: bigint | null): PoolTag[] {
  const { pool } = view.snapshot;
  const tags: PoolTag[] = [];
  if (!swapEnabled(pool)) tags.push({ text: 'Trading off', tone: 'bad' });
  if (!depositEnabled(pool)) tags.push({ text: 'Adding off', tone: 'bad' });
  if (!withdrawEnabled(pool)) tags.push({ text: 'Removing off', tone: 'bad' });
  if (view.vaultsFrozen) tags.push({ text: 'Frozen', tone: 'bad' });
  if (swapEnabled(pool) && chainNow !== null && chainNow < pool.openTime) tags.push({ text: 'Trading not open yet', tone: 'warn' });
  const little = LITTLE_MONEY.find((l) => l.quote.mint === view.quote.mint);
  if (little && view.quoteReserve < little.under) tags.push({ text: 'Little money in pool', tone: 'warn' });
  const last = lastTrade(view);
  if (last.kind === 'none') tags.push({ text: 'No trades yet', tone: 'warn' });
  else if (last.kind === 'at' && chainNow !== null && chainNow - last.time >= QUIET_SECS) tags.push({ text: 'No trades in 7 days', tone: 'warn' });
  return tags;
}
