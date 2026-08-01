import { CURRENT_SEASON } from './constants';

/**
 * Engagement-season phase, derived from the CURRENT_SEASON window.
 *
 * The Farm "Season" stat used to render `Math.max(0, ceil((end - now)/day))` directly,
 * which clamps to a permanent "0d left" the day after `endDate` — a countdown that
 * never stops counting down is the same defect class as the "+10% NFT boost" banner
 * that shipped past its window. The Leaderboard had no date check at all and would
 * keep inviting people to earn points in a season that had closed.
 *
 * So: an expired window renders AS expired, an un-started one AS upcoming, and an
 * unparseable one AS unknown — never as a confident number and never as a silent zero.
 */
export type SeasonPhase = 'unknown' | 'upcoming' | 'active' | 'ended';

export interface SeasonStatus {
  phase: SeasonPhase;
  /** Whole days left while `active`, whole days until start while `upcoming`, else 0. */
  days: number;
  /** Short value for the Farm "Season" stat tile. */
  shortLabel: string;
}

/** Season windows are plain `YYYY-MM-DD`, which Date.parse reads as UTC midnight. */
const DAY_MS = 86_400_000;

export function seasonStatus(
  now: number = Date.now(),
  season: { startDate: string; endDate: string } = CURRENT_SEASON,
): SeasonStatus {
  const start = Date.parse(season.startDate);
  const end = Date.parse(season.endDate);
  // A malformed window must not masquerade as a live season.
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { phase: 'unknown', days: 0, shortLabel: '–' };
  }
  if (now < start) {
    return { phase: 'upcoming', days: Math.ceil((start - now) / DAY_MS), shortLabel: `starts in ${Math.ceil((start - now) / DAY_MS)}d` };
  }
  if (now >= end) {
    return { phase: 'ended', days: 0, shortLabel: 'Ended' };
  }
  const days = Math.ceil((end - now) / DAY_MS);
  return { phase: 'active', days, shortLabel: `${days}d left` };
}
