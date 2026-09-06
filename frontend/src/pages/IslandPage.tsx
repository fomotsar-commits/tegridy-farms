import { Link } from 'react-router-dom';
import { usePageTitle } from '../hooks/usePageTitle';
import { ISLAND_SECTION } from '../lib/navConfig';
import { VENUE } from '../lib/arrival';
import { FlamesBoard } from '../components/FlamesBoard';

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
