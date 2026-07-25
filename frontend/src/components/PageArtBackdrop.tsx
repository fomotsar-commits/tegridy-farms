import { ArtImg } from './ArtImg';

/**
 * PageArtBackdrop — a full-viewport art layer for pages that would otherwise
 * render on the bare gradient <Background/> (the "art-less empty page" feeling
 * the rest of this art-first app never has).
 *
 * Why a single line is enough — stacking, not wrapping:
 *   AppLayout renders the global <Background/> at `fixed inset-0 z-0`, then the
 *   page content inside a `min-h-screen relative z-10` wrapper, with <Outlet/>
 *   further wrapped in a framer <PageTransition> whose variants apply a
 *   transform. A transform ancestor is a containing block for both fixed and
 *   absolute descendants, so we use `absolute inset-0` (fixed would be trapped
 *   by that same transform anyway) — it fills the page content box. The NEGATIVE
 *   z-index keeps it BELOW the page's non-positioned block content (which paints
 *   above a negative-z positioned layer in the same stacking context) while the
 *   whole page wrapper still sits ABOVE the global z-0 Background. So dropping one
 *   <PageArtBackdrop/> at the top of a page gives it art WITHOUT wrapping or
 *   re-z-indexing any existing markup — nothing about the page's layout changes.
 *
 * pageId keys the art rotation (djb2 hash → ART_POOL_ALL offset), so each page
 * gets a distinct, stable piece — including the freshly-added drop. A strong
 * default scrim keeps data-dense tool pages fully legible over the art.
 */
export function PageArtBackdrop({
  pageId,
  idx = 0,
  scrim = 'rgba(6, 10, 22, 0.86)',
}: {
  pageId: string;
  idx?: number;
  scrim?: string;
}) {
  return (
    <div className="absolute inset-0 -z-10 pointer-events-none" aria-hidden="true">
      <ArtImg pageId={pageId} idx={idx} alt="" loading="lazy" className="w-full h-full object-cover" />
      <div className="absolute inset-0" style={{ background: scrim }} />
    </div>
  );
}

export default PageArtBackdrop;
