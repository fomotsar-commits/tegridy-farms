import { ArtImg } from './ArtImg';

/**
 * PageArtBackdrop — a full-page art layer for pages that would otherwise render
 * on the bare gradient <Background/> (the "art-less empty page" feeling the rest
 * of this art-first app never has).
 *
 * Stacking — the app's proven pattern, NOT a negative-z shortcut:
 *   AppLayout paints a solid `fixed inset-0 z-0 bg-[#060c1a]` <Background/>, then
 *   the page inside a `relative z-10` wrapper. An earlier version used `-z-10`
 *   here to sit "behind content" — but a negative z drops the layer BEHIND that
 *   solid #060c1a background, so the art was invisible (hidden the whole time).
 *   The correct pattern, used by FarmPage/TradePage/etc., is: this layer is
 *   `absolute inset-0 z-0` and the PAGE'S OWN CONTENT is given `relative z-10` so
 *   it paints above the art. So each consumer must wrap its content in
 *   `relative z-10` (positioned content beats a positioned z-0 sibling); the
 *   backdrop then shows through the page's margins and its translucent cards.
 *
 * pageId keys the art rotation (djb2 hash → ART_POOL_ALL offset), so each page
 * gets a distinct, stable piece — including the freshly-added drop. The scrim is
 * a top-weighted gradient: darker where a page's heading/intro float directly on
 * the art, lighter through the body so the piece stays clearly visible. Only a
 * light blur is applied to the art — no brightness cut — so it reads as real art.
 */
export function PageArtBackdrop({
  pageId,
  idx = 0,
  scrim = 'linear-gradient(180deg, rgba(6,10,22,0.85) 0%, rgba(6,10,22,0.55) 12%, rgba(6,10,22,0.45) 100%)',
}: {
  pageId: string;
  idx?: number;
  scrim?: string;
}) {
  return (
    <div className="absolute inset-0 z-0 pointer-events-none" aria-hidden="true">
      <ArtImg
        pageId={pageId}
        idx={idx}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
        style={{ filter: 'blur(1px) saturate(1.05)' }}
      />
      <div className="absolute inset-0" style={{ background: scrim }} />
    </div>
  );
}

export default PageArtBackdrop;
