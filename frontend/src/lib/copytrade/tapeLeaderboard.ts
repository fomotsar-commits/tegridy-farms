// THE ISLAND-TAPE BOARD — and the two things it refuses to be.
//
// leaderboard.ts builds a board from indexed router swaps. This builds one from
// pool fills. Same refusal about return, a different source, and one MORE thing
// this source cannot see.
//
// ─── 1. IT IS NOT RANKED BY PROFIT, AND THE NUMBER DOES NOT EXIST ────────────
//
// A pool fill shows both legs of ONE swap. It does not show the round trip: the
// matching exit may be in another pool, on another chain, or a plain transfer,
// and the tape reaches back only as far as GeckoTerminal chose to return for
// each pool. So no realised return can be computed for anybody here, and none
// is. `TAPE_RETURN_RANKING` says that in the words the surface prints.
//
// What IS measurable is GeckoTerminal's own USD valuation of the fills an
// address sent through these pools inside the window that was actually read.
// That is activity, and it is labelled activity everywhere it appears.
//
// ─── 2. THE ADDRESS IS A SENDER, NOT PROVABLY A TRADER ───────────────────────
//
// An indexed swap at least names the wallet that called the router. A pool fill
// names the address that SENT THE TRANSACTION, which is the same party only
// when the trader signed and submitted it themselves. An aggregator, a relayer,
// a trading bot or a smart-contract wallet appears here under its own address
// doing what looks like enormous volume. So this board's subject is "an address
// that sent fills into island pools" — `TAPE_SENDER_NOTICE`, printed above the
// table — and it is never abbreviated to "a trader".
//
// ─── AND ONE ROW PER (NETWORK, ADDRESS) ──────────────────────────────────────
//
// The same 0x address on Ethereum and on Base is TWO rows, deliberately.
// Nothing here proves the two are one party, and a merged row would be an
// identity claim invented by a sort key.

import type { GeckoNetwork } from '../geckoTerminal/pools';
import type { ReturnRankingVerdict } from './leaderboard';
import type { IslandTape, PoolFamily, PoolTapeRead } from './tape';

export interface TapeLeaderRow {
  /** `${network}:${wallet}` — the row's identity, and the reason there is no cross-chain merge. */
  key: string;
  network: GeckoNetwork;
  family: PoolFamily;
  /** The SENDER address, in its family's own form (lowercased hex, exact base58). */
  wallet: string;
  fills: number;
  buys: number;
  sells: number;
  unclassified: number;
  /**
   * Sum of GeckoTerminal's USD valuation over the fills that HAD one.
   *
   * Null when not one fill on this row was priced. Null, not 0: "we were given
   * no value" and "the value was zero" are the same digits and only one of them
   * is a fact this app was told.
   */
  usdVolume: number | null;
  /** Fills upstream returned with no USD valuation. Never folded into the sum. */
  unpricedFills: number;
  /** Pool labels this address was seen in, in first-seen order. */
  poolsTouched: string[];
  largestFillUsd: number | null;
  firstSeen: number;
  lastSeen: number;
  /** The newest fill's hash, already validated for linking, or null. */
  lastTxHash: string | null;
  /** Network of the newest fill — the one an explorer link is built from. */
  lastNetwork: GeckoNetwork;
}

export interface TapeLeaderboard {
  rows: TapeLeaderRow[];
  /** Pools that answered, and pools that did not. BOTH are rendered. */
  poolsRead: PoolTapeRead[];
  poolsUnread: PoolTapeRead[];
  fillsRead: number;
  /** Fills whose sender was absent or unusable upstream — counted, never a row. */
  unattributedFills: number;
  /** Fills dropped for an unparseable timestamp, summed over the pools. */
  undatedFills: number;
  /** Bounds of the fills actually read, unix seconds. Null when none came back. */
  window: { from: number; to: number } | null;
  /** A pool filled its response, so older fills exist and were not read. */
  anyCapped: boolean;
  /** A 429 ended the walk, so some pools were never asked at all. */
  stoppedEarly: boolean;
  fetchedAt: number;
}

export const TAPE_RETURN_RANKING: ReturnRankingVerdict = {
  ranked: false,
  reason:
    'No wallet on this board is ranked by profit. A pool fill shows both sides of one swap but not the round trip: the exit may land in another pool, another chain or a plain transfer this tape cannot see, and the tape reaches back only as far as GeckoTerminal returns for each pool. No realised return exists here for anyone — and a leader’s return would not be yours anyway: you enter after them and exit after them.',
  rankedInstead:
    'Ranked by GeckoTerminal’s USD valuation of the fills this address sent through the island’s pools inside the tape window. That is activity, not skill and not outcome.',
};

export const TAPE_SENDER_NOTICE =
  'The address shown is the one that SENT the transaction. A bot, relayer or contract wallet sends on someone else’s behalf and appears here under its own address.';

export const TAPE_WINDOW_NOTICE =
  'Each pool is read once; what you see is what GeckoTerminal returned for it at that moment, and nothing here streams.';

export const TAPE_CAPPED_NOTICE =
  'At least one pool returned as many fills as the feed gives in a single read, so that pool’s older fills were never looked at. Its counts are a floor and the order below is provisional.';

export const TAPE_EMPTY_AFTER_READ =
  'Every pool was read and no fill came back. That is a measurement about these pools as GeckoTerminal returned them, not about trading anywhere else.';

export interface BuildTapeLeaderboardOptions {
  /** Addresses to leave off — the viewer's own, so the board is other people. */
  exclude?: readonly string[];
}

/**
 * Group tape fills into board rows, or return null.
 *
 * NULL WHEN EVERY POOL IS UNREAD, and that is the whole contract. An object with
 * an empty `rows` array renders as a board, and an empty board on a page headed
 * "wallets trading the island" is a claim about every wallet at once. The caller
 * renders the read ledger instead, which can name each pool and what it
 * answered.
 */
export function buildTapeLeaderboard(
  tape: IslandTape,
  opts: BuildTapeLeaderboardOptions = {},
): TapeLeaderboard | null {
  const poolsRead = tape.reads.filter((r) => r.status === 'read');
  const poolsUnread = tape.reads.filter((r) => r.status !== 'read');
  if (poolsRead.length === 0) return null;

  // Excluded addresses are compared per family: hex is case-insensitive, base58
  // is not. Both forms are kept so one `exclude` list serves both.
  const excludedLower = new Set<string>();
  const excludedExact = new Set<string>();
  for (const a of opts.exclude ?? []) {
    excludedLower.add(a.trim().toLowerCase());
    excludedExact.add(a.trim());
  }

  const byKey = new Map<string, { row: TapeLeaderRow; pools: Set<string> }>();
  let fillsRead = 0;
  let unattributedFills = 0;
  let undatedFills = 0;
  let from: number | null = null;
  let to: number | null = null;
  let anyCapped = false;

  for (const read of poolsRead) {
    if (read.status !== 'read') continue;
    if (read.capped) anyCapped = true;
    undatedFills += read.undated;

    for (const fill of read.fills) {
      fillsRead += 1;
      if (from === null || fill.at < from) from = fill.at;
      if (to === null || fill.at > to) to = fill.at;

      if (fill.wallet === null) {
        // Counted and reported, never a row and never dropped in silence: a
        // shrinking fill count with no explanation reads as a quiet market.
        unattributedFills += 1;
        continue;
      }
      const excluded =
        fill.pool.family === 'solana' ? excludedExact.has(fill.wallet) : excludedLower.has(fill.wallet);
      if (excluded) continue;

      const key = `${fill.pool.network}:${fill.wallet}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          row: {
            key,
            network: fill.pool.network,
            family: fill.pool.family,
            wallet: fill.wallet,
            fills: 0,
            buys: 0,
            sells: 0,
            unclassified: 0,
            usdVolume: null,
            unpricedFills: 0,
            poolsTouched: [],
            largestFillUsd: null,
            firstSeen: fill.at,
            lastSeen: fill.at,
            lastTxHash: fill.txHash,
            lastNetwork: fill.pool.network,
          },
          pools: new Set<string>(),
        };
        byKey.set(key, entry);
      }

      const row = entry.row;
      row.fills += 1;
      if (fill.side === 'buy') row.buys += 1;
      else if (fill.side === 'sell') row.sells += 1;
      else row.unclassified += 1;

      if (fill.usd === null) {
        row.unpricedFills += 1;
      } else {
        row.usdVolume = (row.usdVolume === null ? 0 : row.usdVolume) + fill.usd;
        if (row.largestFillUsd === null || fill.usd > row.largestFillUsd) row.largestFillUsd = fill.usd;
      }

      if (!entry.pools.has(fill.pool.label)) {
        entry.pools.add(fill.pool.label);
        row.poolsTouched.push(fill.pool.label);
      }

      if (fill.at < row.firstSeen) row.firstSeen = fill.at;
      if (fill.at >= row.lastSeen) {
        row.lastSeen = fill.at;
        row.lastTxHash = fill.txHash;
        row.lastNetwork = fill.pool.network;
      }
    }
  }

  // Priced rows first, ordered by the figure the header names. An unpriced row
  // sorts BELOW every priced one rather than being dropped or read as zero
  // volume: it is real activity whose size upstream declined to state.
  // Deterministic to the last tie-break, because movement on a board is
  // supposed to mean something.
  const rows = [...byKey.values()].map((e) => e.row);
  rows.sort((a, b) => {
    const av = a.usdVolume;
    const bv = b.usdVolume;
    if (av !== null && bv === null) return -1;
    if (av === null && bv !== null) return 1;
    if (av !== null && bv !== null && av !== bv) return bv - av;
    if (a.fills !== b.fills) return b.fills - a.fills;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return {
    rows,
    poolsRead,
    poolsUnread,
    fillsRead,
    unattributedFills,
    undatedFills,
    window: from !== null && to !== null ? { from, to } : null,
    anyCapped,
    stoppedEarly: tape.stoppedEarly,
    fetchedAt: tape.fetchedAt,
  };
}
