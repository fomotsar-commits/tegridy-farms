import type { SolanaRpc } from '../../launcher/solana/curve/rpc';
import { readPoolIndex } from './poolIndex';
import { readPools, type PoolView, type ReadPoolsOptions } from './poolFinder';
import { QUOTE_COINS } from './quotes';

/**
 * Every pool on the venue that pairs a token with a pairing coin (SOL, USDC or BAYLA),
 * for the list a visitor sees before typing anything.
 *
 * Same trust rules as the finder (poolFinder.ts): the index (`/api/pools?all=1`) is asked
 * for ADDRESSES only, and every address is then read and checked on chain in the browser.
 * A wrong index can leave a pool out, which the list says it might; it cannot put words in
 * a pool's mouth. An index that did not answer is `unread`, never "no pools".
 */

export interface PoolList {
  /**
   * Every pool that read as one of ours with a pairing coin: SOL's pools first, then
   * USDC's, then BAYLA's, and within one coin the deepest side of THAT coin first.
   * Amounts of different coins are never compared, and no dollar figure ranks anything.
   */
  pools: PoolView[];
  /** Addresses the index named that could not be read this time. */
  unread: number;
  /** Real pools of the program whose two tokens are neither SOL, USDC nor BAYLA: out of this site's scope. */
  otherPairs: number;
  /** The index holds more pools than it returns. */
  truncated: boolean;
  chainNow: bigint | null;
}

export type PoolListRead = { kind: 'ok'; list: PoolList } | { kind: 'unread'; detail: string };

export async function listPools(rpc: SolanaRpc, opts: ReadPoolsOptions & { fetchImpl?: typeof fetch }): Promise<PoolListRead> {
  const index = await readPoolIndex({ all: true }, opts.programId.toBase58(), opts.fetchImpl);
  if (index.kind === 'unread') return { kind: 'unread', detail: index.detail };
  if (index.pools.length === 0) {
    return { kind: 'ok', list: { pools: [], unread: 0, otherPairs: 0, truncated: index.truncated, chainNow: null } };
  }
  const read = await readPools(rpc, index.pools, opts);
  if (read.kind === 'unread') return { kind: 'unread', detail: read.detail };
  const pools: PoolView[] = [];
  let unread = 0;
  let otherPairs = 0;
  for (const e of read.entries) {
    if (e.kind === 'pool') pools.push(e.view);
    else if (e.kind === 'unread') unread++;
    else if (e.kind === 'other-pair') otherPairs++;
    // `absent` and `not-a-pool`: the index was wrong about an address; nothing to list.
  }
  // The index ranks too, but by a read of its own; the order shown is the order just
  // read, in the finder's own order (poolFinder.ts findPools): coin rank, then depth.
  const rank = (v: PoolView) => QUOTE_COINS.findIndex((q) => q.mint === v.quote.mint);
  pools.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.quoteReserve !== b.quoteReserve) return a.quoteReserve > b.quoteReserve ? -1 : 1;
    return a.address < b.address ? -1 : 1;
  });
  return { kind: 'ok', list: { pools, unread, otherPairs, truncated: index.truncated, chainNow: read.chainNow } };
}
