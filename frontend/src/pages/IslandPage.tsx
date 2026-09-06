import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { ISLAND_SECTION } from '../lib/navConfig';
import { VENUE } from '../lib/arrival';
import { FlamesBoard } from '../components/FlamesBoard';

/**
 * The four-piece arrival film, on demand.
 *
 * Lazy on purpose: AppLoader and its eight phase modules and three fx modules are
 * ~93 KB, and PERF-16 went to real trouble to keep them out of the entry chunk.
 * Importing it eagerly here would put the whole intro into the Island lobby's
 * chunk instead, which is the same mistake wearing a different hat.
 */
const ArrivalFilm = lazy(() =>
  import('../components/loader/AppLoader').then((m) => ({ default: m.AppLoader })),
);

/**
 * IslandPage — the lobby behind the "Island" word.
 *
 * ⚠️ THE ONE SECTION THAT IS NOT A SectionHost, and the reason is structural
 * rather than aesthetic. Every other section's items are pages with no tab bar
 * of their own, so a strip above them is free. Island's are not: /community,
 * /leaderboard (ActivityPage) and /tokenomics (StatsPage) EACH already own a tab
 * strip, and a route renders exactly one — the same constraint the old Stats
 * section's comment was written about. A strip here would either nest two bars
 * or force three hosts to give theirs up.
 *
 * /nakamigos settles it independently: App.tsx mounts `nakamigos/*` OUTSIDE
 * AppLayout, as its own route tree, so it could never render inside a host's
 * panel at all.
 *
 * So: cards, one per door. A tab strip is for switching between sibling views of
 * ONE subject; this is five different subjects that share a place. The cards say
 * that, and every destination keeps the strip it already had.
 *
 * THE LIST IS NOT RE-TYPED HERE. It is `ISLAND_SECTION.items` minus this page
 * itself, so a destination cannot be added to the nav and forgotten on the
 * lobby, and the gating (Community rides COMMUNITY_LIVE) is honoured once. The
 * blurbs are keyed by route — an entry with no blurb still renders, with its
 * label alone, rather than vanishing.
 */

/** One line per door: what is actually behind it. Keyed by route. */
const BLURB: Record<string, string> = {
  '/gallery': 'Every piece the collective has made, and the artists behind them.',
  '/nakamigos': 'Buy and sell the art. Our fee is 1% — the same as OpenSea, not a discount.',
  '/community': 'Grants, bounties and the votes that direct them.',
  '/leaderboard': 'How the venue scores wallets, and where yours sits.',
  '/tokenomics': 'Supply, the treasury, lifetime fees, and your own tax reports.',
};

export default function IslandPage() {
  usePageTitle('The island', `${VENUE.tagline}. The gallery, the marketplace, the community and the numbers.`);

  // Drop the lobby's own entry — a card linking to the page you are standing on
  // is a dead click. Keyed on the section's OWN hub rather than the literal
  // '/island': navConfig.test.ts pins `hub === items[0].to`, so this is exactly
  // "the lobby itself" for any future value of that route, and it makes the
  // "not re-typed here" claim above literally true.
  const doors = ISLAND_SECTION.items.filter((i) => i.to !== ISLAND_SECTION.hub);

  // The arrival film, mounted only when somebody asks for it. It clears itself
  // through onComplete, which the loader fires on its own exit or on Escape.
  const [watching, setWatching] = useState(false);

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-8 sm:py-10">
      <header className="mb-7">
        <p className="text-[11px] uppercase tracking-wider label-pill mb-2" style={{ color: 'var(--color-kyle)' }}>
          Jungle Bay Island
        </p>
        <h1 className="heading-luxury text-3xl md:text-4xl text-white leading-tight mb-3">
          The island
        </h1>
        <p className="text-white/75 text-[14px] md:text-[15px] leading-relaxed max-w-[62ch]">
          The place itself — its art, its people, its score and its money. Everything here is
          about the venue rather than about a trade.
        </p>
      </header>

      {/* WAVE SEVEN, element G: the lobby OPENS with the board. Twenty-five rows here
          rather than the home's five, because someone who walked to /island came
          looking for the island itself, not for a taste of it. It unmounts itself when
          the island's board is off, so the five door cards below are never left
          hanging under an empty heading. */}
      <FlamesBoard limit={25} />

      {/* WAVE SEVEN, elements G and A: THE FILM'S HOME.
          The arrival's curtain is one art piece and about two and a half seconds
          now. The full four-piece film — the void, the gallery, the shatter, the
          vortex, the wordmark forming and the crack on the way out — is not cut;
          it lives here, for somebody who came to the island to look at it. That
          is the whole reason element A was allowed to shorten the arrival: the
          art is re-homed, never removed.

          Lazy, so the ~93 KB of choreography is fetched only by a visitor who
          actually asks for it. Nothing on this page pays for it otherwise. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-5 text-[13px]">
        <Link
          to="/#hall"
          className="underline underline-offset-4 text-white/70 hover:text-white transition-colors"
        >
          The bungalows
        </Link>
        <button
          type="button"
          onClick={() => setWatching(true)}
          className="underline underline-offset-4 transition-colors hover:brightness-125"
          style={{ color: 'var(--color-kyle)' }}
        >
          Watch the arrival
        </button>
      </div>

      {watching && (
        <Suspense fallback={null}>
          <ArrivalFilm full onComplete={() => setWatching(false)} />
        </Suspense>
      )}

      {/* NO ArtImg ON THESE CARDS, DELIBERATELY. Every art-backed surface in
          this app is a registered (pageId, idx) in the studio inventory with a
          pool behind it — artStudioCoverage.test.ts enforces the registration
          and /art-studio has to be able to place it. Inventing a new surface for
          a lobby that is five links is more machinery than the page earns, and
          an unregistered ArtImg reds CI. `.glass-card` is the repo's existing
          chrome for exactly this. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {doors.map((door) => (
          <Link
            key={door.to}
            to={door.to}
            className="glass-card rounded-2xl min-h-[112px] flex flex-col justify-center p-4 transition-all hover:brightness-125"
          >
            <span className="flex items-center gap-2">
              <span className="text-white text-[15px] font-semibold">{door.label}</span>
              {door.soon && (
                <span className="rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-semibold leading-none px-1.5 py-0.5 uppercase tracking-wide">
                  Soon
                </span>
              )}
            </span>
            {BLURB[door.to] && (
              <span className="mt-1 text-white/65 text-[12.5px] leading-relaxed">{BLURB[door.to]}</span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
