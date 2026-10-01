import { getBungalowIdentity } from '../lib/bungalows';
import { pageArt } from '../lib/artConfig';
import { artImgProps } from '../lib/artSrcSet';
import { PageSkeleton } from './PageSkeleton';

/**
 * A door's fallback while its home page loads: the frame its static HTML painted
 * (scripts/render-bungalow-doors.mjs), same ff-* markup, so React's first commit swaps
 * it like for like. Only when the hero will render this door's identity; otherwise the
 * skeleton. Wallet-free. `aria-busy` keeps the e2e readiness probe waiting for the page.
 */
export function DoorFrame({ id }: { id: string }) {
  const bungalow = getBungalowIdentity();
  if (!bungalow || bungalow.id !== id) return <PageSkeleton />;
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
            {bungalow.identity.heroTitle}{' '}<br /><span>{bungalow.identity.heroLine}</span>
          </h1>
        </div>
      </div>
    </div>
  );
}
