/**
 * The scroll math RouteTabs and the NFT Finance strip use to bring the selected
 * tab into view. jsdom lays nothing out, so the strip's boxes are given as
 * numbers here; the rendered behaviour is measured in e2e/tab-strip-scroll.spec.ts
 * and e2e/nft-finance-strip.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { STRIP_EDGE_PX, revealScrollLeft, revealSelectedTab } from './tabStripScroll';

// A 382px strip over 600px of tabs: it can scroll 218px.
const strip = (scrollLeft: number) => ({ scrollLeft, clientWidth: 382, scrollWidth: 600 });

describe('revealScrollLeft', () => {
  it('leaves the strip alone when the tab is already in view with room beside it', () => {
    expect(revealScrollLeft({ start: 100, end: 180 }, strip(0))).toBe(0);
    expect(revealScrollLeft({ start: 200, end: 280 }, strip(60))).toBe(60);
  });

  it('scrolls a tab cut by the right edge in, leaving the edge room beside it', () => {
    // Ends at 420, past the 382px view: its end lands STRIP_EDGE_PX inside the edge.
    expect(revealScrollLeft({ start: 340, end: 420 }, strip(0))).toBe(420 - 382 + STRIP_EDGE_PX);
  });

  it('scrolls a tab cut by the left edge in, leaving the edge room beside it', () => {
    expect(revealScrollLeft({ start: 120, end: 200 }, strip(150))).toBe(120 - STRIP_EDGE_PX);
  });

  it('never scrolls past either end of the strip', () => {
    // The last tab ends 4px short of the content's end: scrolled as far as it goes.
    expect(revealScrollLeft({ start: 520, end: 596 }, strip(0))).toBe(218);
    // The first tab starts inside the padding: back to the start.
    expect(revealScrollLeft({ start: 4, end: 80 }, strip(218))).toBe(0);
  });

  it('shows the start of a tab wider than the strip', () => {
    expect(revealScrollLeft({ start: 100, end: 520 }, strip(0))).toBe(100 - STRIP_EDGE_PX);
  });

  it('keeps a strip that fits at the start', () => {
    expect(revealScrollLeft({ start: 300, end: 378 }, { scrollLeft: 0, clientWidth: 382, scrollWidth: 382 })).toBe(0);
  });

  it('leaves the room it is given at each edge', () => {
    const room = { start: 10, end: 40 };
    expect(revealScrollLeft({ start: 340, end: 420 }, strip(0), room)).toBe(420 - 382 + 40);
    expect(revealScrollLeft({ start: 120, end: 200 }, strip(150), room)).toBe(120 - 10);
  });
});

const BORDER = 1;
const PAD_START = 4;
const GAP = 6;

/**
 * A strip with the layout numbers jsdom does not compute. Widths may be fractions
 * of a pixel, as real tabs are; offsets and scrollWidth are whole pixels, as a
 * browser reports them. `scale` is how the page is drawn at that moment: it
 * changes every rendered box and no layout number.
 */
function buildStrip(opts: {
  widths: number[];
  selected: number;
  clientWidth: number;
  padEnd: number;
  positioned?: boolean;
  scale?: number;
  hidden?: boolean;
}) {
  const { widths, selected, clientWidth, padEnd, positioned = false, scale = 1, hidden = false } = opts;
  const page = document.createElement('div');
  const list = document.createElement('div');
  list.setAttribute('role', 'tablist');
  list.style.paddingLeft = `${PAD_START}px`;
  list.style.paddingRight = `${padEnd}px`;
  page.appendChild(list);
  document.body.appendChild(page);

  const LIST_LEFT = 16;
  let scrollLeft = 0;
  const give = (el: Element, props: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(props)) Object.defineProperty(el, name, { configurable: true, value });
  };
  const rendered = (left: number, width: number) =>
    ({ left: left * scale, right: (left + width) * scale, width: width * scale }) as DOMRect;

  let x = PAD_START;
  const ends: number[] = [];
  widths.forEach((width, i) => {
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(i === selected));
    list.appendChild(tab);
    const inStrip = x;
    give(tab, {
      offsetParent: hidden ? null : positioned ? list : page,
      offsetLeft: Math.round(positioned ? inStrip : LIST_LEFT + BORDER + inStrip),
      offsetWidth: Math.round(width),
      getBoundingClientRect: () => rendered(LIST_LEFT + BORDER + inStrip - scrollLeft, width),
    });
    ends.push(x + width);
    x += width + GAP;
  });
  const scrollWidth = Math.round(x - GAP + padEnd);
  give(list, {
    offsetParent: hidden ? null : page,
    offsetLeft: LIST_LEFT,
    clientLeft: BORDER,
    clientWidth,
    scrollWidth,
    getBoundingClientRect: () => rendered(LIST_LEFT, clientWidth + 2 * BORDER),
  });
  Object.defineProperty(list, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    },
  });
  /** How many px of the strip's padding box are left to the right of the selected tab. */
  const roomAtEnd = () => scrollLeft + clientWidth - ends[selected]!;
  return { list, roomAtEnd, cleanup: () => page.remove() };
}

// The NFT Finance row on a phone: six tabs in a 356px strip whose last 32px are its fade.
// Each width reads 0.4px short as a whole pixel, so the offsets under-read every tab's end.
const PHONE = { widths: [150.4, 141.4, 162.4, 175.4, 122.4, 128.4], clientWidth: 356, padEnd: 32 };

describe('revealSelectedTab', () => {
  it('brings the selected tab whole out of the end padding, where the fade is', () => {
    for (const selected of [3, 4]) {
      const s = buildStrip({ ...PHONE, selected });
      revealSelectedTab(s.list);
      // Against the tab's true end, not the whole-pixel one the browser reports.
      expect(s.roomAtEnd(), `tab ${selected}`).toBeGreaterThanOrEqual(PHONE.padEnd);
      // And no further than the rounding allowance asks.
      expect(s.roomAtEnd(), `tab ${selected}`).toBeLessThanOrEqual(PHONE.padEnd + 2);
      s.cleanup();
    }
  });

  it('scrolls to the end for the last tab, whose own padding is the room', () => {
    const s = buildStrip({ ...PHONE, selected: 5 });
    revealSelectedTab(s.list);
    expect(s.list.scrollLeft).toBe(s.list.scrollWidth - s.list.clientWidth);
    s.cleanup();
  });

  it('lands the same however the page is drawn at that moment', () => {
    // The page entrance is 0.994; 0.9 makes a miss too large for any rounding to hide.
    for (const scale of [0.994, 0.9, 1.1]) {
      const still = buildStrip({ ...PHONE, selected: 3 });
      const settling = buildStrip({ ...PHONE, selected: 3, scale });
      revealSelectedTab(still.list);
      revealSelectedTab(settling.list);
      expect(settling.list.scrollLeft, `drawn at ${scale}`).toBe(still.list.scrollLeft);
      still.cleanup();
      settling.cleanup();
    }
  });

  it('reads the tab from the strip itself when the strip is positioned', () => {
    const a = buildStrip({ ...PHONE, selected: 4 });
    const b = buildStrip({ ...PHONE, selected: 4, positioned: true });
    revealSelectedTab(a.list);
    revealSelectedTab(b.list);
    expect(b.list.scrollLeft).toBe(a.list.scrollLeft);
    expect(b.list.scrollLeft).toBeGreaterThan(0);
    a.cleanup();
    b.cleanup();
  });

  it('keeps the edge room when the padding is smaller than it', () => {
    const s = buildStrip({ ...PHONE, padEnd: 4, selected: 3 });
    revealSelectedTab(s.list);
    expect(s.roomAtEnd()).toBeGreaterThanOrEqual(STRIP_EDGE_PX);
    expect(s.roomAtEnd()).toBeLessThanOrEqual(STRIP_EDGE_PX + 2);
    s.cleanup();
  });

  it('settles: a second look moves nothing', () => {
    const s = buildStrip({ ...PHONE, selected: 5 });
    revealSelectedTab(s.list);
    const first = s.list.scrollLeft;
    revealSelectedTab(s.list);
    expect(s.list.scrollLeft).toBe(first);
    s.cleanup();
  });

  it('leaves a strip that is not laid out where it is', () => {
    const s = buildStrip({ ...PHONE, selected: 5, hidden: true });
    revealSelectedTab(s.list);
    expect(s.list.scrollLeft).toBe(0);
    s.cleanup();
  });
});
