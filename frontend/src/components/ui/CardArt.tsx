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
 * Being a stacking context has one cost: a tooltip that opens past the card's
 * edge would be painted under the next such card. index.css lifts the card
 * while the pointer or focus is inside it (the `data-card-art` rule).
 *
 * IT IS THE HOST'S FIRST CHILD, so it sheds what a host hands its children:
 * `space-y-*` gives every child but the last a bottom margin, which on an
 * `inset-0` box stops the art that many pixels short of the card's bottom edge,
 * and `divide-y` gives it a border. `m-0 border-0` undo both.
 *
 * IT IS BUILT FROM SPANS, so it is valid inside any host: several of these
 * cards are a <p>, a <button> or a <summary>, none of which may hold a <div>.
 * Absolutely positioned boxes lay out the same either way.
 *
 * THE CARD KEEPS ITS OWN COLOUR. The art covers the host's background, and on
 * many of these cards that background means something: an amber warning, a red
 * risk, a verdict band, a hover or selected state. So the top layer inherits
 * the host's whole background (the root passes it down) and lays it back over
 * the scrim with `screen` blending, which adds light and never takes it away:
 * an amber wash comes back as amber, while the near-black glass most cards sit
 * on adds next to nothing and leaves the art showing. No call site has to say
 * which kind of card it is, and a hover colour set in CSS follows by itself.
 *
 * THE SCRIM IS 0.78, the value BungalowFarmPanel's cards use for the same job
 * (copy sitting straight on the scrim). The owner's 2026-08-31 note on the
 * lighthouse card is the reason it is not darker: at 0.85 the art "was barely
 * readable". At 0.78 the body text these cards use (white at 65% and up) still
 * clears 4.5:1 over pure white art. A card that already carries its OWN scrim
 * layer (the pool cards, tuned to 0.52 and 0.62 by that same note) passes
 * `scrim="transparent"`, or the two stack into the near-black it was fixing.
 *
 * Art resolves through ArtImg, so studio picks, pan, zoom, lazy loading and the
 * broken-image fallback all apply, and the surface carries the stamp the
 * studio's Live page jumps to. Register every (pageId, idx) in
 * lib/artSurfaces.ts; artStudioCoverage.test.ts fails on one that is not.
 */
export function CardArt({
  pageId,
  idx,
  scrim = 'rgba(4,9,18,0.78)',
  fallbackPosition,
}: {
  pageId: string;
  idx: number;
  scrim?: string;
  fallbackPosition?: string;
}) {
  return (
    <span
      data-card-art=""
      className="absolute inset-0 m-0 border-0 -z-10 overflow-hidden rounded-[inherit] pointer-events-none"
      style={{ background: 'inherit' }}
      aria-hidden="true"
    >
      <ArtImg
        pageId={pageId}
        idx={idx}
        fallbackPosition={fallbackPosition}
        alt=""
        className="w-full h-full object-cover"
      />
      <span className="absolute inset-0" style={{ background: scrim }} />
      <span className="absolute inset-0" style={{ background: 'inherit', mixBlendMode: 'screen' }} />
    </span>
  );
}
