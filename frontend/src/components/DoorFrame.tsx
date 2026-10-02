import { DEFAULT_BUNGALOW_ID, getBungalowIdentity, TOWELI_HERO } from '../lib/bungalows';
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

/**
 * A door's fallback while its home page loads: the frame its static HTML painted
 * (scripts/render-bungalow-doors.mjs), same ff-* markup, so React's first commit swaps
 * it like for like. Only when the hero will render this door's heading; otherwise the
 * skeleton. Wallet-free. `aria-busy` keeps the e2e readiness probe waiting for the page.
 */
export function DoorFrame({ id }: { id: string }) {
  const heading = doorHeading(id);
  if (!heading) return <PageSkeleton />;
  const art = pageArt('home', 0);
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
      </div>
      <div className="ff-wrap">
        <div className="ff-col">
          {/* The hero's pill row and letter-spacing, as in the static frame. */}
          <div aria-hidden="true" style={{ height: 24.5, margin: '0 0 1.25rem' }} />
          <h1 className="ff-h1" style={{ letterSpacing: '0.01em' }}>
            {heading.heroTitle}{' '}<br /><span>{heading.heroLine}</span>
          </h1>
        </div>
      </div>
    </div>
  );
}
