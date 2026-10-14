import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType, type Location } from 'react-router-dom';

/** How long a section link waits for its section to be drawn before it gives up. */
export const SECTION_WAIT_MS = 10_000;

/** How long a landed section is held in place while what is above it finishes drawing. */
export const SECTION_SETTLE_MS = 2_000;

// The visitor moving the page themselves ends a wait or a hold, so a section
// drawn or moved later does not pull them away from where they went. A tap or
// a key that scrolls nothing is not a move: an impatient second tap still lands.
const VISITOR_MOVES = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ', 'Home', 'End']);

function movesThePage(event: Event): boolean {
  if (event.type === 'keydown') return SCROLL_KEYS.has((event as KeyboardEvent).key);
  // The window's own scrollbar lies right of the page's content box.
  if (event.type === 'pointerdown') return (event as MouseEvent).clientX >= document.documentElement.clientWidth;
  return true;
}

/** The visitor is writing in a field, which moving the page would take from under them. */
function typing(): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && (focused.matches('input, textarea, select') || focused.isContentEditable);
}

export interface Landing {
  /** The link came from another page: until the section is drawn, that page shows from its top. */
  fromAnotherPage?: boolean;
  limitMs?: number;
  settleMs?: number;
}

/**
 * Brings the element `hash` names to the top of the screen, as a browser does
 * for a section link: now, or the moment it is drawn, within `limitMs`. Then
 * holds it there for `settleMs`, as entrance animations and late content above
 * it would otherwise move it under the top bar. Returns what stops it.
 */
export function landOnSection(
  hash: string,
  { fromAnotherPage = false, limitMs = SECTION_WAIT_MS, settleMs = SECTION_SETTLE_MS }: Landing = {},
): () => void {
  const written = hash.replace(/^#/, '');
  let id = written;
  try { id = decodeURIComponent(written); } catch { /* not percent-encoded: the id as written */ }
  if (!id) return () => {};

  let placed = 0;
  let frame = 0;
  const drawn = new MutationObserver(() => find());
  const limit = window.setTimeout(stop, limitMs);
  function land(section: HTMLElement) {
    section.scrollIntoView({ behavior: 'auto', block: 'start' });
    placed = section.getBoundingClientRect().top;
  }
  /** Whether the section is drawn, and so this is settled one way or the other. */
  function find(): boolean {
    const section = document.getElementById(id);
    if (!section) return false;
    if (typing()) { stop(); return true; }
    drawn.disconnect();
    window.clearTimeout(limit);
    land(section);
    const until = performance.now() + settleMs;
    const hold = () => {
      if (!section.isConnected || performance.now() >= until || typing()) return stop();
      if (Math.abs(section.getBoundingClientRect().top - placed) > 1) land(section);
      frame = requestAnimationFrame(hold);
    };
    frame = requestAnimationFrame(hold);
    return true;
  }
  const onMove = (event: Event) => { if (movesThePage(event)) stop(); };
  function stop() {
    drawn.disconnect();
    window.clearTimeout(limit);
    cancelAnimationFrame(frame);
    for (const move of VISITOR_MOVES) window.removeEventListener(move, onMove, true);
  }
  for (const move of VISITOR_MOVES) window.addEventListener(move, onMove, { capture: true, passive: true });
  drawn.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['id'] });
  if (!find() && fromAnotherPage) window.scrollTo(0, 0);
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
 * drawn it: after a link, and when the address is opened fresh. A link from
 * another page shows that page from its top meanwhile, as any page change does.
 * Back, Forward and a reload are the browser's to place, so they are left alone.
 */
export function useSectionLink(): void {
  const location = useLocation();
  const navType = useNavigationType();
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    openedWith ??= location;
    const fromAnotherPage = lastPath.current !== null && lastPath.current !== location.pathname;
    lastPath.current = location.pathname;
    if (!location.hash) return;
    if (navType === 'POP' && !(location === openedWith && openedFresh())) return;
    return landOnSection(location.hash, { fromAnotherPage });
  }, [location, navType]);
}
