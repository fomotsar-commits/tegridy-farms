import { describe, it, expect } from 'vitest';
import { iso } from '../iso';
import { cityRooms } from '../../hooks/useCityReads';
import { BG, COS30, UNIT, createKit, hash, mix } from './kit';
import { FD, FW, PD, PW, buildPlan, coast, onSite, walkLength } from './plan';
import { PIECE_TOP, RENDER, RENDER_CENTER, RENDER_SPAN } from './render';
import { EDGE_FADE, ISLAND_BOX, PERSON_MIN_PX, PICK_PULSE, PLAQUE_FULL_K, createScene, type SceneData } from './scene';

/** A canvas that draws nothing and remembers every picture laid on it, and every fill made with a gradient. */
interface Gradient { from: number[]; stops: [number, string][] }
function fakeCanvas(): { ctx: CanvasRenderingContext2D; images: number[][]; shades: { rect: number[]; g: Gradient }[]; texts: string[]; dashes: number[][]; ellipses: number[][] } {
  const images: number[][] = [];
  const shades: { rect: number[]; g: Gradient }[] = [];
  const texts: string[] = [];
  const dashes: number[][] = [];
  const ellipses: number[][] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, name: string) {
      if (name in t) return t[name];
      return (...args: unknown[]) => {
        if (name === 'drawImage') images.push(args.slice(1) as number[]);
        if (name === 'fillText') texts.push(String(args[0]));
        if (name === 'setLineDash') dashes.push(args[0] as number[]);
        if (name === 'ellipse') ellipses.push(args as number[]);
        if (name === 'createLinearGradient' || name === 'createRadialGradient') {
          const g: Gradient = { from: args as number[], stops: [] };
          return { g, addColorStop: (at: number, col: string) => g.stops.push([at, col]) };
        }
        if (name === 'fillRect' && typeof t.fillStyle === 'object' && t.fillStyle) shades.push({ rect: args as number[], g: (t.fillStyle as { g: Gradient }).g });
        if (name === 'measureText') return { width: 6 };
        return undefined;
      };
    },
    set(t, name: string, value) {
      t[name] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, images, shades, texts, dashes, ellipses };
}

const rooms = cityRooms();
const NONE: SceneData = { paying: [], walletLit: false };
function stage(w = 1200, h = 700) {
  const canvas = fakeCanvas();
  const plan = buildPlan(rooms);
  const scene = createScene({ ctx: canvas.ctx, plan, monoFont: 'monospace' });
  scene.resize(w, h, 1);
  return { ...canvas, plan, scene };
}

describe('the drawing kit', () => {
  it("puts a point of the world where the site's own axonometric does, moved and scaled by the camera", () => {
    const cam = { x: 37, y: -12, z: 1.4 };
    const kit = createKit({ ctx: fakeCanvas().ctx, cam });
    for (const p of [[0, 0, 0], [3, 1, 2], [-4.5, 7.25, 0.5]] as const) {
      const want = iso(p, UNIT * cam.z);
      const got = kit.P(p[0], p[1], p[2]);
      expect(got[0]).toBeCloseTo(want[0] + cam.x, 9);
      expect(got[1]).toBeCloseTo(want[1] + cam.y, 9);
    }
  });
  it('mixes two inks and repeats itself', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(hash(3, 4, 5)).toBe(hash(3, 4, 5));
  });
});

describe("the island's picture", () => {
  it('lays it so the world point it was rendered from lands at its middle, at its own scale, at every zoom', () => {
    const { scene, images } = stage();
    for (const which of ['half', 'full'] as const) {
      const r = RENDER[which];
      scene.setBackdrop({ img: {} as CanvasImageSource, k: r.k, width: r.width, height: r.height });
      for (const zoom of [0.3, 0.8, 1.5, 2.4]) {
        scene.zoomAt(600, 350, zoom);
        images.length = 0;
        scene.render();
        const [dx, dy, dw, dh] = images[0]!;
        const k = UNIT * scene.cam.z;
        const [cx, cy, cz] = RENDER_CENTER;
        expect(dw).toBeCloseTo((r.width * k) / r.k, 6);
        expect(dh).toBeCloseTo((r.height * k) / r.k, 6);
        expect(dx! + dw! / 2).toBeCloseTo((cx - cy) * COS30 * k + scene.cam.x, 6);
        expect(dy! + dh! / 2).toBeCloseTo(((cx + cy) / 2 - cz) * k + scene.cam.y, 6);
      }
    }
  });
  // Owner, 2026-11-19, "verify everything is working perfectly": the sea ran off the picture's
  // sides and stopped at a straight line, at the whole island on a wide screen and on any pan.
  it('fades its border into the night on every side, opaque at the edge, and never over the shore', () => {
    const { scene, images, shades } = stage();
    const r = RENDER.full;
    scene.setBackdrop({ img: {} as CanvasImageSource, k: r.k, width: r.width, height: r.height });
    for (const zoom of [0.3, 1, 2.4]) {
      scene.zoomAt(600, 350, zoom);
      images.length = 0;
      shades.length = 0;
      scene.render();
      const [x, y, w, h] = images[0]!;
      const band = EDGE_FADE * w!;
      // the four bands, each on its own edge of the picture, each from opaque night to nothing
      const sides = shades.slice(0, 4);
      expect(sides.map((s) => s.rect)).toEqual([
        [x, y, band, h],
        [x! + w! - band, y, band, h],
        [x, y, w, band],
        [x, y! + h! - band, w, band],
      ]);
      for (const { g } of sides) {
        expect(g.stops[0]).toEqual([0, BG]);
        expect(g.stops.at(-1)![1]).toMatch(/,0\)$/);
      }
      const edges = [x!, x! + w!, y!, y! + h!];
      expect(sides.map((s, i) => (i < 2 ? s.g.from[0] : s.g.from[1]))).toEqual(edges);
    }
    // the shore stands further in from every edge than the band reaches
    const [cx, cy, cz] = RENDER_CENTER;
    for (const [px, py] of coast(1)) {
      const sx = ((px! - py! - (cx - cy)) * Math.sqrt(3)) / 2;
      const sy = (px! + py! - (cx + cy)) / 2 + cz;
      expect(RENDER_SPAN[0] / 2 - Math.abs(sx)).toBeGreaterThan(EDGE_FADE * RENDER_SPAN[0]);
      expect(RENDER_SPAN[1] / 2 - Math.abs(sy)).toBeGreaterThan(EDGE_FADE * RENDER_SPAN[0]);
    }
  });
  // Review, 2026-11-19: before the picture came, plaques, road names and the outline floated on black.
  it('before the picture has come, draws the night and a word that it is coming, and no plaque; a press still lands', () => {
    const { scene, images, texts, plan } = stage();
    scene.setData({ paying: [{ roomId: rooms[0]!.id }], walletLit: true });
    scene.select(plan.byId.get('bayla')!);
    scene.render();
    expect(images).toEqual([]);
    expect(texts.join('')).toBe('DRAWING THE ISLAND');
    const near = plan.plots.reduce((a, b) => (b.depth > a.depth ? b : a));
    const k = UNIT * scene.cam.z;
    const [x, y] = onSite(near, near.x0 + PW / 2, near.y0 + PD - 0.4);
    expect(scene.hit((x - y) * COS30 * k + scene.cam.x, (x + y) * 0.5 * k + scene.cam.y)?.id).toBe(near.id);
    texts.length = 0;
    scene.setBackdrop({ img: {} as CanvasImageSource, k: RENDER.half.k, width: RENDER.half.width, height: RENDER.half.height });
    scene.render();
    expect(texts.join('')).toContain('BAYLA');
    expect(texts.join('')).not.toContain('DRAWING');
  });
});

describe('the city scene', () => {
  it('draws at every zoom a visitor can reach, without a fault', () => {
    const { scene, plan } = stage();
    scene.setBackdrop({ img: {} as CanvasImageSource, k: RENDER.half.k, width: RENDER.half.width, height: RENDER.half.height });
    scene.setData({ paying: rooms.map((r) => ({ roomId: r.id })), walletLit: true });
    scene.select(plan.byId.get(rooms[0]!.id)!);
    for (const zoom of [0.2, 0.36, 0.5, 0.7, 1, 1.6, 2.6]) {
      scene.zoomAt(600, 350, zoom);
      scene.advance(0.4);
      expect(() => scene.render()).not.toThrow();
    }
  });

  it('with nothing read, has nobody on the street however long it runs', () => {
    const { scene } = stage();
    scene.setData(NONE);
    for (let i = 0; i < 600; i++) scene.advance(0.1);
    expect(scene.people()).toEqual([]);
    expect(scene.isLive()).toBe(false);
  });

  it('a wallet with no pool paying it still has nobody on the street', () => {
    const { scene } = stage();
    scene.setData({ ...NONE, walletLit: true });
    for (let i = 0; i < 100; i++) scene.advance(0.1);
    expect(scene.people()).toEqual([]);
  });

  it('walks people only from a pool a read says is paying, already part-way along when the page opens', () => {
    const { scene, plan } = stage();
    const from = rooms[0]!.id;
    scene.setData({ ...NONE, walletLit: true, paying: [{ roomId: from }] });
    const people = scene.people();
    expect(people.length).toBeGreaterThan(3);
    expect(new Set(people.map((p) => p.roomId))).toEqual(new Set([from]));
    const total = walkLength(plan.byId.get(from)!.walk!);
    expect(Math.max(...people.map((p) => p.d))).toBeGreaterThan(total * 0.7);
    expect(people.every((p) => p.d >= 0 && p.d < total)).toBe(true);
  });

  it('keeps them coming, and lets each one arrive', () => {
    const { scene, plan } = stage();
    const from = rooms[0]!.id;
    scene.setData({ ...NONE, walletLit: true, paying: [{ roomId: from }] });
    const total = walkLength(plan.byId.get(from)!.walk!);
    const before = scene.people().length;
    for (let i = 0; i < 2000; i++) scene.advance(0.05);
    const after = scene.people();
    expect(after.length).toBeGreaterThan(before - 3);
    expect(after.length).toBeLessThan(before + 3);
    expect(after.every((p) => p.d < total)).toBe(true);
  });

  it('clears the street the moment a pool stops paying', () => {
    const { scene } = stage();
    const [a, b] = [rooms[0]!.id, rooms[1]!.id];
    scene.setData({ ...NONE, walletLit: true, paying: [{ roomId: a }, { roomId: b }] });
    expect(new Set(scene.people().map((p) => p.roomId))).toEqual(new Set([a, b]));
    scene.setData({ ...NONE, walletLit: true, paying: [{ roomId: b }] });
    expect(new Set(scene.people().map((p) => p.roomId))).toEqual(new Set([b]));
    scene.setData(NONE);
    expect(scene.people()).toEqual([]);
  });

  it('ignores a paying room it has no plot for, rather than inventing a walk', () => {
    const { scene } = stage();
    scene.setData({ ...NONE, walletLit: true, paying: [{ roomId: 'no-such-room' }] });
    for (let i = 0; i < 50; i++) scene.advance(0.1);
    expect(scene.people()).toEqual([]);
  });

  it('finds the plot under a press', () => {
    const { scene, plan } = stage();
    scene.setData(NONE);
    scene.render();
    const near = plan.plots.reduce((a, b) => (b.depth > a.depth ? b : a));
    const k = UNIT * scene.cam.z;
    const [x, y] = onSite(near, near.x0 + PW / 2, near.y0 + PD - 0.4);
    expect(scene.hit((x - y) * COS30 * k + scene.cam.x, (x + y) * 0.5 * k + scene.cam.y)?.id).toBe(near.id);
    expect(scene.hit(-5000, -5000)).toBeNull();
  });

  // The scattered town (2026-11-20) stands plots close, turned every way: a press on a building
  // must still find it, and not the plot standing nearer the eye beside it.
  it('picks every plot from a press on the middle of its building, however close a nearer plot stands', () => {
    const { scene, plan } = stage();
    scene.setData(NONE);
    scene.fit(true);
    scene.render();
    const k = UNIT * scene.cam.z;
    for (const p of plan.plots) {
      const [x, y] = onSite(p, p.X + FW / 2, p.Y + FD / 2);
      const z = PIECE_TOP[p.piece] / 2;
      expect(scene.hit((x - y) * COS30 * k + scene.cam.x, ((x + y) * 0.5 - z) * k + scene.cam.y)?.id, p.id).toBe(p.id);
    }
  });

  // Review, 2026-11-19: on a phone, Whole island showed mid-town, with five plots off the sheet.
  it('shows the whole island on Whole island, on a phone as on a desk, and never lets it shrink to a stamp', () => {
    for (const [w, h] of [[390, 520], [820, 700], [1360, 612]] as const) {
      const { scene } = stage(w, h);
      scene.fit(true);
      const k = UNIT * scene.cam.z;
      const sx = (u: number) => u * k + scene.cam.x;
      const sy = (v: number) => v * k + scene.cam.y;
      expect(sx(ISLAND_BOX.u0), w + ' left').toBeGreaterThanOrEqual(0);
      expect(sx(ISLAND_BOX.u1), w + ' right').toBeLessThanOrEqual(w);
      expect(sy(ISLAND_BOX.v0), w + ' top').toBeGreaterThanOrEqual(0);
      expect(sy(ISLAND_BOX.v1), w + ' bottom').toBeLessThanOrEqual(h);
      // it fills the sheet one way or the other
      expect(Math.max((sx(ISLAND_BOX.u1) - sx(ISLAND_BOX.u0)) / w, (sy(ISLAND_BOX.v1) - sy(ISLAND_BOX.v0)) / h)).toBeGreaterThan(0.9);
      // zoomed out as far as it goes, the island still takes most of the sheet
      scene.zoomAt(w / 2, h / 2, 0.0001);
      const k2 = UNIT * scene.cam.z;
      expect(Math.max(((ISLAND_BOX.u1 - ISLAND_BOX.u0) * k2) / w, ((ISLAND_BOX.v1 - ISLAND_BOX.v0) * k2) / h), w + ' at the floor').toBeGreaterThan(0.75);
    }
  });

  it('dots the way to the wallet from each paying room, and from no other', () => {
    const { scene, dashes } = stage();
    scene.setBackdrop({ img: {} as CanvasImageSource, k: RENDER.half.k, width: RENDER.half.width, height: RENDER.half.height });
    scene.render();
    expect(dashes.filter((d) => d.length > 0)).toEqual([]);
    scene.setData({ walletLit: true, paying: [{ roomId: rooms[0]!.id }, { roomId: rooms[1]!.id }] });
    dashes.length = 0;
    scene.render();
    expect(dashes.filter((d) => d.length > 0)).toHaveLength(2);
  });

  it('draws a person never shorter than PERSON_MIN_PX, however far out the island is', () => {
    const { scene, ellipses } = stage();
    scene.setBackdrop({ img: {} as CanvasImageSource, k: RENDER.half.k, width: RENDER.half.width, height: RENDER.half.height });
    scene.setData({ walletLit: true, paying: [{ roomId: rooms[0]!.id }] });
    scene.zoomAt(600, 350, 0.0001);
    ellipses.length = 0;
    scene.render();
    // a person's body is the tallest of their ellipses, 0.19 of the scale they are drawn at, which is PERSON_MIN_PX / 0.8 at least
    const bodies = ellipses.map((e) => e[3]!).filter((ry) => ry > 0);
    expect(Math.max(...bodies)).toBeGreaterThanOrEqual((0.19 * PERSON_MIN_PX) / 0.8 - 1e-9);
  });

  // Review, 2026-11-19: the picked plot's pulse kept the sheet drawing every frame, with nobody walking.
  it('lets the outline of a pick pulse a moment, then hold still, so an empty street needs no frames', () => {
    const { scene, plan } = stage();
    scene.setData(NONE);
    scene.select(plan.byId.get('bayla')!);
    expect(scene.isLive()).toBe(true);
    for (let t = 0; t < PICK_PULSE + 0.2; t += 0.1) scene.advance(0.1);
    expect(scene.isLive()).toBe(false);
  });

  // Seen at 390 wide, 2026-11-19: at the whole island the twenty plaques piled on each other.
  it("at a phone's whole island, names only the picked plot, and marks the rest; closer in, names them all", () => {
    const { scene, texts, plan } = stage(390, 520);
    scene.setBackdrop({ img: {} as CanvasImageSource, k: RENDER.half.k, width: RENDER.half.width, height: RENDER.half.height });
    scene.select(plan.byId.get('bayla')!);
    scene.fit(true);
    expect(UNIT * scene.cam.z).toBeLessThan(PLAQUE_FULL_K);
    scene.render();
    const far = texts.join('');
    expect(far).toContain('BAYLA');
    for (const other of ['TOWELI', 'PEPE', 'LOANS', 'KEEPER', 'TREASURY']) expect(far, other).not.toContain(other);
    texts.length = 0;
    scene.fit();
    scene.render();
    const near = texts.join('');
    for (const name of ['BAYLA', 'TOWELI', 'PEPE', 'TREASURY']) expect(near, name).toContain(name);
  });

  it('says on the drawing what a press does, until told to stop', () => {
    const { scene, texts } = stage();
    scene.setBackdrop({ img: {} as CanvasImageSource, k: RENDER.half.k, width: RENDER.half.width, height: RENDER.half.height });
    scene.setHint('Tap a building to see it close up');
    scene.render();
    expect(texts.join('')).toContain('TAP A BUILDING TO SEE IT CLOSE UP');
    texts.length = 0;
    scene.setHint(null);
    scene.render();
    expect(texts.join('')).not.toContain('TAP A');
  });

  it('opens readable on a phone, and zooms no further than the full picture stays sharp', () => {
    const phone = stage(390, 520).scene;
    expect(phone.cam.z).toBeGreaterThanOrEqual(0.55);
    const { scene } = stage();
    scene.zoomAt(600, 350, 99);
    expect(UNIT * scene.cam.z).toBeLessThanOrEqual(RENDER.full.k * 1.3 + 1e-9);
    scene.zoomAt(600, 350, 0.0001);
    expect(scene.cam.z).toBeGreaterThanOrEqual(0.2);
  });
});
