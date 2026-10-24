import type { CSSProperties } from 'react';
import { DEFAULT_BUNGALOW_ID, getBungalowIdentity, OPEN_LOT_HERO, TOWELI_HERO } from '../lib/bungalows';
import { pageArt } from '../lib/artConfig';
import { artImgProps } from '../lib/artSrcSet';
import { PageSkeleton } from './PageSkeleton';

/** The heading HomePage's hero will render behind door `id`: the active room's identity,
 *  else (no room speaking for itself) the TOWELI room's classic cluster. HomePage takes
 *  that branch on /toweli and /towelie, the only paths that mount this door. */
function doorHeading(id: string): { heroTitle: string; heroLine: string } | null {
  const room = getBungalowIdentity();
  if (room) return room.id === id ? room.identity : null;
  return id === DEFAULT_BUNGALOW_ID ? TOWELI_HERO : null;
}

interface Place {
  wrap?: CSSProperties;
  col?: CSSProperties;
  spacer: CSSProperties;
  veil?: CSSProperties;
}

/** The hero's pill row (24.5 px, then mb-5), as in the static frame's PILL_ROW_STYLE. */
const HERO_PLACE: Place = { spacer: { height: 24.5, margin: '0 0 1.25rem' } };

/** The lot landing's plaque, as in the static frame's LOT_FRAME. */
const LOT_PLACE: Place = {
  wrap: { paddingTop: '6rem' },
  col: { maxWidth: 'none' },
  spacer: { height: 16.5, margin: '0 0 0.5rem' },
  veil: { position: 'absolute', inset: 0, background: 'rgba(6,12,26,0.62)' },
};

/** The ff-* markup the build's static frame paints (scripts/render-bungalow-doors.mjs), so
 *  React's first commit swaps it like for like. `aria-busy` keeps the e2e readiness probe
 *  waiting for the page. Wallet-free. */
function Frame({ heading, art, place }: {
  heading: { heroTitle: string; heroLine: string };
  art: { src: string; objectPosition?: string };
  place: Place;
}) {
  return (
    <div className="ff-in-layout" aria-busy="true">
      <div className="ff-bg">
        <img
          src={art.src}
          {...artImgProps(art.src, 'eager')}
          alt=""
          width={1200}
          height={800}
          fetchPriority="high"
          decoding="async"
          style={art.objectPosition ? { objectPosition: art.objectPosition } : undefined}
        />
        {place.veil && <div style={place.veil} />}
      </div>
      <div className="ff-wrap" style={place.wrap}>
        <div className="ff-col" style={place.col}>
          {/* What sits above the page's heading, and its letter-spacing, as in the static frame. */}
          <div aria-hidden="true" style={place.spacer} />
          <h1 className="ff-h1" style={{ letterSpacing: '0.01em' }}>
            {heading.heroTitle}{' '}<br /><span>{heading.heroLine}</span>
          </h1>
        </div>
      </div>
    </div>
  );
}

/**
 * A door's fallback while its home page loads: the frame its static HTML painted. Only
 * when the hero will render this door's heading; otherwise the skeleton.
 */
export function DoorFrame({ id }: { id: string }) {
  const heading = doorHeading(id);
  if (!heading) return <PageSkeleton />;
  return <Frame heading={heading} art={pageArt('home', 0)} place={HERO_PLACE} />;
}

/**
 * The open lot's fallback while its landing loads (BungalowDoor): its static frame
 * again, the landing's heading over the lot's own picture, in the landing's place.
 * Never the skeleton and never nothing, so the heading never leaves the screen.
 */
export function LotFrame() {
  return (
    <Frame
      heading={OPEN_LOT_HERO}
      art={{ src: OPEN_LOT_HERO.heroArt, objectPosition: OPEN_LOT_HERO.heroPosition }}
      place={LOT_PLACE}
    />
  );
}
