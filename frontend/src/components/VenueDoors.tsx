import type { CSSProperties } from 'react';
import { artSrcSet } from '../lib/artSrcSet';
import { Link } from 'react-router-dom';
import { m } from 'framer-motion';
import { BUNGALOWS, type Bungalow } from '../lib/bungalows';
import DOOR_THUMB_LUMA from '../lib/doorThumbLuma.generated.json';

const LUMA = DOOR_THUMB_LUMA as Record<string, number>;

/**
 * The filter a dimmed door wears.
 *
 * `grayscale(1)` alone was the whole treatment, and desaturation says nothing
 * about LIGHTNESS — so each tile landed wherever its painting's own exposure put
 * it. Measured across the door thumbnails that was a 3.1x spread (0.270 for
 * wrestler.jpg up to 0.841 for mumu-bull.jpg), which is why a few doors read as
 * switched off while others read as barely dimmed. The per-image multiplier is
 * measured at build time by scripts/generate-image-derivatives.mjs; see its
 * LUMA_TARGET comment for why the target is the set's own median.
 *
 * A thumbnail with no measurement keeps plain `grayscale(1)` — exactly the
 * previous behaviour — so a missing manifest degrades to "not normalised"
 * rather than to an unstyled or invisible tile.
 */
function dimmedFilter(thumb: string): string {
  const k = LUMA[thumb];
  return k ? `grayscale(1) brightness(${k})` : 'grayscale(1)';
}

/**
 * THE HALL OF DOORS — the venue arrival's island map.
 *
 * ARRIVAL IDENTITY 2026-08-31 (island order): memetics.finance opens as the
 * island itself, and the island is its bungalows. The venue home shows every
 * door in one hall: the open doors lit in their own accent, the settled doors
 * greyed while their communities move in, the unmarked spot dark. This is the
 * visible version of the BungalowPicker modal, rendered in the venue's own
 * voice only (HomePage gates it off for toweli and identity arrivals).
 *
 * WHICH DOORS COUNT AS OPEN is the island's word, not a registry read:
 * a door is OPEN when its full experience is finished (its own art, its own
 * voice, its own walls) — TOWELI (the classic experience, whole) and BAYLA
 * (the muse's canon skin) today. The other residents are live in placeholder
 * skins ("their voice now, their art later"), which the island presents as
 * SETTLED: greyed in the hall, door still walkable to the plaque landing
 * (contract, trade route, market, heat). When the island words another door
 * open, move its id into OPEN_DOOR_IDS — nothing else changes.
 *
 * Honesty rules, same bar as VenueHero:
 *  - Registry-driven: every tile reads lib/bungalows.ts; nothing invented.
 *  - No certification claim, no yield numbers, no dates.
 *  - Zero Tegridy strings in the hall: the classic door shows its NAME
 *    (Toweli), and the classic branding stays behind it.
 */
export const OPEN_DOOR_IDS = new Set(['toweli', 'bayla']);

const CHAIN_LABEL: Record<Bungalow['chain'], string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
  tbd: 'TBD',
};

type DoorState = 'open' | 'settled' | 'quiet';

export function doorState(b: Bungalow): DoorState {
  if (b.chain === 'tbd') return 'quiet';
  return OPEN_DOOR_IDS.has(b.id) ? 'open' : 'settled';
}

const CHIP: Record<DoorState, { label: string; style: CSSProperties }> = {
  open: {
    label: 'LIVE',
    style: {
      background: 'rgba(45,139,78,0.9)',
      color: '#eafff2',
      border: '1px solid rgba(140,240,190,0.6)',
    },
  },
  settled: {
    label: 'SETTLED',
    style: {
      background: 'rgba(0,0,0,0.72)',
      color: 'rgba(255,255,255,0.72)',
      border: '1px solid rgba(255,255,255,0.22)',
    },
  },
  quiet: {
    label: 'QUIET',
    style: {
      background: 'rgba(0,0,0,0.72)',
      color: 'rgba(255,255,255,0.5)',
      border: '1px solid rgba(255,255,255,0.14)',
    },
  },
};

function DoorTile({ bungalow }: { bungalow: Bungalow }) {
  const state = doorState(bungalow);
  const chip = CHIP[state];

  const face = (
    <>
      <div className="h-28 md:h-32 w-full overflow-hidden">
        {/* RESPONSIVE, 2026-09-04. These 13 door thumbnails were the single
            largest block of wasted bytes on the homepage: each renders at
            271x128 while its source is up to 2048px wide, and there are
            thirteen of them. `sizes` is EXPLICIT rather than `auto` because
            this slot's width is genuinely known — a card in the grid, never
            more than ~300 CSS px — and an explicit value works in every
            browser rather than only those that support `sizes=auto`.
            srcSet is undefined for any source with no derivative, in which
            case this renders exactly as it did before. */}
        <img
          src={bungalow.thumb}
          {...(artSrcSet(bungalow.thumb)
            ? { srcSet: artSrcSet(bungalow.thumb), sizes: '(max-width: 640px) 50vw, 300px' }
            : {})}
          alt=""
          loading="lazy"
          decoding="async"
          width={300}
          height={128}
          className={`w-full h-full object-cover transition-transform duration-500 ${
            state === 'open' ? 'group-hover:scale-[1.06]' : ''
          }`}
          style={{
            ...(bungalow.thumbPosition ? { objectPosition: bungalow.thumbPosition } : {}),
            // The `grayscale` utility class moved in here so the desaturation and
            // the per-image brightness are ONE declaration. Tailwind's filter
            // utilities and an inline `filter` overwrite each other rather than
            // composing, so keeping the class as well would have silently dropped
            // whichever lost.
            ...(state === 'open' ? {} : { filter: dimmedFilter(bungalow.thumb) }),
          }}
        />
      </div>
      <span
        className="absolute top-2 right-2 text-[9px] font-bold tracking-[0.14em] rounded-full px-2 py-0.5"
        style={chip.style}
      >
        {chip.label}
      </span>
      {/* LABEL PLATE, not a gradient (2026-09-04 field review). This used to be
          a separate 64px gradient scrim fading up from the bottom edge, which
          made the label's contrast a property of whichever painting happened to
          be behind it: mid-grey type over mid-grey art disappeared on the dark
          tiles and washed out on the light ones, and it failed in BOTH
          directions because the label colour is fixed and the backdrop is not.

          A solid band makes that contrast a constant we control. It is painted
          on the label's own container rather than as a fixed-height sibling so
          it always covers exactly the text that exists — the quiet tile's
          plaque line wraps to a different height than a symbol-plus-chain, and
          a fixed 52px band would have clipped one or floated above the other. */}
      <div
        className="absolute inset-x-0 bottom-0 p-2.5"
        style={{ background: 'rgba(3,7,14,0.92)' }}
      >
        {/* Kept as insurance: if the plate is ever made more translucent for
            art reasons, the type must not silently become unreadable again. */}
        <p className="text-white text-[13px] font-semibold leading-tight" style={{ textShadow: '0 1px 5px rgba(0,0,0,0.95)' }}>
          {bungalow.symbol}
        </p>
        <p className="text-white/70 text-[10.5px] leading-tight">
          {/* The quiet spot whispers its plaque line instead of a chain. */}
          {state === 'quiet' ? bungalow.tagline : <>{bungalow.name} &middot; {CHAIN_LABEL[bungalow.chain]}</>}
        </p>
      </div>
    </>
  );

  const frame: CSSProperties =
    state === 'open'
      ? {
          border: `1px solid ${bungalow.accent ?? 'var(--color-kyle)'}`,
          boxShadow: `0 0 18px -6px ${bungalow.accent ?? 'rgba(111,217,168,0.8)'}`,
          background: 'rgba(4,9,18,0.85)',
        }
      : {
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(4,9,18,0.85)',
        };

  if (state === 'quiet') {
    return (
      <div
        className="relative rounded-xl overflow-hidden opacity-45"
        style={frame}
        aria-label={`${bungalow.name} spot: quiet. ${bungalow.tagline}`}
      >
        {face}
      </div>
    );
  }

  return (
    <Link
      to={`/${bungalow.id}`}
      aria-label={
        state === 'open'
          ? `Enter the ${bungalow.name} bungalow (${bungalow.symbol}, live)`
          : `${bungalow.name} bungalow (${bungalow.symbol}), settled and building. Open its plaque.`
      }
      className={`group relative block rounded-xl overflow-hidden transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8ef0d8] ${
        state === 'open' ? 'hover:scale-[1.03]' : 'opacity-75 hover:opacity-100'
      }`}
      style={frame}
    >
      {face}
    </Link>
  );
}

export function VenueDoors() {
  const openCount = BUNGALOWS.filter((b) => doorState(b) === 'open').length;
  return (
    <m.section
      className="pb-16"
      initial={{ opacity: 0, y: 15 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      aria-label="The bungalows of Jungle Bay Island"
    >
      {/* DIRECTIONAL SCRIM (2026-09-04 field review). This copy sits directly on
          the page backdrop, and on the bungalows art that backdrop's brightest
          pixel — the lantern — falls right through the sentence, taking the
          worst-case contrast close to 1:1. A text-shadow alone was carrying it
          and a shadow cannot save white type on a lit lamp.

          It fades to fully transparent by 62% width, so it grounds the column
          the words actually occupy and leaves the right third of the painting
          untouched. The art is not dimmed, cropped or replaced — the reviewer
          also asked for the lantern to be re-cropped into that empty right
          third, which is a curator's call in the bungalow studio, not a code
          change, and is deliberately NOT made here. */}
      <div className="relative mb-6">
        <div
          className="absolute -inset-x-4 -inset-y-3 pointer-events-none rounded-xl"
          aria-hidden="true"
          style={{
            background:
              'linear-gradient(to right, rgba(3,7,14,0.88) 0%, rgba(3,7,14,0.66) 38%, rgba(3,7,14,0) 62%)',
          }}
        />
        <div className="relative">
          <p className="text-[11px] uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Jungle Bay Island
          </p>
          <h2 className="heading-luxury text-2xl text-white tracking-tight mb-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            The bungalows
          </h2>
          {/* 16px, and measured in ch rather than a container width. This is the
              only place the LIVE / SETTLED / QUIET system is explained and it was
              set at 13px — smaller than the card labels underneath it — running
              the full width of the hero. `max-w-2xl` was ~85 characters a line;
              60ch is the readable measure for a paragraph someone is expected to
              actually read rather than scan. */}
          <p className="text-white text-[16px] max-w-[60ch] leading-relaxed" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            Every island community keeps a door at the venue. {openCount} {openCount === 1 ? 'door is' : 'doors are'} open
            in full color. Settled doors are greyed while their people move in; each one still opens to its plaque,
            contract and trade route. Walk in where you hold.
          </p>
        </div>
      </div>
      {/* The hall is a ROOM: the grid sits on its own dark panel (same glass
          as the picker) so thirteen doors read as one place, not thirteen
          tiles floating on loud page art. */}
      <div
        className="rounded-2xl p-3"
        style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.10)' }}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {BUNGALOWS.map((b) => (
            <DoorTile key={b.id} bungalow={b} />
          ))}
        </div>
        {/* The island's growth line: quiet, true, forward-pulling. */}
        <p className="mt-3 mb-1 text-center text-[12px] italic text-white/70">
          The island grows a door at a time. More open as their people move in.
        </p>
      </div>
    </m.section>
  );
}
