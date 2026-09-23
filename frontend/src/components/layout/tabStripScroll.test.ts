/**
 * The scroll math RouteTabs uses to bring the selected tab into view. jsdom lays
 * nothing out, so the strip's boxes are given as numbers here; the rendered
 * behaviour is measured in e2e/tab-strip-scroll.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { STRIP_EDGE_PX, revealScrollLeft, stripFade, stripFadeMask } from './tabStripScroll';

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
});

describe('stripFade', () => {
  it('fades neither edge of a strip that fits, sub-pixel rounding included', () => {
    expect(stripFade({ scrollLeft: 0, clientWidth: 382, scrollWidth: 382.6 })).toEqual({ start: false, end: false });
  });

  it('fades the end at the start, the start at the end, and both in between', () => {
    expect(stripFade(strip(0))).toEqual({ start: false, end: true });
    expect(stripFade(strip(218))).toEqual({ start: true, end: false });
    expect(stripFade(strip(100))).toEqual({ start: true, end: true });
  });

  it('counts a strip within a pixel of an end as at that end', () => {
    expect(stripFade(strip(0.5))).toEqual({ start: false, end: true });
    expect(stripFade(strip(217.5))).toEqual({ start: true, end: false });
  });
});

describe('stripFadeMask', () => {
  // A mask stop that is transparent hides what is under it: that edge fades.
  const clearFirst = /^linear-gradient\(to right, transparent,/;
  const clearLast = /, transparent\)$/;

  it('masks nothing when neither edge fades', () => {
    expect(stripFadeMask({ start: false, end: false })).toBeUndefined();
  });

  it('clears only the edge that fades, over STRIP_EDGE_PX', () => {
    const end = stripFadeMask({ start: false, end: true })!;
    expect(end).toMatch(clearLast);
    expect(end).not.toMatch(clearFirst);
    const start = stripFadeMask({ start: true, end: false })!;
    expect(start).toMatch(clearFirst);
    expect(start).not.toMatch(clearLast);
    const both = stripFadeMask({ start: true, end: true })!;
    expect(both).toMatch(clearFirst);
    expect(both).toMatch(clearLast);
    for (const m of [start, end, both]) expect(m).toContain(`${STRIP_EDGE_PX}px`);
  });
});
