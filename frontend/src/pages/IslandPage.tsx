import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { ISLAND_SECTION } from '../lib/navConfig';
import { VENUE } from '../lib/arrival';
import { FlamesBoard } from '../components/FlamesBoard';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { CardArt } from '../components/ui/CardArt';
import { IslandSoundLinks } from '../components/IslandSound';

/** The four-piece arrival film, on demand. Lazy: its ~93 KB stay out of this page's chunk
 *  and out of the entry chunk (PERF-16). */
const ArrivalFilm = lazy(() =>
  import('../components/loader/AppLoader').then((m) => ({ default: m.AppLoader })),
);

/**
 * The lobby behind the drawer's Island row: cards, one per door, never a tab strip. /community
 * and /tokenomics each own a strip already and a route renders one; /nakamigos renders outside
 * AppLayout. The doors are `ISLAND_SECTION.items` minus this page, so nav and lobby cannot
 * drift; a blurb is keyed by route, and a door without one keeps its label.
 */

/** One line per door: what is actually behind it. Keyed by route. */
const BLURB: Record<string, string> = {
  '/gallery': 'Every piece, and the artists behind them.',
  '/nakamigos': 'Trade four collections, browse five more. Our fee is 1%, the same as OpenSea.',
  '/community': 'Grants, bounties and the votes that direct them.',
  '/tokenomics': 'Supply, the treasury, lifetime fees, and your own tax reports.',
};

/** Each door's own art surface (lib/artSurfaces.ts), by route: by position, a door leaving
 *  the nav moved the next one onto its painting. Slot 4 was Venue Score's. */
const DOOR_ART: Record<string, number> = {
  '/gallery': 1,
  '/nakamigos': 2,
  '/community': 3,
  '/tokenomics': 5,
};

/** Registered door surfaces (island idx 1 to 5): a door with none reuses one in turn. */
const DOOR_ART_SLOTS = 5;

export default function IslandPage() {
  usePageTitle('The island', `${VENUE.tagline}. The gallery, the marketplace, the community and the numbers.`);

  // Not the lobby's own entry: a card to the page you are on is a dead click.
  const doors = ISLAND_SECTION.items.filter((i) => i.to !== ISLAND_SECTION.hub);

  // The arrival film, mounted only when somebody asks for it. It clears itself
  // through onComplete, which the loader fires on its own exit or on Escape.
  const [watching, setWatching] = useState(false);

  return (
    <>
    <PageArtBackdrop pageId="island" />
    <div className="relative z-10 mx-auto w-full max-w-[900px] px-4 py-8 sm:py-10">
      <header className="mb-7">
        <p className="text-[11px] uppercase tracking-wider label-pill mb-2" style={{ color: 'var(--color-kyle)' }}>
          Jungle Bay Island
        </p>
        <h1 className="heading-luxury text-3xl md:text-4xl text-white leading-tight mb-3">
          The island
        </h1>
        <p className="text-white/75 text-[14px] md:text-[15px] leading-relaxed max-w-[62ch]">
          The place itself: its art, its people and its money.
        </p>
      </header>

      {/* WAVE SEVEN, element G: the lobby OPENS with the board. Twenty-five rows here
          rather than the home's five, because someone who walked to /island came
          looking for the island itself, not for a taste of it. It unmounts itself when
          the island's board is off, so the five door cards below are never left
          hanging under an empty heading. */}
      <FlamesBoard limit={25} />

      {/* The full arrival film lives here and nowhere else (answer ten took it off every route):
          for somebody who came to the island to look at it. Fetched only when asked for. */}
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
          <ArrivalFilm onComplete={() => setWatching(false)} />
        </Suspense>
      )}

      {/* One art surface per door, registered in lib/artSurfaces.ts so a studio can place each
          (owner, 2026-10-03: art on every card). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {doors.map((door, i) => (
          <Link
            key={door.to}
            to={door.to}
            className="glass-card relative isolate rounded-2xl min-h-[112px] flex flex-col justify-center p-4 transition-all hover:brightness-125"
          >
            <CardArt pageId="island" idx={DOOR_ART[door.to] ?? 1 + (i % DOOR_ART_SLOTS)} />
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

      <p className="mt-6 text-white/60 text-[12px]">
        sound of the island · <IslandSoundLinks />
      </p>
    </div>
    </>
  );
}
