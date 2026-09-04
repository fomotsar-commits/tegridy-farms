// THE ISLAND CUP — a volume board over the island's own registered pools,
// scored from the trade feed this app already reads, with no I/O in this file.
//
// ─── WHY A SECOND BOARD AT ALL ───────────────────────────────────────────────
//
// Season 1 scores the venue router's own swaps out of a Ponder indexer that is
// hosted nowhere, so it has never drawn a row. Meanwhile every resident of the
// island already carries a pool address that GeckoTerminal answers for, the
// browser already fetches those tapes on the bungalow pages, and the CSP already
// permits the host. The board was one adapter away the whole time.
//
// ─── WHAT A RANK ON THIS BOARD MEANS, EXACTLY ────────────────────────────────
//
// A position among the senders that appear IN THIS READ, over the pools that
// answered it, inside the window every one of those pools covers. It is not a
// ranking of all trading in these tokens: other pools and other venues for the
// same token are not read at all. It is not profit — see PNL_SCORING next door,
// which holds for the same reason here: a trade feed gives one leg. And it pays
// nothing: there is no prize, no escrow and no settlement anywhere in this
// feature.
//
// ─── THE COVERAGE PROBLEM, WHICH IS THE WHOLE DESIGN ─────────────────────────
//
// GeckoTerminal serves ONE RECENT PAGE of fills per pool. A busy pool fills that
// page in minutes; a quiet one's page reaches back much further. Summing them
// naively would rank a busy pool's ten minutes against a quiet pool's week and
// call the result a leaderboard.
//
// So: a pool whose page came back FULL is `capped`, and the oldest fill it
// returned is the earliest moment it can speak for. The scored window starts at
// the LATEST of those — the widest window every answering pool actually covers.
// Fills older than that are counted (`legsOutsideWindow`) and not scored.
//
// An UNCAPPED pool is deliberately NOT a bound. Its page was not full, so it
// covers everything the feed served; its oldest fill is a fact about trading,
// not about coverage, and using it would shrink the window to the quietest
// pool's first trade and throw away real fills.
//
// ─── AND THE PART THAT CANNOT BE FIXED HERE ──────────────────────────────────
//
// A pool that could not be read is NOT a quiet pool. Every failure lands in
// `coverage` with its reason, `cupBoardStatus` refuses to say 'complete' unless
// every pool answered in full, and no board is ever rendered from zero answers.

import { parseUnits } from 'viem';
import { BUNGALOWS } from '../bungalows';
import { TOWELI_MARKET } from '../chart/market';
import type { GeckoNetwork } from '../geckoTerminal/pools';
import type { PoolTrade } from '../geckoTerminal/poolTrades';
import { rankLegs, WASH_WINDOW_SECONDS, type Leg, type RankRow } from './legs';

// ─── The pools ───────────────────────────────────────────────────────────────

/** One registered island pool the cup reads. */
export interface CupPool {
  /** Registry id — 'pepe', 'bayla', 'toweli'. Stable, and the React key. */
  id: string;
  name: string;
  symbol: string;
  network: GeckoNetwork;
  /** Pool (pair) address on that network, exactly as the registry records it. */
  pool: string;
  /** The pair as the registry names it, e.g. 'PEPE / WETH · Uniswap'. */
  label: string;
  /** This registry's own word for the chain, for the badge. */
  chain: string;
}

/**
 * Identity of a pool for de-duplication.
 *
 * EVM addresses are compared case-insensitively; base58 is compared EXACTLY,
 * because a lowercased Solana key is a different, valid-looking, wrong address.
 * Same rule as `residentLabelForPool` in lib/bungalows.ts.
 */
function poolIdentity(network: GeckoNetwork, pool: string): string {
  return `${network}:${network === 'solana' ? pool.trim() : pool.trim().toLowerCase()}`;
}

/**
 * The pools on the board: every live resident that names a market, plus the
 * venue's own TOWELI/WETH pool.
 *
 * Read from the registry on every call rather than captured at module init, so
 * a test can reason about the real list and the pill predicate cannot snapshot a
 * stale answer. Order follows the registry.
 *
 * TOWELI's own bungalow entry carries no `market` field — its pool lives in
 * lib/chart/market.ts — so it is appended by hand. It is deliberately on the
 * board despite near-zero volume: its coverage chip saying "read, 0 fills" is a
 * true sentence about this venue, and omitting the house's own pool from the
 * house's own board would be a quiet flattery.
 */
export function cupPools(): CupPool[] {
  const out: CupPool[] = [];
  const seen = new Set<string>();

  const push = (p: CupPool) => {
    const key = poolIdentity(p.network, p.pool);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  for (const b of BUNGALOWS) {
    if (!b.live || !b.market) continue;
    push({
      id: b.id,
      name: b.name,
      symbol: b.symbol,
      network: b.market.network,
      pool: b.market.pool,
      label: b.market.label,
      chain: b.chain,
    });
  }

  push({
    id: 'toweli',
    name: 'TOWELI',
    symbol: 'TOWELI',
    network: TOWELI_MARKET.network,
    pool: TOWELI_MARKET.pool,
    label: `${TOWELI_MARKET.label} / WETH`,
    chain: 'ethereum',
  });

  return out;
}

// ─── The page cap ────────────────────────────────────────────────────────────

/**
 * How many fills one read of a pool's trade feed can return.
 *
 * GeckoTerminal's public API documents the pool-trades endpoint as serving the
 * most recent trades from the last 24 hours, capped at 300 per response
 * (https://api.geckoterminal.com/docs/index.html — "Trades", public API v2),
 * recorded 2026-09-02.
 *
 * NOT independently confirmed by a live read from this repo: the keyless
 * endpoint starts answering 429 after a handful of rapid requests, so probing it
 * costs the same budget the board itself needs. The consequence of the figure
 * being WRONG is bounded on the safe side by how it is used: a pool at or above
 * this count is marked `capped`, a capped pool makes the whole board `partial`,
 * and a partial board says its totals are floors and its order provisional. A
 * cap that is really lower than this would under-detect, which is why the
 * measured window is always printed rather than described.
 */
export const GT_TRADES_PAGE_CAP = 300;

// ─── Rows ────────────────────────────────────────────────────────────────────

/** One readable fill on one cup pool. */
export interface PoolTradeRow {
  pool: CupPool;
  /** The transaction sender, as the feed reports it. Never re-cased on Solana. */
  sender: string;
  kind: 'buy' | 'sell';
  /** USD size in micro-dollars. Integer arithmetic from here on. */
  usdMicros: bigint;
  /** Unix seconds, from the fill's own block timestamp. */
  at: number;
  txHash: string;
  /** Position of this fill within its transaction, so a multi-fill tx keeps both. */
  ordinal: number;
}

export interface PoolRows {
  rows: PoolTradeRow[];
  /** Fills the feed returned, before any were dropped. Drives cap detection. */
  returned: number;
  /** Fills that could not be read. Shown on the chip, never silently absorbed. */
  dropped: number;
}

/**
 * Above this, a USD figure is not a fill — it is a bad row, and it is dropped.
 *
 * The shared reader hands USD over as a JS double (lib/geckoTerminal/poolTrades
 * `num`), so the value carries about fifteen significant digits. Below $1e15
 * that is finer than a micro-dollar for any fill a human would recognise; above
 * it the number has stopped describing money. Numbers at or above 1e21 also
 * stringify in exponential form, which `parseUnits` would reject outright.
 */
const MAX_USD = 1e15;

/**
 * USD as micro-dollars, or null when the figure cannot be believed.
 *
 * `toFixed(6)` then `parseUnits(_, 6)` rather than `usd * 1e6`: the multiply
 * runs off the end of a double's exact-integer range at a million dollars and
 * silently returns a neighbouring value. Rounding happens at the half
 * micro-dollar, which is stated here because rounding a money figure is a
 * decision and not an implementation detail.
 */
function usdToMicros(usd: number | null): bigint | null {
  if (usd === null || !Number.isFinite(usd) || usd < 0 || usd >= MAX_USD) return null;
  return parseUnits(usd.toFixed(6), 6);
}

/**
 * Fills from one pool's read, as scoreable rows.
 *
 * A fill with no sender, no USD size or an unparseable timestamp is DROPPED and
 * COUNTED. Not defaulted: a `?? 0` here invents a zero-dollar trade by an empty
 * wallet, which is exactly the kind of row that lands on a leaderboard looking
 * like data.
 */
export function tradeRowsFromTrades(pool: CupPool, trades: readonly PoolTrade[]): PoolRows {
  const rows: PoolTradeRow[] = [];
  let dropped = 0;
  // tx hash -> how many fills of that tx have been seen in this response.
  const perTx = new Map<string, number>();

  for (const trade of trades) {
    const seenBefore = perTx.get(trade.txHash);
    const ordinal = seenBefore === undefined ? 0 : seenBefore;
    perTx.set(trade.txHash, ordinal + 1);

    const usdMicros = usdToMicros(trade.usd);
    const ms = Date.parse(trade.at);
    if (trade.wallet === null || usdMicros === null || !Number.isFinite(ms)) {
      dropped += 1;
      continue;
    }

    rows.push({
      pool,
      sender: pool.network === 'solana' ? trade.wallet : trade.wallet.toLowerCase(),
      kind: trade.kind,
      usdMicros,
      at: Math.floor(ms / 1000),
      txHash: trade.txHash,
      ordinal,
    });
  }

  return { rows, returned: trades.length, dropped };
}

/**
 * Rows as legs for the shared round-trip rule.
 *
 * The pair is the POOL, not the token: two fills oppose each other only when
 * they happened in the same pool, which is the only place a round trip can
 * actually be round. `counted` is true for every readable fill — unlike the
 * router season there is no off-quote case, because the feed prices every fill
 * in the same unit.
 */
export function tradesToLegs(rows: readonly PoolTradeRow[]): Leg[] {
  return rows.map((row) => ({
    id: `${row.pool.network}:${row.pool.pool}:${row.txHash}:${row.ordinal}`,
    wallet: row.sender,
    pairKey: poolIdentity(row.pool.network, row.pool.pool),
    direction: row.kind === 'buy' ? 'a>b' : 'b>a',
    amount: row.usdMicros,
    counted: true,
    at: row.at,
    txHash: row.txHash,
  }));
}

// ─── Coverage and the board ──────────────────────────────────────────────────

/** What one pool contributed, and what it could not. */
export type PoolCoverage =
  | {
      pool: CupPool;
      state: 'read';
      trades: number;
      dropped: number;
      oldestAt: number | null;
      newestAt: number | null;
    }
  | {
      pool: CupPool;
      state: 'capped';
      trades: number;
      dropped: number;
      /** The oldest fill returned — the earliest moment this pool can speak for. */
      coveredFrom: number;
      newestAt: number;
    }
  | { pool: CupPool; state: 'failed'; reason: string; detail: string };

/** One pool's read, as the pure layer receives it. */
export type PoolOutcome =
  | { ok: true; rows: PoolTradeRow[]; returned: number; dropped: number }
  | { ok: false; reason: string; detail: string };

/** A board row, plus how many of the island's pools this sender touched. */
export interface CupRow extends RankRow {
  poolsTouched: number;
}

export interface CupBoard {
  rows: CupRow[];
  coverage: PoolCoverage[];
  /** Start of the scored window, or null when no pool hit its page cap. */
  windowFrom: number | null;
  /** Newest and oldest fill READ, from block timestamps only. Never a clock read. */
  newestFillAt: number | null;
  oldestFillAt: number | null;
  legsRead: number;
  /** Fills older than the common window: counted, deliberately not scored. */
  legsOutsideWindow: number;
  washedLegs: number;
  poolsAnswered: number;
  poolsTotal: number;
}

export type CupBoardStatus = 'complete' | 'partial' | 'unavailable';

export interface BuildCupBoardOptions {
  windowSeconds?: number;
}

/**
 * Fold every pool's outcome into one board.
 *
 * Never throws and never omits a pool: a pool that failed appears in `coverage`
 * with its reason, because a missing chip and a quiet pool look identical on a
 * screen and mean opposite things.
 */
export function buildCupBoard(
  outcomes: ReadonlyArray<{ pool: CupPool; outcome: PoolOutcome }>,
  opts: BuildCupBoardOptions = {},
): CupBoard {
  const coverage: PoolCoverage[] = [];
  const rows: PoolTradeRow[] = [];
  let cappedFloor: number | null = null;

  for (const { pool, outcome } of outcomes) {
    if (!outcome.ok) {
      coverage.push({ pool, state: 'failed', reason: outcome.reason, detail: outcome.detail });
      continue;
    }

    const times = outcome.rows.map((r) => r.at);
    const oldestAt = times.length > 0 ? Math.min(...times) : null;
    const newestAt = times.length > 0 ? Math.max(...times) : null;
    const capped = outcome.returned >= GT_TRADES_PAGE_CAP;

    if (capped && (oldestAt === null || newestAt === null)) {
      // The page was full and not one fill in it could be read. Calling this
      // 'read' would claim full coverage of a window nothing was measured over.
      coverage.push({
        pool,
        state: 'failed',
        reason: 'unreadable-page',
        detail: 'The feed returned a full page for this pool and none of it could be read.',
      });
      continue;
    }

    if (capped && oldestAt !== null && newestAt !== null) {
      coverage.push({
        pool,
        state: 'capped',
        trades: outcome.rows.length,
        dropped: outcome.dropped,
        coveredFrom: oldestAt,
        newestAt,
      });
      if (cappedFloor === null || oldestAt > cappedFloor) cappedFloor = oldestAt;
    } else {
      coverage.push({
        pool,
        state: 'read',
        trades: outcome.rows.length,
        dropped: outcome.dropped,
        oldestAt,
        newestAt,
      });
    }

    rows.push(...outcome.rows);
  }

  const allTimes = rows.map((r) => r.at);
  const oldestFillAt = allTimes.length > 0 ? Math.min(...allTimes) : null;
  const newestFillAt = allTimes.length > 0 ? Math.max(...allTimes) : null;

  const windowFrom = cappedFloor;
  const inWindow = windowFrom === null ? rows : rows.filter((r) => r.at >= windowFrom);
  const legsOutsideWindow = rows.length - inWindow.length;

  const legs = tradesToLegs(inWindow);
  const ranked = rankLegs(legs, { windowSeconds: opts.windowSeconds ?? WASH_WINDOW_SECONDS });

  // How many distinct pools each sender appears in, over the scored window.
  const touched = new Map<string, Set<string>>();
  for (const leg of legs) {
    const set = touched.get(leg.wallet) ?? new Set<string>();
    set.add(leg.pairKey);
    touched.set(leg.wallet, set);
  }

  return {
    // Every ranked wallet came out of `legs`, so its set exists by
    // construction; the empty branch is unreachable rather than a default.
    rows: ranked.rows.map((row) => {
      const pools = touched.get(row.wallet);
      return { ...row, poolsTouched: pools ? pools.size : 0 };
    }),
    coverage,
    windowFrom,
    newestFillAt,
    oldestFillAt,
    legsRead: rows.length,
    legsOutsideWindow,
    washedLegs: ranked.washedLegs,
    poolsAnswered: coverage.filter((c) => c.state !== 'failed').length,
    poolsTotal: coverage.length,
  };
}

/**
 * Whether the board can be presented as what it claims.
 *
 * 'complete' means every pool answered IN FULL — not that every trade in these
 * tokens was seen, which no read of one venue's feed could establish. A single
 * capped or failed pool makes it 'partial'; nothing answering makes it
 * 'unavailable', and an unavailable board is not rendered as a table at all.
 */
export function cupBoardStatus(board: CupBoard): CupBoardStatus {
  if (board.coverage.length === 0) return 'unavailable';
  if (board.coverage.every((c) => c.state === 'read')) return 'complete';
  if (board.coverage.every((c) => c.state === 'failed')) return 'unavailable';
  return 'partial';
}

// ─── Finding yourself ────────────────────────────────────────────────────────

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface CupRankHit {
  /** 1-based. Never 0 — a rank of zero is not a position. */
  rank: number;
  of: number;
  row: CupRow;
}

/**
 * Where a sender sits in this read, or null.
 *
 * Null is not "last" and not "zero": it means the address does not appear in
 * what was read, which is a statement about this read and not about the wallet.
 * The query is lowercased only when it is a well-formed EVM address; a base58
 * key is matched byte-for-byte.
 */
export function findRank(board: CupBoard, wallet: string): CupRankHit | null {
  const query = wallet.trim();
  if (!query) return null;
  const needle = EVM_ADDRESS.test(query) ? query.toLowerCase() : query;
  const index = board.rows.findIndex((r) => r.wallet === needle);
  if (index < 0) return null;
  const row = board.rows[index];
  if (!row) return null;
  return { rank: index + 1, of: board.rows.length, row };
}

// ─── Formatting and copy ─────────────────────────────────────────────────────

/**
 * Micro-dollars as a dollar figure, entirely in integer arithmetic.
 *
 * Never routed through `Number`: a board's top row is where the largest total
 * lives, which is exactly where a float would start losing cents.
 */
export function formatUsdMicros(micros: bigint): string {
  const negative = micros < 0n;
  const cents = (negative ? -micros : micros) / 10_000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = (cents % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${whole}.${rest}`;
}

/** A unix second as a UTC minute — the fill's own time, never a relative one. */
export function utcMinute(at: number): string {
  return `${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export const CUP_RANK_MEANING =
  'A rank is your position among the senders that appear in THIS read, over the pools that answered and inside the window every one of them covers. It is not a ranking of all trading in these tokens — other pools and venues are not read — it is not profit, and it pays nothing.';

export const CUP_UNIT = 'USD as GeckoTerminal priced each fill';

export const CUP_SENDER =
  'Sender is the transaction sender as GeckoTerminal reports it — bots and routers included';

export const CUP_WASH_LIMIT =
  'Round trips that straddle the window start cannot be struck; two-wallet collusion is not detectable from a trade feed.';

export const CUP_NO_ARCHIVE =
  'Nothing stores past reads. This is the window GeckoTerminal serves right now; yesterday is not kept anywhere.';

export const CUP_EMPTY_AFTER_COMPLETE =
  'Every pool answered and none reported a fill inside the window. That is a measurement of these pools over the window GeckoTerminal served, not a statement about trading elsewhere.';

export const CUP_UNAVAILABLE =
  'No resident pool could be read, so there is no board. That is an outage of the trade feed, not a quiet day.';

/**
 * A failure slug as a word a reader can act on.
 *
 * The shared reader's slugs are precise and unfriendly ('schema', 'http'). They
 * are translated rather than hidden: the chip has to say WHICH pool is missing
 * and roughly why, because "11 of 12" with no reason invites the reader to
 * assume the twelfth was empty.
 */
const CUP_FAILURE_WORDS: Record<string, string> = {
  'rate-limited': 'rate-limited',
  http: 'the feed refused it',
  schema: 'the answer was unreadable',
  network: 'no answer',
  aborted: 'cancelled',
  'not-attempted': 'not asked',
  'unreadable-page': 'a full page, none of it readable',
};

export function cupFailureWord(reason: string): string {
  return CUP_FAILURE_WORDS[reason] ?? reason;
}

/**
 * The sentence a reader can paste elsewhere.
 *
 * It carries its own caveats — how many pools answered, the word 'provisional'
 * whenever the board is not complete, and the time of the newest fill it saw —
 * because a rank travels further than the page it was read on, and a screenshot
 * of a number with no window attached is the one artefact this feature must not
 * manufacture.
 */
export function cupShareText(
  rank: number,
  of: number,
  poolsAnswered: number,
  poolsTotal: number,
  status: CupBoardStatus,
  newestFillIso: string,
): string {
  const provisional = status === 'complete' ? '' : ', provisional';
  return `#${rank} of ${of} wallets (${poolsAnswered} of ${poolsTotal} pools answered${provisional}) on the Island Cup, memetic.fun/competitions, read at ${newestFillIso}`;
}
