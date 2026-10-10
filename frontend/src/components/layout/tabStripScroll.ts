import { useLayoutEffect, useRef, useState } from 'react';

/** Room left beside a tab the strip scrolls into view, so its neighbour still shows. */
export const STRIP_EDGE_PX = 24;

/** A tab's edges within its strip's scrolled content. */
type TabEdges = { start: number; end: number };
type Strip = { scrollLeft: number; clientWidth: number; scrollWidth: number };

/**
 * The scrollLeft that shows a tab whole, `edge` px clear of each end where the
 * strip can scroll that far, or the current one when it already does.
 */
export function revealScrollLeft(tab: TabEdges, strip: Strip, edge = STRIP_EDGE_PX): number {
  let next = strip.scrollLeft;
  if (tab.end > next + strip.clientWidth - edge) next = tab.end - strip.clientWidth + edge;
  if (tab.start < next + edge) next = tab.start - edge;
  return Math.max(0, Math.min(next, strip.scrollWidth - strip.clientWidth));
}

/**
 * The scrollLeft one press of a strip's arrow moves to: the nearest tab that way
 * whose middle is not in view comes whole into view, `edge` px clear of the end.
 * With every middle in view it is the end of the strip. `tabs` are in order.
 */
export function stepScrollLeft(dir: 'prev' | 'next', tabs: TabEdges[], strip: Strip, edge = STRIP_EDGE_PX): number {
  const middle = (tab: TabEdges) => (tab.start + tab.end) / 2;
  const tab =
    dir === 'next'
      ? tabs.find((t) => middle(t) > strip.scrollLeft + strip.clientWidth - edge)
      : [...tabs].reverse().find((t) => middle(t) < strip.scrollLeft + edge);
  if (!tab) return dir === 'next' ? Math.max(0, strip.scrollWidth - strip.clientWidth) : 0;
  return revealScrollLeft(tab, strip, edge);
}

/**
 * Which ends of a strip have tabs past them. The left end counts once the first
 * tab is cut, not its padding. The right end counts until the strip is scrolled
 * as far as it goes: a strip that fades there fades its last tab until then.
 */
export function moreTabs(tabs: TabEdges[], strip: Strip): { prev: boolean; next: boolean } {
  const first = tabs[0];
  if (!first) return { prev: false, next: false };
  return {
    prev: first.start < strip.scrollLeft - 1,
    next: strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1,
  };
}

function edgesIn(list: HTMLElement, tab: Element): TabEdges {
  const box = tab.getBoundingClientRect();
  const start = box.left - list.getBoundingClientRect().left - list.clientLeft + list.scrollLeft;
  return { start, end: start + box.width };
}

/**
 * The ref for a tablist that shows its selected tab whole: on landing, on a new
 * selection (`active`, or a new set of tabs, `keyList`), and when the strip or a
 * tab resizes (web fonts, rotation). It moves only the strip's own scrollLeft,
 * before paint, never the page. The tabs are the tablist's children. `edge` is
 * the room kept clear at each end, for a strip with something over its ends.
 */
export function useRevealSelectedTab(active: string, keyList = '', edge = STRIP_EDGE_PX) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      const next = revealScrollLeft(edgesIn(list, tab), list, edge);
      if (Math.abs(next - list.scrollLeft) > 0.5) list.scrollLeft = next;
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(reveal);
    ro.observe(list);
    for (const tab of list.children) ro.observe(tab);
    return () => ro.disconnect();
  }, [active, keyList, edge]);
  return listRef;
}

/**
 * For a strip whose scrollbar is hidden: which ends have tabs past them (`more`),
 * and `step`, which scrolls the strip, and only the strip, one tab that way. Call
 * it after useRevealSelectedTab with the same `edge`, so the first paint reads
 * the strip where the reveal left it.
 */
export function useStripArrows(listRef: { readonly current: HTMLElement | null }, edge = STRIP_EDGE_PX) {
  const [more, setMore] = useState({ prev: false, next: false });
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const sync = () => {
      const now = moreTabs(Array.from(list.children, (tab) => edgesIn(list, tab)), list);
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
  }, [listRef]);
  const step = (dir: 'prev' | 'next') => {
    const list = listRef.current;
    if (!list) return;
    const tabs = Array.from(list.children, (tab) => edgesIn(list, tab));
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ left: stepScrollLeft(dir, tabs, list, edge), behavior: still ? 'auto' : 'smooth' });
  };
  return { more, step };
}
