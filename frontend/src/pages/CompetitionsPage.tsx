import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { usePageTitle } from '../hooks/usePageTitle';
import { useCompetitionStandings } from '../hooks/useCompetitionStandings';
import { useIslandCup } from '../hooks/useIslandCup';
import { CompetitionDataNotice } from '../components/competitions/CompetitionDataNotice';
import { CupBoard } from '../components/competitions/CupBoard';
import { CupCoverageNotice } from '../components/competitions/CupCoverageNotice';
import { ScoringRules } from '../components/competitions/ScoringRules';
import { SeasonCard } from '../components/competitions/SeasonCard';
import { StandingsTable } from '../components/competitions/StandingsTable';
import { YourRank } from '../components/competitions/YourRank';
import { SEASONS } from '../lib/competitions/season';
import { PageArtBackdrop } from '../components/PageArtBackdrop';

// TRADING COMPETITIONS — two boards, each named by what actually reads it.
//
// THE ISLAND CUP is live. It ranks senders by the USD size of the fills
// GeckoTerminal reports on the island's own registered pools — the same feed the
// bungalow trade tapes already read, browser-direct, no key and no server of
// ours in the path. Everything it claims is measured: the window comes from the
// fills' own block timestamps, and every pool that failed or filled its page is
// named above the table.
//
// SEASON 1 is the venue router's own swaps out of a Ponder indexer that is
// hosted nowhere. Its card says so rather than printing a clock-derived
// "counting now" about a process that is not running.
//
// The page makes four refusals, all of them enforced in lib/competitions rather
// than here:
//
//   1. No prize and no settlement. Nothing is escrowed and nothing closes a
//      season, because there is no keeper on this venue and no funded contract
//      to pay one — season.ts, SETTLEMENT.
//   2. No profit board. A swap row and a trade feed each give ONE leg, so a
//      season return exists for nobody — scoring.ts, PNL_SCORING.
//   3. Wash resistance, WITH its limits. A self-reversal inside the window is
//      struck from both sides; two wallets colluding are invisible, and a round
//      trip straddling the window start cannot be struck — scoring.ts
//      RESISTANCE_RULE / RESISTANCE_LIMITS and islandCup.ts CUP_WASH_LIMIT.
//   4. A pool that could not be read is not a quiet pool. An unread board draws
//      no table at all: an empty leaderboard under a season name asserts that
//      nobody entered, which on this page is the most damaging thing it could
//      say and the easiest to say by accident.
//
// NO CLOCK IS READ IN THIS FILE. Every time on screen is a block timestamp from
// the data, or a season's own declared date.

export default function CompetitionsPage() {
  usePageTitle(
    'Trading Competitions',
    "The Island Cup ranks senders by the USD size of the fills GeckoTerminal reports on the island's own pools, with self-reversals struck from both sides and every unread pool named. No prize pool, no settlement, and no profit ranking.",
  );

  const { address } = useAccount();
  const [seasonId, setSeasonId] = useState(SEASONS[0]?.id ?? '');
  const season = useMemo(() => SEASONS.find((s) => s.id === seasonId) ?? SEASONS[0] ?? null, [seasonId]);

  const cup = useIslandCup();
  const standings = useCompetitionStandings({ season });

  return (
    <div className="relative">
      <PageArtBackdrop pageId="competitions" />
      <div className="relative z-10 mx-auto w-full max-w-5xl px-4 py-8">
        <header>
          <h1 className="text-2xl font-bold text-white">Trading Competitions</h1>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-white/75">
            Two boards, each ranking activity and neither ranking profit. The Island Cup is scored
            from the trade feeds of the island's own registered pools, over the widest window every
            pool that answered can speak for. Season 1 is scored from the venue router's swaps,
            whenever something is reading them. Nothing here pays anything, and nothing closes.
          </p>
        </header>

        <div className="mt-6 grid grid-cols-1 gap-6">
          <CupCoverageNotice
            status={cup.status}
            coverage={cup.coverage}
            poolsTotal={cup.poolsTotal}
            onReload={cup.reload}
          />

          {cup.board ? (
            <CupBoard
              board={cup.board}
              status={cup.status === 'complete' ? 'complete' : 'partial'}
              account={address ?? null}
            />
          ) : null}

          {cup.board ? (
            <YourRank
              board={cup.board}
              status={cup.status === 'complete' ? 'complete' : 'partial'}
              account={address ?? null}
            />
          ) : null}

          <ScoringRules />

          {season ? (
            <SeasonCard
              seasons={SEASONS}
              season={season}
              onSeasonChange={setSeasonId}
              syncedAt={standings.syncedAt}
            />
          ) : (
            <section className="rounded-xl border border-white/15 bg-white/[0.02] p-4">
              <h2 className="text-sm font-semibold text-white">No season is declared</h2>
              <p className="mt-1.5 text-xs leading-relaxed text-white/75">
                This build declares no router season, so there is nothing to score for one. That is
                a statement about the configuration, not about the venue.
              </p>
            </section>
          )}

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
