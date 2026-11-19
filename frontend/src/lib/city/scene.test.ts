import { describe, it, expect } from 'vitest';
import { iso } from '../iso';
import { cityRooms } from '../../hooks/useCityReads';
import { COS30, UNIT, createKit, hash, mix } from './kit';
import { PD, PW, buildPlan, walkLength } from './plan';
import { RENDER, RENDER_CENTER } from './render';
import { createScene, type SceneData } from './scene';

/** A canvas that draws nothing and remembers every picture laid on it. */
function fakeCanvas(): { ctx: CanvasRenderingContext2D; images: number[][] } {
  const images: number[][] = [];
  const gradient = { addColorStop() {} };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, name: string) {
      if (name in t) return t[name];
      return (...args: unknown[]) => {
        if (name === 'drawImage') images.push(args.slice(1) as number[]);
        if (name === 'createLinearGradient' || name === 'createRadialGradient') return gradient;
        if (name === 'measureText') return { width: 6 };
        return undefined;
      };
    },
    set(t, name: string, value) {
      t[name] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, images };
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
  it('draws the live parts even before the picture has come', () => {
    const { scene, images } = stage();
    scene.setData({ paying: [{ roomId: rooms[0]!.id }], walletLit: true });
    expect(() => scene.render()).not.toThrow();
    expect(images).toEqual([]);
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
    const x = near.x0 + PW / 2;
    const y = near.y0 + PD - 0.4;
    expect(scene.hit((x - y) * COS30 * k + scene.cam.x, (x + y) * 0.5 * k + scene.cam.y)?.id).toBe(near.id);
    expect(scene.hit(-5000, -5000)).toBeNull();
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
