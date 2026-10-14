import { useEffect } from 'react';
import { useLocation, useNavigationType, type Location } from 'react-router-dom';

/** How long a section link waits for its section to be drawn before it gives up. */
export const SECTION_WAIT_MS = 10_000;

// The visitor moving the page themselves ends a wait, so a section that is
// drawn later does not pull them away from where they went.
const VISITOR_MOVES = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;

/**
 * Brings the element `hash` names to the top of the screen, as a browser does
 * for a section link: now, or the moment it is drawn, within `limitMs`.
 * Returns what stops the wait.
 */
export function landOnSection(hash: string, limitMs = SECTION_WAIT_MS): () => void {
  const written = hash.replace(/^#/, '');
  let id = written;
  try { id = decodeURIComponent(written); } catch { /* not percent-encoded: the id as written */ }
  const land = () => {
    const section = id ? document.getElementById(id) : null;
    section?.scrollIntoView({ behavior: 'auto', block: 'start' });
    return section !== null;
  };
  if (!id || land()) return () => {};

  const drawn = new MutationObserver(() => { if (land()) stop(); });
  const limit = window.setTimeout(stop, limitMs);
  function stop() {
    drawn.disconnect();
    window.clearTimeout(limit);
    for (const move of VISITOR_MOVES) window.removeEventListener(move, stop, true);
  }
  for (const move of VISITOR_MOVES) window.addEventListener(move, stop, { capture: true, passive: true });
  drawn.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['id'] });
  return stop;
}

/** The first location this document showed; React Router makes a new one for every later entry. */
let openedWith: Location | undefined;

export function __forgetOpeningForTests(): void {
  openedWith = undefined;
}

/** Opened by its address or a link from elsewhere: not reloaded, not reached by Back or Forward. */
function openedFresh(): boolean {
  try {
    const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    return entry?.type === 'navigate';
  } catch {
    return false;
  }
}

/**
 * A `#section` in the address lands on its section, once the page's code has
 * drawn it: after a link, and when the address is opened fresh. Back, Forward
 * and a reload are the browser's to place, so they are left alone.
 */
export function useSectionLink(): void {
  const location = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    openedWith ??= location;
    if (!location.hash) return;
    if (navType === 'POP' && !(location === openedWith && openedFresh())) return;
    return landOnSection(location.hash);
  }, [location, navType]);
}
