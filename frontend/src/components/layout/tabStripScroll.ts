import { useLayoutEffect, useRef } from 'react';

/** Room left beside a tab the strip scrolls into view, so its neighbour still shows. */
export const STRIP_EDGE_PX = 24;

/**
 * The scrollLeft that shows a tab whole, STRIP_EDGE_PX clear of each edge where
 * the strip can scroll that far, or the current one when it already does.
 * `start` and `end` are the tab's edges within the strip's scrolled content.
 */
export function revealScrollLeft(
  tab: { start: number; end: number },
  strip: { scrollLeft: number; clientWidth: number; scrollWidth: number },
): number {
  let next = strip.scrollLeft;
  if (tab.end > next + strip.clientWidth - STRIP_EDGE_PX) next = tab.end - strip.clientWidth + STRIP_EDGE_PX;
  if (tab.start < next + STRIP_EDGE_PX) next = tab.start - STRIP_EDGE_PX;
  return Math.max(0, Math.min(next, strip.scrollWidth - strip.clientWidth));
}

/**
 * The ref for a tablist that shows its selected tab whole: on landing, on a new
 * selection (`active`, or a new set of tabs, `keyList`), and when the strip or a
 * tab resizes (web fonts, rotation). It moves only the strip's own scrollLeft,
 * before paint, never the page. The tabs are the tablist's children.
 */
export function useRevealSelectedTab(active: string, keyList = '') {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab) return;
      const box = tab.getBoundingClientRect();
      const start = box.left - list.getBoundingClientRect().left - list.clientLeft + list.scrollLeft;
      const next = revealScrollLeft({ start, end: start + box.width }, list);
      if (Math.abs(next - list.scrollLeft) > 0.5) list.scrollLeft = next;
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(reveal);
    ro.observe(list);
    for (const tab of list.children) ro.observe(tab);
    return () => ro.disconnect();
  }, [active, keyList]);
  return listRef;
}
