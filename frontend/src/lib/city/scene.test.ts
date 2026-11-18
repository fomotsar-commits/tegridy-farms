import { describe, it, expect } from 'vitest';
import { iso } from '../iso';
import { cityRooms } from '../../hooks/useCityReads';
import { COS30, UNIT, createKit, hash, mix } from './kit';
import { PD, PW, buildPlan, walkLength, type PoolRead } from './plan';
import { createScene, type SceneData } from './scene';

/** A canvas that draws nothing and remembers every dash pattern it was handed. */
function fakeCanvas(): { ctx: CanvasRenderingContext2D; dashes: number[][]; calls: Map<string, number> } {
  const dashes: number[][] = [];
  const calls = new Map<string, number>();
  const gradient = { addColorStop() {} };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, name: string) {
      if (name in t) return t[name];
      return (...args: unknown[]) => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        if (name === 'setLineDash') dashes.push(args[0] as number[]);
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
  return { ctx, dashes, calls };
}

const rooms = cityRooms();
const NONE: SceneData = { pools: new Map(), paying: [], walletLit: false };
function stage() {
  const canvas = fakeCanvas();
  const plan = buildPlan(rooms);
  const scene = createScene({ ctx: canvas.ctx, plan, monoFont: 'monospace', mural: () => null });
  scene.resize(1200, 700, 1);
  return { ...canvas, plan, scene };
}
const dashed = (dashes: number[][]): number => dashes.filter((d) => d.length > 0).length;

describe('the drawing kit', () => {
  it("puts a point of the world where the site's own axonometric does, moved and scaled by the camera", () => {
    const cam = { x: 37, y: -12, z: 1.4 };
    const kit = createKit({ ctx: fakeCanvas().ctx, cam, time: () => 0, mural: () => null });
    for (const p of [[0, 0, 0], [3, 1, 2], [-4.5, 7.25, 0.5]] as const) {
      const want = iso(p, UNIT * cam.z);
      const got = kit.P(p[0], p[1], p[2]);
      expect(got[0]).toBeCloseTo(want[0] + cam.x, 9);
      expect(got[1]).toBeCloseTo(want[1] + cam.y, 9);
    }
  });
  it('mixes two inks and repeats itself', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#05080f', '#f5e4b8', 0)).toBe('#05080f');
    expect(hash(3, 4, 5)).toBe(hash(3, 4, 5));
    expect(hash(3, 4, 5)).toBeGreaterThanOrEqual(0);
    expect(hash(3, 4, 5)).toBeLessThan(1);
  });
});

describe('the city scene', () => {
  it('draws every plot, every piece, at every zoom a visitor can reach, without a fault', () => {
    const { scene, plan } = stage();
    scene.setData({ pools: new Map(rooms.map((r): [string, PoolRead] => [r.id, { state: 'level', usd: 250_000 }])), paying: rooms.map((r) => ({ roomId: r.id })), walletLit: true });
    scene.select(plan.byId.get(rooms[0]!.id)!);
    for (const zoom of [0.2, 0.36, 0.5, 0.7, 1, 1.6, 2.8]) {
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

  it('a wallet with no pool paying it lights its villa and still has nobody on the street', () => {
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
    // a steady line: about as many as before, none past the door
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
    for (let i = 0; i < 100; i++) scene.advance(0.1);
    expect(scene.people()).toEqual([]);
  });

  it('ignores a paying room it has no plot for, rather than inventing a walk', () => {
    const { scene } = stage();
    scene.setData({ ...NONE, walletLit: true, paying: [{ roomId: 'no-such-room' }] });
    for (let i = 0; i < 50; i++) scene.advance(0.1);
    expect(scene.people()).toEqual([]);
  });

  it('draws a pool that was not read in dashed line, and stops dashing it once it is read', () => {
    const unread = stage();
    unread.scene.setData(NONE);
    unread.scene.render();
    const read = stage();
    read.scene.setData({ ...NONE, pools: new Map(rooms.map((r): [string, PoolRead] => [r.id, { state: 'level', usd: 100_000 }])) });
    read.scene.render();
    expect(dashed(unread.dashes) - dashed(read.dashes)).toBe(rooms.length);
    const still = stage();
    still.scene.setData({ ...NONE, pools: new Map(rooms.map((r): [string, PoolRead] => [r.id, { state: 'still' }])) });
    still.scene.render();
    expect(dashed(still.dashes)).toBe(dashed(read.dashes));
  });

  it('finds the plot under a press', () => {
    const { scene, plan } = stage();
    scene.setData(NONE);
    scene.render();
    // the plot nearest the eye: nothing stands in front of it
    const near = plan.plots.reduce((a, b) => (b.depth > a.depth ? b : a));
    const k = UNIT * scene.cam.z;
    const x = near.x0 + PW / 2;
    const y = near.y0 + PD - 0.4;
    expect(scene.hit((x - y) * COS30 * k + scene.cam.x, (x + y) * 0.5 * k + scene.cam.y)?.id).toBe(near.id);
    expect(scene.hit(-5000, -5000)).toBeNull();
  });

  it('shows the whole island on a wide sheet, and stays readable on a phone', () => {
    const wide = stage();
    const phone = fakeCanvas();
    const scene = createScene({ ctx: phone.ctx, plan: buildPlan(rooms), monoFont: 'monospace', mural: () => null });
    scene.resize(390, 520, 3);
    expect(scene.cam.z).toBeGreaterThanOrEqual(0.5);
    expect(wide.scene.cam.z).toBeGreaterThan(0.3);
    wide.scene.zoomAt(600, 350, 99);
    expect(wide.scene.cam.z).toBeLessThanOrEqual(2.8);
    wide.scene.zoomAt(600, 350, 0.0001);
    expect(wide.scene.cam.z).toBeGreaterThanOrEqual(0.2);
  });
});
