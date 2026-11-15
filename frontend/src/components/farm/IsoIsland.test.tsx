// Earn's site model draws the registry and nothing else: one brick bungalow per pool, every one the
// same bungalow, wearing its own room's picture once that picture is read; a ladder exactly on
// the pools with the lock ladder, its rungs to scale; a key with the ladder's two ends from the
// contract's constants; and no rate anywhere. Pointing at a house lights it and lifts its roof;
// the tour only lights.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsoIsland } from './IsoIsland';
import { BUNGALOWS } from '../../lib/bungalows';
import { MAX_BOOST_BPS, MAX_LOCK_DURATION, MIN_BOOST_BPS, MIN_LOCK_DURATION } from '../../lib/constants';
import { doorArt } from '../../lib/doorArt';
import { derivedUrl, widthsFor } from '../../lib/artSrcSet';
import { iso } from '../../lib/iso';
import { MURAL_ACROSS, RAIL_TOP, U, gableFrame, muralFrame, railPoint, rungHeights } from '../../lib/isoBungalow';
import { meanLuma, resetPicturesForTests, restDim } from '../../lib/isoMural';
import { KEY, keyFoot, planBox, planStreets } from '../../lib/isoPlan';
import { hasLadder, venuePoolRows } from '../../lib/venuePools';

const rows = venuePoolRows();
const ladderRow = rows.find((r) => hasLadder(r.terms))!;
const plainRow = rows.find((r) => !hasLadder(r.terms));
const streets = planStreets(rows);
const plotOf = (id: string) => streets.flatMap((s) => s.plots).find((p) => p.row.id === id)!;
const roomOf = (id: string) => BUNGALOWS.find((b) => b.id === id)!;

const LONG = `${Math.round(MAX_LOCK_DURATION / (365 * 86_400))}y ${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`;
const SHORT = `${Math.round(MIN_LOCK_DURATION / 86_400)}d ${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`;

const houses = (root: HTMLElement) => Array.from(root.querySelectorAll<SVGGElement>('[data-pool]'));
const house = (root: HTMLElement, id: string) => root.querySelector<SVGGElement>(`[data-pool="${id}"]`)!;
/** A polygon's points as numbers. */
const pointsOf = (el: Element | null) => (el?.getAttribute('points') ?? '').trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number]);
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const num = (el: Element | null | undefined, name: string) => Number(el?.getAttribute(name));

/**
 * Each picture's size in these tests: its own shape, from its address, so two rooms' frames
 * differ (0.70 to 1.90 wide to 1 tall). A built copy (`…-128.webp`) has the shape of the picture
 * it copies, at its own width.
 */
function sizeOf(src: string) {
  const copy = /-(\d+)\.webp$/.exec(src);
  const base = copy ? src.slice(0, copy.index) : src;
  let h = 0;
  for (const ch of base) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const aspect = 0.7 + (h % 9) * 0.15;
  const w = copy ? Number(copy[1]) : 1400;
  return { w, h: Math.round(w / aspect) };
}
/** Every src an Image was given, in order. */
const asked: string[] = [];
/** An Image that loads a microtask after its src is set, or fails to where `fail` says so. */
function stubImages(fail = false) {
  vi.stubGlobal('Image', class {
    naturalWidth = 0;
    naturalHeight = 0;
    decoding = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      asked.push(value);
      queueMicrotask(() => {
        if (fail) return this.onerror?.();
        Object.assign(this, { naturalWidth: sizeOf(value).w, naturalHeight: sizeOf(value).h });
        this.onload?.();
      });
    }
  });
}
/** Every picture's pixels at this grey level, or none readable. */
function stubPixels(level: number | null) {
  const ctx = level === null ? null : { drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(level) }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D | null);
}
/** Lets every picture read land, and any read it leads to. */
const settle = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
/** The drawing measured at `px` CSS pixels wide on a screen of `dpr` device pixels each. */
function stubDrawnAt(px: number, dpr = 1) {
  vi.stubGlobal('ResizeObserver', class {
    readonly tell: () => void;
    constructor(tell: () => void) { this.tell = tell; }
    observe() { this.tell(); }
    disconnect() {}
  });
  vi.stubGlobal('devicePixelRatio', dpr);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: px } as DOMRect);
}
const frameOf = (el: Element | null | undefined) => ['x', 'y', 'width', 'height'].map((n) => num(el, n));

beforeEach(() => {
  resetPicturesForTests();
  asked.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the site model', () => {
  it('draws one bungalow per pool, as a picture: every pool is a link in the list under it', () => {
    const { container, getByTestId } = render(<IsoIsland rows={rows} />);
    expect(houses(container)).toHaveLength(rows.length);
    expect(getByTestId('earn-site-model').getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('a, button, [tabindex]')).toBeNull();
  });

  it('every bungalow is the same bungalow: the same outline moved to its plot, and at rest the same slate roof, none lifted', () => {
    const { container } = render(<IsoIsland rows={rows} />);
    const shapes = houses(container).map((g) => {
      const pts = pointsOf(g.querySelector('[data-hit=""]'));
      const [ox, oy] = pts[0]!;
      return pts.map(([x, y]) => `${(x - ox).toFixed(1)},${(y - oy).toFixed(1)}`).join(' ');
    });
    expect(new Set(shapes).size).toBe(1);
    const slopes = Array.from(container.querySelectorAll('[data-slope]')).map((s) => s.getAttribute('fill'));
    expect(slopes).toHaveLength(rows.length);
    expect(new Set(slopes).size).toBe(1);
    for (const g of houses(container)) {
      expect((g.querySelector('[data-roof]') as SVGGElement).style.transform).toBe('translateY(0px)');
      expect((g.querySelector('[data-underside]') as SVGElement).style.transform).toBe('translateY(0px)');
    }
    expect(container.querySelector('[data-lit], [data-lifted], [data-cut], [data-smoke], [data-label]')).toBeNull();
  });

  it('a ladder stands on exactly the pools whose terms have the lock ladder, its rungs to scale where the plan puts them', () => {
    const { container } = render(<IsoIsland rows={rows} />);
    for (const r of rows) {
      const ladder = house(container, r.id).querySelector('[data-ladder]');
      expect(Boolean(ladder), r.id).toBe(hasLadder(r.terms));
      if (!ladder) continue;
      const rungs = Array.from(ladder.querySelectorAll('[data-rung]'));
      const zs = rungs.map((l) => Number(l.getAttribute('data-rung')));
      expect(zs).toEqual(rungHeights().map((z) => Number(z.toFixed(4))));
      expect(zs[0]! / zs.at(-1)!).toBeCloseTo(MIN_BOOST_BPS / MAX_BOOST_BPS, 3);
      // Each rung runs from one rail to the other at its own height, on this house's plot.
      const plot = plotOf(r.id);
      rungHeights().forEach((z, i) => {
        const [a, b] = [iso(railPoint(plot.x, plot.y, 0, z), U), iso(railPoint(plot.x, plot.y, 1, z), U)];
        expect(num(rungs[i], 'x1')).toBeCloseTo(a[0], 6);
        expect(num(rungs[i], 'y1')).toBeCloseTo(a[1], 6);
        expect(num(rungs[i], 'x2')).toBeCloseTo(b[0], 6);
        expect(num(rungs[i], 'y2')).toBeCloseTo(b[1], 6);
      });
    }
    if (plainRow) expect(house(container, plainRow.id).querySelector('[data-ladder]')).toBeNull();
  });

  it('measures the drawing as it mounts, so its pictures load in a browser that is not drawing frames', async () => {
    vi.stubEnv('PROD', true);
    stubImages();
    stubPixels(null);
    // An observer that never reports, as in a hidden pane or a background tab.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    const { box } = planBox(streets);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: box.w } as DOMRect);
    const { container } = render(<IsoIsland rows={rows} />);
    await settle();
    expect(asked.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-wall="front"] image').length).toBeGreaterThan(0);
  });

  it('wears no picture until its size is read: its walls are brick, and stay brick where a picture fails to load', async () => {
    const unread = render(<IsoIsland rows={rows} />);
    await settle();
    expect(unread.container.querySelector('image')).toBeNull();
    expect(unread.container.querySelectorAll('[data-wall]')).toHaveLength(rows.length * 2);
    unread.unmount();
    resetPicturesForTests();
    stubImages(true);
    const failed = render(<IsoIsland rows={rows} />);
    await settle();
    expect(failed.container.querySelector('image')).toBeNull();
  });

  it('each bungalow wears its own room’s picture on both walls once read: the door card’s crop on the front, the picture as tall as the gable on its side', async () => {
    stubImages();
    stubPixels(null);
    const { container } = render(<IsoIsland rows={rows} />);
    await settle();
    const gables = new Set<string>();
    for (const r of rows) {
      const door = doorArt(roomOf(r.id));
      const front = house(container, r.id).querySelector('[data-wall="front"] image');
      const gable = house(container, r.id).querySelector('[data-wall="gable"] image');
      if (!door.src) {
        expect(front).toBeNull();
        continue;
      }
      expect(front?.getAttribute('href')).toBe(door.src);
      expect(gable?.getAttribute('href')).toBe(door.src);
      for (const img of [front, gable]) {
        expect(img!.getAttribute('preserveAspectRatio')).toBe('none');
        // Each picture fades in, in a group with its dimming.
        expect(img!.parentElement!.getAttribute('class')).toBe('iso-mural');
        expect(img!.parentElement!.hasAttribute('data-mural')).toBe(true);
      }
      const f = muralFrame(sizeOf(door.src), door.objectPosition);
      frameOf(front).forEach((v, i) => expect(v).toBeCloseTo([f.x, f.y, f.width, f.height][i]!, 3));
      const gf = gableFrame(sizeOf(door.src), door.objectPosition);
      frameOf(gable).forEach((v, i) => expect(v).toBeCloseTo([gf.x, gf.y, gf.width, gf.height][i]!, 3));
      gables.add(num(gable, 'width').toFixed(2));
    }
    // Every picture is framed by its own size, not one size for all.
    expect(gables.size).toBeGreaterThan(1);
  });

  it('fetches each picture at the copy its widest wall needs: the 128 where that spans no more than 128 device pixels', async () => {
    vi.stubEnv('PROD', true);
    stubImages();
    const { box } = planBox(streets);
    const doors = rows.map((r) => ({ id: r.id, door: doorArt(roomOf(r.id)) })).filter((d) => d.door.src && widthsFor(d.door.src).includes(480));
    expect(doors.length).toBeGreaterThan(2);
    const copiesAt = async (px: number, dpr: number) => {
      stubDrawnAt(px, dpr);
      stubPixels(null);
      const view = render(<IsoIsland rows={rows} />);
      await settle();
      const perUnit = (px * dpr) / box.w;
      const first = MURAL_ACROSS * perUnit <= 128 ? 128 : 480;
      const out = doors.map(({ id, door }) => {
        const href = house(view.container, id).querySelector('[data-wall="front"] image')?.getAttribute('href');
        // The copy first chosen, and the 480 where the picture's widest wall needs it.
        const shape = sizeOf(derivedUrl(door.src, first));
        const widest = Math.max(muralFrame(shape, door.objectPosition).width, gableFrame(shape, door.objectPosition).width);
        const want = first === 480 || widest * perUnit > 128 ? 480 : 128;
        expect(href, id).toBe(derivedUrl(door.src, want));
        return want;
      });
      view.unmount();
      resetPicturesForTests();
      vi.restoreAllMocks();
      return out;
    };
    // A picture spans MURAL_ACROSS units of the front wall: at one CSS pixel a unit and one device pixel each, under 128.
    expect(MURAL_ACROSS).toBeLessThan(128);
    expect(await copiesAt(box.w, 1)).toContain(128);
    expect(await copiesAt(box.w, 2)).toEqual(doors.map(() => 480));
    // A phone's drawing, a third that size, at three device pixels to the CSS pixel.
    expect(await copiesAt(box.w / 3, 3)).toContain(128);
    // A tablet's at two: the front needs only the 128, but the wider pictures' gables need the 480.
    const tablet = await copiesAt((box.w * 0.75), 2);
    expect(tablet).toContain(128);
    expect(tablet).toContain(480);
  });

  it('fetches no picture until the drawing has a size, then only the copies it needs', async () => {
    vi.stubEnv('PROD', true);
    stubImages();
    stubPixels(null);
    // An observer that has not yet reported: its report is held here until the test sends it.
    const held: { tell?: () => void } = {};
    vi.stubGlobal('ResizeObserver', class {
      readonly cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe() { held.tell = this.cb; }
      disconnect() {}
    });
    const { box } = planBox(streets);
    // No size yet (laid out in a box still collapsed), then the size it is drawn at.
    const drawnAt = { px: 0 };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: drawnAt.px }) as DOMRect);
    const { container } = render(<IsoIsland rows={rows} />);
    await settle();
    expect(asked).toEqual([]);
    expect(container.querySelector('image')).toBeNull();
    expect(held.tell).toBeDefined();
    drawnAt.px = box.w;
    act(() => held.tell?.());
    await settle();
    expect(asked.length).toBeGreaterThan(0);
    // At one device pixel a unit every front needs only the 128: no original, and a 480 only for a wide picture's gable.
    for (const src of asked) expect(src).toMatch(/-(128|480)\.webp$|^\/(?!_derived)/);
    expect(asked.filter((s) => s.endsWith('-128.webp')).length).toBeGreaterThan(asked.filter((s) => s.endsWith('-480.webp')).length);
    expect(container.querySelector('image')).not.toBeNull();
  });

  it('brings a picture brighter than the island down at rest, and shows it at full strength while lit', async () => {
    stubImages();
    stubPixels(235);
    const view = render(<IsoIsland rows={rows} />);
    await settle();
    const want = restDim(meanLuma([235, 235, 235, 235]));
    expect(want).toBeGreaterThan(0);
    const dims = Array.from(house(view.container, ladderRow.id).querySelectorAll('[data-dim]'));
    expect(dims).toHaveLength(2);
    for (const d of dims) {
      expect(d.getAttribute('data-dim')).toBe(want.toFixed(2));
      expect(Number(d.getAttribute('fill-opacity'))).toBeCloseTo(want, 6);
      // Laid on the picture alone: exactly its frame, in the same fading group.
      const img = d.parentElement!.querySelector('image');
      expect(frameOf(d)).toEqual(frameOf(img));
    }
    view.rerender(<IsoIsland rows={rows} active={ladderRow.id} />);
    for (const d of house(view.container, ladderRow.id).querySelectorAll('[data-dim]')) expect(Number(d.getAttribute('fill-opacity'))).toBe(0);
  });

  it('dims nothing where a picture is no brighter than the island', async () => {
    stubImages();
    stubPixels(60);
    const { container } = render(<IsoIsland rows={rows} />);
    await settle();
    expect(container.querySelector('image')).not.toBeNull();
    expect(container.querySelector('[data-dim]')).toBeNull();
  });

  it('prints the ladder’s two ends in its key, from the contract’s constants, beside the rungs they name, in the top right corner', () => {
    const { container } = render(<IsoIsland rows={rows} />);
    const keys = container.querySelectorAll('[data-key]');
    expect(keys).toHaveLength(1);
    const texts = Array.from(keys[0]!.querySelectorAll('text'));
    expect(texts.map(text)).toEqual(['Lock ladder', LONG, SHORT]);
    const rungLines = Array.from(keys[0]!.querySelectorAll('[data-key-rung]'));
    expect(rungLines.map((l) => Number(l.getAttribute('data-key-rung')))).toEqual(rungHeights().map((z) => Number(z.toFixed(4))));
    // The corner the plan keeps open, the ladder at the houses' scale under the caption.
    const { key } = planBox(streets);
    expect(num(texts[0], 'x')).toBe(key.right);
    expect(num(texts[0], 'y')).toBeCloseTo(key.top + KEY.captionPx, 6);
    rungHeights().forEach((z, i) => expect(num(rungLines[i], 'y1')).toBeCloseTo(keyFoot(key.top, 1) - z * U, 6));
    // Each figure sits on the rung it names: the longest lock on the top rung, the shortest on the first.
    expect(num(texts[1], 'y') - 4).toBeCloseTo(num(rungLines.at(-1), 'y1'), 6);
    expect(num(texts[2], 'y') - 4).toBeCloseTo(num(rungLines[0], 'y1'), 6);
    // Its rails are the houses' rails, and stand clear under the caption.
    const rails = Array.from(keys[0]!.querySelectorAll('line')).filter((l) => l.getAttribute('x1') === l.getAttribute('x2') && !l.hasAttribute('data-key-rung'));
    expect(rails).toHaveLength(2);
    for (const rail of rails) {
      expect(num(rail, 'y1') - num(rail, 'y2')).toBeCloseTo(RAIL_TOP * U, 6);
      expect(num(rail, 'y2')).toBeGreaterThanOrEqual(num(texts[0], 'y') + KEY.gapPx - 1e-6);
    }
    expect(keys[0]!.getAttribute('pointer-events')).toBe('none');
  });

  it('draws the key’s words larger where the drawing is drawn small, never past the size its corner is measured to hold', () => {
    const { box } = planBox(streets);
    const at = (px: number) => {
      stubDrawnAt(px);
      const view = render(<IsoIsland rows={rows} />);
      const caption = view.container.querySelector('[data-key] text');
      const size = num(caption, 'font-size');
      view.unmount();
      vi.restoreAllMocks();
      return size;
    };
    expect(at(box.w * 2)).toBe(KEY.captionPx);
    expect(at(box.w / 1.25)).toBeCloseTo(KEY.captionPx * 1.25, 6);
    expect(at(box.w / 3)).toBeCloseTo(KEY.captionPx * KEY.scaleMax, 6);
  });

  it('draws no key when no pool has the lock ladder', () => {
    const { container } = render(<IsoIsland rows={rows.map((r) => ({ ...r, terms: 'Streamflow' }))} />);
    expect(container.querySelector('[data-key]')).toBeNull();
    expect(container.querySelector('[data-ladder]')).toBeNull();
  });

  it('prints no rate, lit or not: its only words are its streets’ names, its key, and the name over a roof lifted off', () => {
    const words = (root: HTMLElement) => Array.from(root.querySelectorAll('text')).map(text).sort();
    const key = ['Lock ladder', LONG, SHORT];
    const unlit = render(<IsoIsland rows={rows} />);
    expect(unlit.container.textContent).not.toMatch(/%|APR|\$/);
    expect(words(unlit.container)).toEqual([...streets.map((s) => s.name), ...key].sort());
    unlit.unmount();
    const lit = render(<IsoIsland rows={rows} active={ladderRow.id} />);
    expect(lit.container.textContent).not.toMatch(/%|APR|\$/);
    expect(words(lit.container)).toEqual([...streets.map((s) => s.name), ...key, ladderRow.symbol].sort());
    expect(text(house(lit.container, ladderRow.id).querySelector('[data-label] text'))).toBe(ladderRow.symbol);
  });

  it('the house pointed at lights and lifts its roof off: its walls cut, lit inside, its chimney smoking, its name over it', () => {
    const { container } = render(<IsoIsland rows={rows} active={ladderRow.id} />);
    const on = house(container, ladderRow.id);
    expect(on.hasAttribute('data-lit')).toBe(true);
    expect(on.hasAttribute('data-lifted')).toBe(true);
    expect(on.querySelector('[data-cut]')).not.toBeNull();
    expect(on.querySelector('[data-smoke]')).not.toBeNull();
    expect(on.querySelector('[data-label]')).not.toBeNull();
    expect((on.querySelector('[data-roof]') as SVGGElement).style.transform).toBe('translateY(-20px)');
    // The roof's underside rides with the roof.
    expect((on.querySelector('[data-underside]') as SVGElement).style.transform).toBe('translateY(-20px)');
    expect(container.querySelectorAll('[data-lit]')).toHaveLength(1);
    for (const g of houses(container).filter((x) => x !== on)) {
      expect((g.querySelector('[data-roof]') as SVGGElement).style.transform).toBe('translateY(0px)');
      expect(g.querySelector('[data-cut], [data-smoke], [data-label]')).toBeNull();
    }
    // Inside is always there, under the walls and the roof, so a roof coming down never shows a house hollow.
    for (const g of houses(container)) expect(g.querySelector('[data-inside]')).not.toBeNull();
  });

  it('the shapes that take the pointer are the house, its chimney and its cap, and they do not move when a roof lifts', () => {
    const outlines = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-hit]')).map((p) => p.getAttribute('points'));
    const still = render(<IsoIsland rows={rows} />);
    const before = outlines(still.container);
    for (const g of houses(still.container)) {
      expect(Array.from(g.querySelectorAll('[data-hit]')).map((p) => p.getAttribute('data-hit'))).toEqual(['', 'chimney', 'cap']);
      for (const hit of g.querySelectorAll('[data-hit]')) expect(hit.getAttribute('pointer-events')).toBe('all');
      // Everything drawn lets the pointer through to them.
      expect(g.querySelector(':scope > g')?.getAttribute('pointer-events')).toBe('none');
    }
    still.unmount();
    const lifted = render(<IsoIsland rows={rows} active={ladderRow.id} />);
    expect(outlines(lifted.container)).toEqual(before);
    expect(before).toHaveLength(rows.length * 3);
  });

  it('pointing at a house tells the list, and a press on it or its chimney opens its pool', () => {
    const onActive = vi.fn();
    const onOpen = vi.fn();
    const { container, getByTestId } = render(<IsoIsland rows={rows} onActive={onActive} onOpen={onOpen} />);
    const target = house(container, ladderRow.id);
    fireEvent.mouseEnter(target);
    expect(onActive).toHaveBeenLastCalledWith(ladderRow.id);
    fireEvent.click(target.querySelector('[data-hit=""]')!);
    fireEvent.click(target.querySelector('[data-hit="chimney"]')!);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith(ladderRow.id);
    fireEvent.mouseLeave(getByTestId('earn-site-model'));
    expect(onActive).toHaveBeenLastCalledWith(null);
  });

  it('left alone it lights each house in turn without lifting a roof', () => {
    vi.useFakeTimers();
    const moving = render(<IsoIsland rows={rows} />);
    expect(moving.container.querySelector('[data-lit]')).toBeNull();
    act(() => { vi.advanceTimersByTime(2400); });
    const first = moving.container.querySelector('[data-lit]')?.getAttribute('data-pool');
    expect(first).toBeTruthy();
    expect(moving.container.querySelector('[data-lifted], [data-label], [data-smoke]')).toBeNull();
    act(() => { vi.advanceTimersByTime(2400); });
    expect(moving.container.querySelector('[data-lit]')?.getAttribute('data-pool')).not.toBe(first);
  });

  it('holds still under reduced motion, off screen, and in a hidden tab', () => {
    vi.useFakeTimers();
    const stillAfter = (setup: () => void) => {
      setup();
      const view = render(<IsoIsland rows={rows} />);
      act(() => { vi.advanceTimersByTime(10_000); });
      const lit = view.container.querySelector('[data-lit]');
      view.unmount();
      vi.unstubAllGlobals();
      return lit;
    };
    expect(stillAfter(() => vi.stubGlobal('matchMedia', (query: string) => ({ matches: /reduce/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {} })))).toBeNull();
    const seenAs = (isIntersecting: boolean) => () => vi.stubGlobal('IntersectionObserver', class {
      readonly tell: (entries: { isIntersecting: boolean }[]) => void;
      constructor(tell: (entries: { isIntersecting: boolean }[]) => void) { this.tell = tell; }
      observe() { this.tell([{ isIntersecting }]); }
      disconnect() {}
    });
    expect(stillAfter(seenAs(false))).toBeNull();
    // On screen it tours, so the two above held still for their own reasons.
    expect(stillAfter(seenAs(true))).not.toBeNull();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      expect(stillAfter(seenAs(true))).toBeNull();
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  it('smokes twice and then holds still, and fades each picture in', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const smoke = /\.iso-smoke\s*\{[^}]*animation:\s*iso-smoke\s+[\d.]+s\s+[\w-]+\s+(\w+)\s*;/.exec(css);
    expect(smoke?.[1]).toBe('2');
    expect(css).toMatch(/\.iso-mural\s*\{\s*animation:\s*iso-mural-in\s+[\d.]+s[^;]*\bboth\s*;/);
  });
});
