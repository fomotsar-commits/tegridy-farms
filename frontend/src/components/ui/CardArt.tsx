import { ArtImg } from '../ArtImg';

/**
 * Art behind a card that already exists, without rebuilding the card.
 *
 * WHY, when ArtCard is right next door: ArtCard owns the whole box, so moving a
 * card onto it means re-homing its padding, border and every child. The tabs
 * added after the section hosts landed (Solana LP, Venue AMM, the Island lobby,
 * the Earn list and most of Check) shipped as bare dark boxes, a couple of
 * hundred of them, and no skin could reach any of it: a surface that renders no
 * art is one neither studio can list. This is the same treatment the bungalow
 * panels hand-roll (full-bleed art, a flat scrim, content above), as one child.
 *
 * THE HOST CARD NEEDS `relative isolate`, and nothing else. `isolate` makes the
 * card its own stacking context, so this layer's negative z-index sits above
 * the card's own background and below its content, and the content needs no
 * `relative z-10` of its own. Without it the layer drops behind the page
 * (PageArtBackdrop records the same trap).
 *
 * It clips itself (`rounded-[inherit]`), so the host does not need
 * `overflow-hidden` and a menu that opens past the card's edge is not cut off.
 *
 * Art resolves through ArtImg, so studio picks, pan, zoom, lazy loading and the
 * broken-image fallback all apply, and the surface carries the stamp the
 * studio's Live page jumps to. Register every (pageId, idx) in
 * lib/artSurfaces.ts; artStudioCoverage.test.ts fails on one that is not.
 */
export function CardArt({
  pageId,
  idx,
  scrim = 'rgba(4,9,18,0.82)',
  fallbackPosition,
}: {
  pageId: string;
  idx: number;
  /** The bungalow panels' own value. Lighten it only where the card's text is sparse. */
  scrim?: string;
  fallbackPosition?: string;
}) {
  return (
    <div
      className="absolute inset-0 -z-10 overflow-hidden rounded-[inherit] pointer-events-none"
      aria-hidden="true"
    >
      <ArtImg
        pageId={pageId}
        idx={idx}
        fallbackPosition={fallbackPosition}
        alt=""
        className="w-full h-full object-cover"
      />
      <div className="absolute inset-0" style={{ background: scrim }} />
    </div>
  );
}
