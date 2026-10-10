import { useLayoutEffect, useRef } from 'react';

/** Room left beside a tab the strip scrolls into view, so its neighbour still shows. */
export const STRIP_EDGE_PX = 24;

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
  tab: { start: number; end: number },
  strip: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  room: { start: number; end: number } = { start: STRIP_EDGE_PX, end: STRIP_EDGE_PX },
): number {
  let next = strip.scrollLeft;
  if (tab.end > next + strip.clientWidth - room.end) next = tab.end - strip.clientWidth + room.end;
  if (tab.start < next + room.start) next = tab.start - room.start;
  return Math.max(0, Math.min(next, strip.scrollWidth - strip.clientWidth));
}

const px = (length: string) => Number.parseFloat(length) || 0;

/**
 * Scrolls `list` so its selected tab is whole inside the strip's content box:
 * clear of the padding, which is where a strip's edge fade belongs, and
 * STRIP_EDGE_PX clear at least. Read from layout offsets, never rendered boxes:
 * a page still settling in is drawn at 0.994 scale, a rendered box measured
 * then is that much short, and nothing re-measures when the scale ends.
 */
export function revealSelectedTab(list: HTMLElement): void {
  const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!tab || !tab.offsetParent) return;
  // A child's offsets are from the strip when the strip is positioned, else from the parent the two share.
  const start = tab.offsetParent === list ? tab.offsetLeft : tab.offsetLeft - list.offsetLeft - list.clientLeft;
  const padding = getComputedStyle(list);
  const next = revealScrollLeft({ start, end: start + tab.offsetWidth + ROUNDING_PX }, list, {
    start: Math.max(STRIP_EDGE_PX, px(padding.paddingLeft)),
    end: Math.max(STRIP_EDGE_PX, Math.ceil(px(padding.paddingRight))),
  });
  if (Math.abs(next - list.scrollLeft) > 0.5) list.scrollLeft = next;
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
    const reveal = () => revealSelectedTab(list);
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(reveal);
    ro.observe(list);
    for (const tab of list.children) ro.observe(tab);
    return () => ro.disconnect();
  }, [active, keyList]);
  return listRef;
}
