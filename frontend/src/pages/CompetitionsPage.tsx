import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { useCompetitionStandings } from '../hooks/useCompetitionStandings';
import { CompetitionDataNotice } from '../components/competitions/CompetitionDataNotice';
import { ScoringRules } from '../components/competitions/ScoringRules';
import { StandingsTable } from '../components/competitions/StandingsTable';
import { SEASONS, SEASON_STATUS_TEXT, seasonStatus } from '../lib/competitions/season';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// TRADING COMPETITIONS — seasonal volume boards scored from indexed history.
//
// The page makes three refusals, all of them enforced in lib/competitions rather
// than here:
//
//   1. No prize and no settlement. Nothing is escrowed and nothing closes a
//      season, because there is no keeper on this venue and no funded contract
//      to pay one — season.ts, SETTLEMENT.
//   2. No profit board. Indexed swaps record what was spent and never what came
//      back, so a season return exists for nobody — scoring.ts, PNL_SCORING.
//   3. Wash resistance, WITH its limits. A self-reversal inside the window is
//      struck from both sides; two wallets colluding are invisible and the page
//      says so — scoring.ts, RESISTANCE_RULE and RESISTANCE_LIMITS.
//
// The indexer is not hosted, so the resting state is `unavailable` and the table
// is not drawn at all. An empty standings table under a season name is the
// clearest fabricated zero available here: it asserts that nobody entered.

export default function CompetitionsPage() {
  usePageTitle(
    'Trading Competitions',
    'Seasonal volume boards scored from indexed swap history, with self-reversals struck from both sides. No prize pool, no settlement, and no profit ranking — indexed swaps record what was spent and never what came back.',
  );

  const { address } = useAccount();
  const [seasonId, setSeasonId] = useState(SEASONS[0]?.id ?? '');
  const season = useMemo(() => SEASONS.find((s) => s.id === seasonId) ?? SEASONS[0] ?? null, [seasonId]);

  const now = Math.floor(Date.now() / 1000);
  const standings = useCompetitionStandings({ season });

  if (!season) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-bold text-white">Trading Competitions</h1>
        <p className="mt-2 text-sm text-white/75">
          No season is declared in this build, so there is nothing to score. This is a statement
          about the configuration, not about the venue.
        </p>
      </div>
    );
  }

  const status = seasonStatus(season, now);

  return (
    <div className="relative">
      <PageArtBackdrop pageId="competitions" />
      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Trading Competitions</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
            A season ranks wallets by how much of one named token they put through the venue's
            router, with self-reversals removed from both sides so a wallet cannot climb by selling
            back what it just bought. It ranks activity. It does not rank profit, and it does not
            pay anything.
          </p>
        </header>

        <div className="mt-6 space-y-6">
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
                  onChange={(e) => setSeasonId(e.target.value)}
                  className="mt-1 block rounded-md border border-white/20 bg-black/40 px-2 py-1 text-xs text-white"
                >
                  {SEASONS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] leading-relaxed text-white/70">
                {new Date(season.startsAt * 1000).toISOString().slice(0, 10)} →{' '}
                {new Date(season.endsAt * 1000).toISOString().slice(0, 10)} (UTC). {SEASON_STATUS_TEXT[status]}
              </p>
            </div>
          </section>

          <ScoringRules />

          <CompetitionDataNotice
            status={standings.status}
            detail={standings.detail}
            syncedAt={standings.syncedAt}
            onRetry={standings.reload}
          />

          {standings.standings ? (
            <StandingsTable standings={standings.standings} account={address ?? null} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
