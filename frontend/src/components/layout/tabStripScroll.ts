import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Room left beside a tab the strip scrolls into view, so its neighbour still shows. */
export const STRIP_EDGE_PX = 24;

/** A tab's edges within its strip's scrolled content, and the strip's scroll box. */
type TabEdges = { start: number; end: number };
type StripBox = { scrollLeft: number; clientWidth: number; scrollWidth: number };

/**
 * Offsets, clientWidth and a strip's scroll position are each rounded to a whole
 * (or device) pixel, so a tab's true end can sit up to 2px past the one read.
 */
const ROUNDING_PX = 2;

/**
 * The scrollLeft that shows a tab whole, `room` clear of each edge where the
 * strip can scroll that far, or the current one when it already does.
 * `start` and `end` are the tab's edges within the strip's scrolled content.
 */
export function revealScrollLeft(
  tab: TabEdges,
  strip: StripBox,
  room: { start: number; end: number } = { start: STRIP_EDGE_PX, end: STRIP_EDGE_PX },
): number {
  let next = strip.scrollLeft;
  if (tab.end > next + strip.clientWidth - room.end) next = tab.end - strip.clientWidth + room.end;
  if (tab.start < next + room.start) next = tab.start - room.start;
  return Math.max(0, Math.min(next, strip.scrollWidth - strip.clientWidth));
}

/**
 * The scrollLeft one press of a strip's arrow moves to: the nearest tab that way
 * whose middle is not in view (`room` clear of each end) comes whole into view.
 * With every middle that way in view, the end of the strip. `tabs` are in order.
 */
export function stepScrollLeft(dir: 'prev' | 'next', tabs: TabEdges[], strip: StripBox, room: { start: number; end: number }): number {
  const middle = (t: TabEdges) => (t.start + t.end) / 2;
  const tab =
    dir === 'next'
      ? tabs.find((t) => middle(t) > strip.scrollLeft + strip.clientWidth - room.end)
      : [...tabs].reverse().find((t) => middle(t) < strip.scrollLeft + room.start);
  if (!tab) return dir === 'next' ? Math.max(0, strip.scrollWidth - strip.clientWidth) : 0;
  return revealScrollLeft(tab, strip, room);
}

/**
 * Which ends of a strip have tabs past them. The left end counts once the first
 * tab is cut, not its padding. The right end counts until the strip is scrolled
 * as far as it goes: a strip that fades there fades its last tab until then.
 */
export function moreTabs(tabs: TabEdges[], strip: StripBox): { prev: boolean; next: boolean } {
  const first = tabs[0];
  if (!first) return { prev: false, next: false };
  return {
    prev: first.start < strip.scrollLeft - 1,
    next: strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1,
  };
}

const px = (length: string) => Number.parseFloat(length) || 0;

/**
 * A tab's edges in its strip's scrolled content, from layout offsets, never rendered
 * boxes: a page still settling in is drawn at 0.994 scale, a rendered box measured
 * then is that much short, and nothing re-measures when the scale ends.
 */
function tabEdges(list: HTMLElement, tab: HTMLElement): TabEdges {
  // A child's offsets are from the strip when the strip is positioned, else from the parent the two share.
  const start = tab.offsetParent === list ? tab.offsetLeft : tab.offsetLeft - list.offsetLeft - list.clientLeft;
  return { start, end: start + tab.offsetWidth + ROUNDING_PX };
}

/** Room kept clear at each end: the strip's padding (where an edge fade belongs), and `least` at least. */
function stripRoom(list: HTMLElement, least: number): { start: number; end: number } {
  const padding = getComputedStyle(list);
  return { start: Math.max(least, px(padding.paddingLeft)), end: Math.max(least, Math.ceil(px(padding.paddingRight))) };
}

/**
 * Scrolls `list` so its selected tab is whole inside the strip's content box:
 * clear of the padding and `least` px clear at least (STRIP_EDGE_PX, or more on
 * a strip with arrows over its ends).
 */
export function revealSelectedTab(list: HTMLElement, least = STRIP_EDGE_PX): void {
  const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!tab || !tab.offsetParent) return;
  const next = revealScrollLeft(tabEdges(list, tab), list, stripRoom(list, least));
  if (Math.abs(next - list.scrollLeft) > 0.5) list.scrollLeft = next;
}

/**
 * The ref for a tablist that shows its selected tab whole: on landing, on a new
 * selection (`active`, or a new set of tabs, `keyList`), and when the strip or a
 * tab resizes (web fonts, rotation). It moves only the strip's own scrollLeft,
 * before paint, never the page. The tabs are the tablist's children. `least` is
 * the room kept at each end (useStripArrows' `room` on a strip with arrows).
 */
export function useRevealSelectedTab(active: string, keyList = '', least = STRIP_EDGE_PX) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => revealSelectedTab(list, least);
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(reveal);
    ro.observe(list);
    for (const tab of list.children) ro.observe(tab);
    return () => ro.disconnect();
  }, [active, keyList, least]);
  return listRef;
}

/** A pointer that hovers and aims finely: a mouse or a trackpad. A phone or a tablet's finger is not one. */
export const FINE_POINTER = '(hover: hover) and (pointer: fine)';

function useMatches(query: string): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, [query]);
  return matches;
}

const NO_MORE = { prev: false, next: false };

/** How wide a strip arrow is (a 44px press target), and the room the reveal keeps beside one. */
export const STRIP_ARROW_PX = 44;
const ARROW_ROOM_PX = STRIP_ARROW_PX + 8;

/**
 * useRevealSelectedTab for a strip whose scrollbar is hidden, plus arrows for a
 * mouse: which ends have tabs past them (`more`), and `step`, which scrolls the
 * strip, and only the strip, one tab that way. The selected tab is kept clear of
 * where the arrows sit. With no fine pointer (a phone, a tablet) the row is
 * swiped: `more` stays false and the reveal keeps STRIP_EDGE_PX.
 */
export function useTabStripArrows(active: string, keyList = '') {
  const mouse = useMatches(FINE_POINTER);
  const listRef = useRevealSelectedTab(active, keyList, mouse ? ARROW_ROOM_PX : STRIP_EDGE_PX);
  return { listRef, ...useStripArrows(listRef, mouse) };
}

function useStripArrows(listRef: RefObject<HTMLElement | null>, mouse: boolean) {
  const [more, setMore] = useState<{ prev: boolean; next: boolean }>(NO_MORE);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !mouse) return;
    const sync = () => {
      const now = moreTabs(Array.from(list.children as HTMLCollectionOf<HTMLElement>, (tab) => tabEdges(list, tab)), list);
      setMore((was) => (was.prev === now.prev && was.next === now.next ? was : now));
    };
    sync();
    list.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    ro?.observe(list);
    for (const tab of list.children) ro?.observe(tab);
    return () => {
      list.removeEventListener('scroll', sync);
      ro?.disconnect();
    };
  }, [listRef, mouse]);
  const step = useCallback(
    (dir: 'prev' | 'next') => {
      const list = listRef.current;
      if (!list) return;
      const tabs = Array.from(list.children as HTMLCollectionOf<HTMLElement>, (tab) => tabEdges(list, tab));
      const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      list.scrollTo({ left: stepScrollLeft(dir, tabs, list, stripRoom(list, ARROW_ROOM_PX)), behavior: still ? 'auto' : 'smooth' });
    },
    [listRef],
  );
  return { more: mouse ? more : NO_MORE, step };
}
