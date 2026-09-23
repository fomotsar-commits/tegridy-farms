/**
 * How wide a strip's edge fade is where more tabs wait past that edge. A tab the
 * strip scrolls into view keeps this much room beside it, clear of the fade.
 */
export const STRIP_EDGE_PX = 40;

/**
 * The band at a faded edge that is fully clear, where that edge's chevron sits.
 * The chevron is a tap target, so the band is at least 24px (WCAG 2.5.8).
 */
export const STRIP_CHEVRON_PX = 24;

type StripBox = { scrollLeft: number; clientWidth: number; scrollWidth: number };

/** Which edges have tabs hidden past them. Within 1px of an end counts as at it. */
export interface StripFade {
  start: boolean;
  end: boolean;
}

/**
 * The scrollLeft that shows a tab whole, STRIP_EDGE_PX clear of each edge where
 * the strip can scroll that far, or the current one when it already does.
 * `start` and `end` are the tab's edges within the strip's scrolled content.
 * A move lands on a whole pixel past the room, since WebKit truncates scrollLeft.
 */
export function revealScrollLeft(tab: { start: number; end: number }, strip: StripBox): number {
  let next = strip.scrollLeft;
  if (tab.end > next + strip.clientWidth - STRIP_EDGE_PX) next = Math.ceil(tab.end - strip.clientWidth + STRIP_EDGE_PX);
  if (tab.start < next + STRIP_EDGE_PX) next = Math.floor(tab.start - STRIP_EDGE_PX);
  return Math.max(0, Math.min(next, strip.scrollWidth - strip.clientWidth));
}

export function stripFade({ scrollLeft, clientWidth, scrollWidth }: StripBox): StripFade {
  const max = scrollWidth - clientWidth;
  return { start: max > 1 && scrollLeft > 1, end: max > 1 && scrollLeft < max - 1 };
}

/**
 * The mask-image for those edges, or none: clear across the chevron's band, then
 * fading tabs in until STRIP_EDGE_PX, so no half-faded label runs into a chevron.
 */
export function stripFadeMask({ start, end }: StripFade): string | undefined {
  if (!start && !end) return undefined;
  const from = start ? `transparent ${STRIP_CHEVRON_PX}px, #000 ${STRIP_EDGE_PX}px` : '#000';
  const to = end ? `#000 calc(100% - ${STRIP_EDGE_PX}px), transparent calc(100% - ${STRIP_CHEVRON_PX}px)` : '#000';
  return `linear-gradient(to right, ${from}, ${to})`;
}

/**
 * How far a tap on a chevron scrolls the strip toward that chevron's edge: its
 * width less both fades, so what sat under that edge's fade lands clear of the
 * other one. A strip too narrow for that still moves one fade's width.
 */
export function chevronScrollBy(side: 'start' | 'end', clientWidth: number): number {
  const page = Math.max(STRIP_EDGE_PX, clientWidth - 2 * STRIP_EDGE_PX);
  return side === 'end' ? page : -page;
}
