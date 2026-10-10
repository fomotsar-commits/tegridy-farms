/**
 * The scroll math a tab strip uses to bring its selected tab into view, and to
 * move one tab along when an arrow at its end is pressed. jsdom lays nothing out,
 * so the boxes are given as numbers here; the rendered behaviour is measured in
 * e2e/tab-strip-scroll.spec.ts and e2e/nft-finance-strip.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { STRIP_EDGE_PX, moreTabs, revealScrollLeft, stepScrollLeft } from './tabStripScroll';

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

  it('leaves the room a strip asks for in place of STRIP_EDGE_PX', () => {
    // A tab with 30px beside it is in view at the default 24px and not at 44px.
    expect(revealScrollLeft({ start: 272, end: 352 }, strip(0))).toBe(0);
    expect(revealScrollLeft({ start: 272, end: 352 }, strip(0), 44)).toBe(352 - 382 + 44);
    expect(revealScrollLeft({ start: 180, end: 260 }, strip(150), 44)).toBe(180 - 44);
  });
});

// Six 90px tabs, 10px apart, from the strip's 4px padding to 594.
const TABS = [0, 1, 2, 3, 4, 5].map((i) => ({ start: 4 + i * 100, end: 94 + i * 100 }));

describe('stepScrollLeft', () => {
  it('brings the next tab whose middle is out of view whole into view', () => {
    // From 0 the view ends at 358: the tab at 304-394 has its middle (349) in it, the one at 404-494 does not.
    expect(stepScrollLeft('next', TABS, strip(0))).toBe(494 - 382 + STRIP_EDGE_PX);
  });

  it('brings the previous tab whose middle is out of view whole into view', () => {
    // From 218 the view starts at 242: the tab at 204-294 has its middle (249) in it, the one at 104-194 does not.
    expect(stepScrollLeft('prev', TABS, strip(218))).toBe(104 - STRIP_EDGE_PX);
  });

  it('goes to the end of the strip when every tab that way has its middle in view', () => {
    expect(stepScrollLeft('next', TABS, strip(200))).toBe(218);
    expect(stepScrollLeft('prev', TABS, strip(20))).toBe(0);
  });

  it('counts a tab under the room a strip asks for as out of view', () => {
    // With 44px kept clear the view ends at 338, so the tab at 304-394 (middle 349) is the next one.
    expect(stepScrollLeft('next', TABS, strip(0), 44)).toBe(394 - 382 + 44);
    expect(stepScrollLeft('prev', TABS, strip(218), 44)).toBe(204 - 44);
  });

  it.each([STRIP_EDGE_PX, 44])('walks the strip end to end and back, every press moving it (edge %i)', (edge) => {
    let at = 0;
    let presses = 0;
    for (; at < 218; presses++) {
      const next = stepScrollLeft('next', TABS, strip(at), edge);
      expect(next, `press ${presses + 1} from ${at}`).toBeGreaterThan(at);
      at = next;
    }
    expect(presses).toBeLessThanOrEqual(TABS.length);
    for (presses = 0; at > 0; presses++) {
      const next = stepScrollLeft('prev', TABS, strip(at), edge);
      expect(next, `press ${presses + 1} back from ${at}`).toBeLessThan(at);
      at = next;
    }
    expect(presses).toBeLessThanOrEqual(TABS.length);
  });

  it('stays put on a strip with no tabs', () => {
    expect(stepScrollLeft('prev', [], strip(0))).toBe(0);
    expect(stepScrollLeft('next', [], { scrollLeft: 0, clientWidth: 382, scrollWidth: 382 })).toBe(0);
  });
});

describe('moreTabs', () => {
  it('finds tabs past the right end only at the start, past both in the middle, past the left only at the end', () => {
    expect(moreTabs(TABS, strip(0))).toEqual({ prev: false, next: true });
    expect(moreTabs(TABS, strip(100))).toEqual({ prev: true, next: true });
    expect(moreTabs(TABS, strip(218))).toEqual({ prev: true, next: false });
  });

  it('finds none on a strip that fits', () => {
    expect(moreTabs(TABS.slice(0, 3), { scrollLeft: 0, clientWidth: 382, scrollWidth: 382 })).toEqual({
      prev: false,
      next: false,
    });
  });

  it('does not take the padding before the first tab for a tab out of view', () => {
    // Scrolled 4px, only the strip's own padding is past the left end.
    expect(moreTabs(TABS, strip(4))).toEqual({ prev: false, next: true });
    expect(moreTabs(TABS, strip(6))).toEqual({ prev: true, next: true });
  });

  it('keeps the right end open until the strip is scrolled as far as it goes', () => {
    // The last tab is inside the view from 212, but the strip's faded edge is still over it.
    expect(moreTabs(TABS, strip(216))).toEqual({ prev: true, next: true });
    expect(moreTabs(TABS, strip(217.5))).toEqual({ prev: true, next: false });
  });

  it('finds none on a strip with no tabs', () => {
    expect(moreTabs([], strip(0))).toEqual({ prev: false, next: false });
  });
});
