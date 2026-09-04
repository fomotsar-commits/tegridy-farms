import {
  SEASON_NO_SOURCE,
  SEASON_STATUS_TEXT,
  seasonStatus,
  type Season,
} from '../../lib/competitions/season';

// THE ROUTER SEASON'S CARD, WITH ITS STATUS TIED TO A SOURCE.
//
// The status used to come from `Date.now()`: inside the declared dates the page
// said "Counting now", which was true about the calendar and false about
// everything else — no indexer is hosted, so nothing was counting. A clock knows
// what day it is and nothing whatsoever about whether a season is being read.
//
// So the status line is SOURCE-CONDITIONAL. `syncedAt` is the head timestamp a
// reader actually reported; with one, the season's own status text is shown and
// derived from that same read. With none, the card says the dates are calendar
// facts and that nothing is reading them.

export interface SeasonCardProps {
  seasons: readonly Season[];
  season: Season;
  onSeasonChange: (id: string) => void;
  /**
   * Head timestamp of whatever is reading this season, in unix seconds, or null
   * when nothing is. Never defaulted to now — a default here is the whole bug.
   */
  syncedAt: number | null;
}

function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function SeasonCard({ seasons, season, onSeasonChange, syncedAt }: SeasonCardProps) {
  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label
          htmlFor="competition-season"
          className="text-[11px] font-medium uppercase tracking-wide text-white/60"
        >
          Season
          <select
            id="competition-season"
            value={season.id}
            onChange={(e) => onSeasonChange(e.target.value)}
            className="mt-1 block min-h-[44px] rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
          >
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[11px] leading-relaxed text-white/70">
          {utcDay(season.startsAt)} to {utcDay(season.endsAt)} (UTC).
        </p>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-white/75">{season.blurb}</p>

      <p className="mt-2 text-[11px] leading-relaxed text-white/70">
        {syncedAt === null ? SEASON_NO_SOURCE : SEASON_STATUS_TEXT[seasonStatus(season, syncedAt)]}
      </p>
    </section>
  );
}
