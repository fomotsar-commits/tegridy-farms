// Season definitions for the trading competitions board.
//
// ─── A SCOREBOARD, AND NOTHING ELSE ──────────────────────────────────────────
//
// A season here has no prize pool, no escrow, no contract and no payout path.
// That is a deliberate shape, not an unfinished one: this venue may not spend
// capital it has not earned, so a competition that advertised a reward before a
// funded, immutable contract existed to pay it would be promising money that is
// not there. `SETTLEMENT` is the sentence the surfaces render, and every field
// that could hold a prize is absent from the type rather than present and null —
// an optional prize field is an invitation to fill it in from a config.
//
// ─── AND NOTHING ENDS IT ─────────────────────────────────────────────────────
//
// There is no keeper on this venue. No cron closes a season, snapshots a winner,
// or freezes a standing. `status()` is derived from the clock at read time and
// standings are recomputed from indexed history on every read, so an "ended"
// season is a statement about the date and not about anything having been
// settled. A surface that implied a final result would be implying a process
// that does not exist.

export interface Season {
  /** Stable slug — used in URLs and as a React key. */
  id: string;
  name: string;
  /** Unix seconds, inclusive. */
  startsAt: number;
  /** Unix seconds, inclusive. */
  endsAt: number;
  /**
   * The single token volume is measured in. Everything else a competitor spends
   * is counted as activity and never added to a total: the indexer stores no
   * rate, so a cross-token sum would have no unit while still looking like one.
   */
  quoteToken: string;
  /** Rendered on the season card so the scoring rule travels with the season. */
  blurb: string;
}

export const SETTLEMENT =
  'This is a scoreboard. There is no prize pool, nothing is escrowed, no contract holds funds for it, and no process closes a season — standings are recomputed from indexed history every time this page is read.';

/**
 * What a season card says when nothing is reading it.
 *
 * The status line used to be derived from `Date.now()` alone, so an unhosted
 * indexer still produced "Counting now. Every figure moves as new swaps are
 * indexed." — a sentence about a process that was not running, printed with
 * total confidence because the clock had no idea. A status is now only shown
 * when a source has reported a head time; otherwise this sentence is, which
 * says the dates are real and the counting is not.
 */
export const SEASON_NO_SOURCE =
  'These dates are calendar facts. No source in this build is reading this season, so nothing is being counted here.';

export type SeasonStatus = 'upcoming' | 'live' | 'ended';

export function seasonStatus(season: Season, now: number): SeasonStatus {
  if (now < season.startsAt) return 'upcoming';
  if (now > season.endsAt) return 'ended';
  return 'live';
}

export const SEASON_STATUS_TEXT: Record<SeasonStatus, string> = {
  upcoming: 'Has not started. Nothing is being counted yet.',
  live: 'Counting now. Every figure moves as new router swaps are read by the indexer.',
  ended:
    'The dates have passed. Nothing was settled and no result was frozen — this is the same live recomputation, over a window that is now in the past.',
};

/**
 * `where` clause for the shared INDEXED_SWAPS_QUERY document.
 *
 * Both bounds are sent so an ended season stops at its own end rather than
 * running to the head of the chain. uint256 columns travel as decimal strings;
 * `_gte` / `_lte` are Ponder's generated numeric filter suffixes.
 */
export function seasonWhere(season: Season): Record<string, unknown> {
  return {
    timestamp_gte: Math.max(0, Math.floor(season.startsAt)).toString(),
    timestamp_lte: Math.max(0, Math.floor(season.endsAt)).toString(),
  };
}

/** Seconds in a day, used only to keep the season table below readable. */
const DAY = 86_400;

/**
 * The declared seasons.
 *
 * Dates are fixed rather than rolling. A season that silently re-based itself on
 * the current date would make every past standing unreproducible: the same page,
 * read a week later, would rank a different window under the same name.
 */
export const SEASONS: readonly Season[] = [
  {
    id: 'weth-s1',
    name: 'Season 1 — ETH/WETH volume',
    // 2026-09-01T00:00:00Z → 2026-09-30T23:59:59Z
    startsAt: 1_788_220_800,
    endsAt: 1_788_220_800 + 30 * DAY - 1,
    quoteToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    blurb:
      'Volume is ETH or WETH spent through the venue router (native ETH and WETH are one side). Round trips that reverse inside the wash window are removed from both sides.',
  },
];

export function findSeason(id: string): Season | null {
  return SEASONS.find((s) => s.id === id) ?? null;
}
