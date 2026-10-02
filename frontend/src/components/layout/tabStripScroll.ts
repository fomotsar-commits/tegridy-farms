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
