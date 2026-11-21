import { describe, it, expect } from 'vitest';
import { BUNGALOWS } from '../bungalows';
import type { Pt } from '../iso';
import { cityRooms } from '../../hooks/useCityReads';
import {
  JUNCTION_R, KERB, NC, NR, PD, PW, SETBACK, SLOTS, SX, SY, VILLA_DECK, ZEBRA_SHARE,
  buildPlan, coast, crossing, onSite, plotCorners, roadDistance, walkAt, walkLength, type Plot, type Room,
} from './plan';

const rooms = cityRooms();
const plan = buildPlan(rooms);
const fake = (id: string): Room => ({ id, name: id.toUpperCase(), symbol: id.toUpperCase(), chain: 'base', address: `0x${id}`, accent: '#8f8f8f' });

const inPoly = (poly: readonly Pt[], [x, y]: Pt): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
/** Points over a plot's whole ground, edges and inside, every `step`. */
function ground(p: Plot, step = 0.25): Pt[] {
  const out: Pt[] = [];
  for (let fx = 0; fx <= PW + 1e-9; fx += step) for (let fy = 0; fy <= PD + 1e-9; fy += step) out.push(onSite(p, p.x0 + fx, p.y0 + fy));
  return out;
}
/** Two convex outlines overlap unless a line separates them. */
function overlap(a: readonly Pt[], b: readonly Pt[]): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const n: Pt = [q[1] - p[1], p[0] - q[0]];
      const proj = (s: readonly Pt[]): [number, number] => {
        const v = s.map(([x, y]) => x * n[0] + y * n[1]);
        return [Math.min(...v), Math.max(...v)];
      };
      const [a0, a1] = proj(a);
      const [b0, b1] = proj(b);
      if (a1 < b0 || b1 < a0) return false;
    }
  return true;
}

describe('the city plan', () => {
  it('gives every live room in the registry a plot: a new room fails here until it has one', () => {
    expect(rooms.length).toBeGreaterThan(0);
    expect(plan.unplaced).toEqual([]);
    for (const b of BUNGALOWS.filter((x) => x.live && x.chain !== 'tbd')) {
      const plot = plan.byId.get(b.id);
      expect(plot, b.id).toBeDefined();
      expect(plot!.kind).toBe('room');
      // the registry's own facts, never retyped: its ticker, its whole address, its door
      expect(plot!.tick).toBe(b.symbol);
      expect(plot!.addr).toBe(b.address);
      expect(plot!.href).toBe(`/${b.id}`);
      expect(plot!.mural).toBe(b.id);
    }
  });

  it('reports a room that has no plot rather than dropping it', () => {
    expect(buildPlan([...rooms, fake('newcoin')]).unplaced).toEqual(['newcoin']);
  });

  it('keeps a plot whose room is not in the registry yet as an open lot, and builds on it when the room arrives', () => {
    const slot = SLOTS.find((s) => 'room' in s && !rooms.some((r) => r.id === s.room));
    if (!slot || !('room' in slot)) return; // every placed room is live: nothing waits
    const waiting = plan.plots.find((p) => p.c === slot.c && p.r === slot.r)!;
    expect(waiting.piece).toBe('ghost');
    expect(waiting.kind).toBe('civic');
    expect(waiting.addr).toBeUndefined();
    expect(waiting.walk).toBeUndefined();
    const built = buildPlan([...rooms, fake(slot.room)]).byId.get(slot.room)!;
    expect(built.piece).toBe(slot.piece);
    expect(built.site).toEqual(waiting.site);
    expect(built.walk).toBeDefined();
  });

  it('makes twenty plots, each in its own frame, every one the same size', () => {
    expect(plan.plots).toHaveLength(NC * NR);
    expect(new Set(plan.plots.map((p) => `${p.c},${p.r}`)).size).toBe(NC * NR);
    for (const p of plan.plots) {
      expect(p.x0).toBeCloseTo(p.c * SX + (SX - PW));
      expect(p.y0).toBeCloseTo(p.r * SY + (SY - PD));
      // a frame is only turned and moved, never stretched
      const [a, b, c] = plotCorners(p);
      expect(Math.hypot(b![0] - a![0], b![1] - a![1])).toBeCloseTo(PW, 9);
      expect(Math.hypot(c![0] - b![0], c![1] - b![1])).toBeCloseTo(PD, 9);
    }
  });

  it('gives each plot its own piece, and each room its own pool shape and water', () => {
    expect(new Set(SLOTS.map((s) => s.piece)).size).toBe(SLOTS.length);
    const roomSlots = SLOTS.flatMap((s) => ('room' in s ? [s] : []));
    expect(new Set(roomSlots.map((s) => s.shape)).size).toBe(roomSlots.length);
    expect(new Set(roomSlots.map((s) => s.water)).size).toBe(roomSlots.length);
  });
});

// Owner, 2026-11-20: "the city is too gridlike lets scatter some things around give it a nice layout not a grid".
describe('the town, scattered', () => {
  it('stands every plot on the land, apart from every other, off every road and out of every junction', () => {
    const land = coast(0.97);
    for (const p of plan.plots) {
      for (const q of plotCorners(p)) expect(inPoly(land, q), `${p.id} off the land`).toBe(true);
      const near = Math.min(...ground(p).map((q) => roadDistance(plan.roads, q)));
      expect(near, `${p.id} on a road`).toBeGreaterThan(SETBACK - 0.05);
      for (const j of plan.junctions) for (const q of plotCorners(p)) expect(Math.hypot(q[0] - j[0], q[1] - j[1]), `${p.id} in a junction`).toBeGreaterThan(JUNCTION_R + 0.5);
    }
    for (const a of plan.plots)
      for (const b of plan.plots) if (a !== b) expect(overlap(plotCorners(a, 0.35), plotCorners(b, 0.35)), `${a.id} on ${b.id}`).toBe(false);
  });

  it('is no grid: the plots face many ways, never in rows, yet every front is turned to the eye', () => {
    const deg = plan.plots.map((p) => Math.round((p.site.rot * 180) / Math.PI));
    expect(new Set(deg).size).toBeGreaterThanOrEqual(15);
    // no three neighbouring plots' middles on one line, as a grid's rows and columns put them (half a unit off it at the least)
    const mid = plan.plots.map((p) => onSite(p, p.x0 + PW / 2, p.y0 + PD / 2));
    for (let i = 0; i < mid.length; i++)
      for (let j = i + 1; j < mid.length; j++)
        for (let k = j + 1; k < mid.length; k++) {
          const [a, b, c] = [mid[i]!, mid[j]!, mid[k]!];
          const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
          const longest = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1]));
          // neighbours only: three far-flung plots can fall on a line by chance; a row is three side by side
          if (longest < 24) expect(area / longest, `${plan.plots[i]!.id}, ${plan.plots[j]!.id} and ${plan.plots[k]!.id} in a row`).toBeGreaterThan(0.25);
        }
    // the camera looks from +x, +y: a front (the frame's +y) must lean toward it
    for (const p of plan.plots) expect(-Math.sin(p.site.rot) + Math.cos(p.site.rot), `${p.id} turned away`).toBeGreaterThan(0.25);
  });

  it('lets two streets meet only where the plan names a junction, and bends none too sharply to walk round', () => {
    for (const a of plan.roads)
      for (const b of plan.roads) {
        if (a.id >= b.id) continue;
        for (let i = 0; i < a.pts.length - 1; i++)
          for (let j = 0; j < b.pts.length - 1; j++) {
            const x = crossing(a.pts[i]!, a.pts[i + 1]!, b.pts[j]!, b.pts[j + 1]!);
            if (x) expect(Math.min(...plan.junctions.map((q) => Math.hypot(q[0] - x.at[0], q[1] - x.at[1]))), `${a.id} crosses ${b.id}`).toBeLessThan(1e-6);
          }
      }
    for (const r of plan.roads)
      for (let i = 1; i < r.pts.length - 1; i++) {
        const [a, b, c] = [r.pts[i - 1]!, r.pts[i]!, r.pts[i + 1]!];
        const turn = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));
        const step = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2;
        // the pavement on a bend's inside must not fold over itself
        expect(step / Math.max(turn, 1e-9), `${r.id} bends too sharply at ${b}`).toBeGreaterThan(KERB + 1.2);
      }
  });
});

describe('the walk to the wallet', () => {
  const rooms_ = plan.plots.filter((x) => x.kind === 'room');
  const door = plan.wallet.walk!.at(-1)!;

  it('leaves every room by its own garden and comes in at the wallet door, up the steps', () => {
    expect(door[2]).toBe(VILLA_DECK);
    for (const p of rooms_) {
      const walk = p.walk!;
      expect(walk.length, p.id).toBeGreaterThan(5);
      expect(inPoly(plotCorners(p), [walk[0]![0], walk[0]![1]]), `${p.id} starts off its plot`).toBe(true);
      expect(walk.slice(0, p.garden!.length)).toEqual(p.garden!.map((g) => onSite(p, g[0], g[1])));
      expect(walk.at(-1)).toEqual(door);
    }
  });

  it('keeps to the pavements between garden and door, and walks through nobody else’s plot', () => {
    const tail = plan.wallet.walk!.length;
    for (const p of rooms_) {
      const walk = p.walk!;
      const street = walk.slice(p.garden!.length, walk.length - tail);
      expect(street.length, p.id).toBeGreaterThan(2);
      for (const q of street) {
        const d = roadDistance(plan.roads, [q[0], q[1]]);
        // on the pavement; a mitred corner stands a little further off the two centre lines it turns between
        expect(d, `${p.id} off the pavement at ${q}`).toBeGreaterThan(KERB - 0.05);
        expect(d, `${p.id} off the pavement at ${q}`).toBeLessThan(2 * KERB + 0.05);
      }
      const others = plan.plots.filter((o) => o !== p && o !== plan.wallet).map((o) => plotCorners(o));
      for (let i = 0; i < walk.length - 1; i++) {
        const [a, b] = [walk[i]!, walk[i + 1]!];
        const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2);
        for (let k = 0; k <= n; k++) {
          const q: Pt = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          expect(others.some((o) => inPoly(o, q)), `${p.id} walks through a plot at ${q}`).toBe(false);
        }
      }
    }
  });

  it('paints a crossing wherever a walk goes over a road, and nowhere else', () => {
    const over: { road: string; at: Pt }[] = [];
    for (const p of rooms_) {
      const walk = p.walk!;
      for (let i = 0; i < walk.length - 1; i++)
        for (const r of plan.roads)
          for (let j = 0; j < r.pts.length - 1; j++) {
            const x = crossing([walk[i]![0], walk[i]![1]], [walk[i + 1]![0], walk[i + 1]![1]], r.pts[j]!, r.pts[j + 1]!);
            if (x) over.push({ road: r.id, at: x.at });
          }
    }
    expect(over.length).toBeGreaterThan(0);
    for (const o of over)
      expect(plan.zebras.some((z) => z.road === o.road && Math.hypot(z.x - o.at[0], z.y - o.at[1]) < ZEBRA_SHARE), `no zebra at ${o.road} ${o.at}`).toBe(true);
    for (const z of plan.zebras)
      expect(over.some((o) => o.road === z.road && Math.hypot(z.x - o.at[0], z.y - o.at[1]) < 1e-9), `a zebra nobody crosses on ${z.road}`).toBe(true);
  });
});

describe('a walk', () => {
  const walk = [[0, 0], [3, 0], [3, 4, 1]] as const;
  it('is as long as its legs', () => expect(walkLength(walk)).toBe(7));
  it('puts a walker where their distance says, lifting them on a rising leg', () => {
    expect(walkAt(walk, 0)).toEqual([0, 0, 0]);
    expect(walkAt(walk, 1.5)).toEqual([1.5, 0, 0]);
    expect(walkAt(walk, 5)).toEqual([3, 2, 0.5]);
    expect(walkAt(walk, 7)).toEqual([3, 4, 1]);
  });
  it('says a walker who has gone the whole way has arrived', () => expect(walkAt(walk, 7.01)).toBeNull());
});
