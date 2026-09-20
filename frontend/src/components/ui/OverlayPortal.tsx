import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Renders a full-screen overlay at the END OF <body>, out of whatever page
 * rendered it.
 *
 * ⚠️ WHY THIS HAS TO EXIST, measured 2026-09-19 on /gallery at 390px.
 *
 * AppLayout wraps every routed page in `min-h-screen relative z-10`. A
 * positioned element with a z-index creates a STACKING CONTEXT, and a stacking
 * context is a ceiling: every z-index inside it is resolved among its own
 * children and then the whole subtree is painted at the parent's level — 10.
 * The app had no portals at all, so a dialog a PAGE rendered was inside that
 * ceiling, and `z-[100]` on it meant "100 within a box that paints at 10", not
 * "above everything".
 *
 * TopNav's header and BottomNav are siblings of that wrapper at z-50. So a
 * full-screen lightbox opened at `fixed inset-0` and the app header and the
 * phone tab bar were painted ON TOP of it. Not a subtle one: document
 * .elementFromPoint at the middle of the bottom bar, with the gallery lightbox
 * open and covering all 390x844, returned the nav — so the bar was not only
 * visible over the artwork, it was still what a tap would hit.
 *
 * WHY A PORTAL AND NOT `z-10` OFF THE WRAPPER. Deleting the wrapper's z-index
 * would fix these four dialogs and quietly re-rank everything else inside it
 * against the chrome as well — the in-page tooltips at `absolute z-50`, the
 * floating activity card at z-40, the wrong-network banner. This moves ONLY the
 * things that are supposed to cover the whole screen, and leaves every other
 * stacking relationship in the app exactly as it was.
 *
 * React keeps events bubbling through the REACT tree, not the DOM tree, so
 * handlers, context and focus traps inside `children` are unaffected.
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}
