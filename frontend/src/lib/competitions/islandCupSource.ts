// Reading the twelve pools. The ONLY part of the cup that touches the network,
// and it does so through the one shared fetcher.
//
// ─── THE RATE LIMIT IS THE DESIGN CONSTRAINT ─────────────────────────────────
//
// GeckoTerminal's keyless endpoint throttles hard — a handful of rapid requests
// from one IP is enough to start collecting 429s — and this board wants twelve
// reads while the bungalow pages on the same origin want their own. So:
//
//   · every read goes through `readPoolTradesCached`, whose 60-second TTL is
//     shared with every other surface in the app. Two of them on one screen ask
//     upstream once.
//   · pools are read in small BATCHES rather than all at once, so a burst of
//     twelve does not arrive in the same millisecond.
//   · nothing polls. One read per mount, plus a button. A refresh inside the TTL
//     is served from the cache and issues no request at all.
//
// ─── AND A FAILURE IS NEVER A ZERO ───────────────────────────────────────────
//
// `readIslandCup` never rejects and never drops a pool. A pool that 429'd, 404'd
// or timed out comes back as a `failed` coverage entry carrying the shared
// reader's own plain-language sentence, and the board's status falls to 'partial'
// or 'unavailable'. `Promise.all` would have let one bad pool erase eleven good
// ones, which on a leaderboard reads as a quiet day.

import {
  readPoolTradesCached,
  type PoolTradesRead,
  type ReadPoolTradesCachedOptions,
} from '../geckoTerminal/poolTrades';
import {
  buildCupBoard,
  cupBoardStatus,
  tradeRowsFromTrades,
  type CupBoard,
  type CupBoardStatus,
  type CupPool,
  type PoolOutcome,
} from './islandCup';

export interface ReadIslandCupOptions {
  signal?: AbortSignal;
  /** Injection seam for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Pools read in parallel per batch. Small on purpose — see the header. */
  concurrency?: number;
  /** Passed through to the shared cache. Default is the shared 60 seconds. */
  ttlMs?: number;
}

export interface IslandCupRead {
  board: CupBoard;
  status: CupBoardStatus;
}

/** One pool's read, translated into the pure layer's vocabulary. */
function outcomeFrom(pool: CupPool, read: PoolTradesRead): PoolOutcome {
  if (read.status === 'read') {
    const { rows, returned, dropped } = tradeRowsFromTrades(pool, read.trades);
    return { ok: true, rows, returned, dropped };
  }
  return { ok: false, reason: read.reason, detail: read.detail };
}

/**
 * Read every pool once and fold the answers into a board.
 *
 * Batched rather than fanned out in one shot, and sequential between batches:
 * the point is to spread twelve requests over a moment rather than to be fast.
 */
export async function readIslandCup(
  pools: readonly CupPool[],
  opts: ReadIslandCupOptions = {},
): Promise<IslandCupRead> {
  const size = Math.max(1, opts.concurrency ?? 4);
  const readOpts: ReadPoolTradesCachedOptions = {};
  if (opts.signal) readOpts.signal = opts.signal;
  if (opts.fetchImpl) readOpts.fetchImpl = opts.fetchImpl;
  if (opts.ttlMs !== undefined) readOpts.ttlMs = opts.ttlMs;

  const outcomes: Array<{ pool: CupPool; outcome: PoolOutcome }> = [];

  for (let i = 0; i < pools.length; i += size) {
    const batch = pools.slice(i, i + size);
    const settled = await Promise.allSettled(
      batch.map((pool) => readPoolTradesCached(pool.network, pool.pool, readOpts)),
    );

    settled.forEach((result, index) => {
      const pool = batch[index];
      if (!pool) return;
      if (result.status === 'fulfilled') {
        outcomes.push({ pool, outcome: outcomeFrom(pool, result.value) });
        return;
      }
      // The shared reader is documented never to reject; if that ever changes,
      // the pool still gets a chip rather than vanishing from the coverage list.
      outcomes.push({
        pool,
        outcome: {
          ok: false,
          reason: 'network',
          detail: 'The trades feed could not be reached for this pool.',
        },
      });
    });
  }

  const board = buildCupBoard(outcomes);
  return { board, status: cupBoardStatus(board) };
}
