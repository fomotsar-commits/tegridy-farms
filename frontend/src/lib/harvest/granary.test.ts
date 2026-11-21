// Harvest's figure in numbers (lib/harvest/granary.ts): one storey per claim, every storey the same
// size whatever it pays; each room with a claim is one building on one street, its storeys in stacks
// of at most four; a storey comes down only once paid and every claim before it in its stack has an
// answer; a network tops out only once every claim on it was paid, refused or cancelled; every claim
// has one lane to the wallet, every lane one width; the drawing never changes size.
import { describe, it, expect } from 'vitest';
import { iso, solid, type Pt } from '../iso';
import { convexHull } from '../isoBungalow';
import type { ClaimState } from './types';
import {
  AIR, ALLEY, AMBER, BG, CAP, CLOUD_PAD, CLOUD_STEP, CORNICE, D, DOOR_IN, FLAG_H, FLOAT, FLOAT_DONE, FOOT, GHOST_PAINT, GHOST_STATES,
  GREEN, H, LANE_W, LIFT, M, NAME_MAX, NAME_PX, NET_COLOUR, PLATE, REFUSED, RISE, ROOF_AIR, U, UNSURE, W, WT, W_GLASS, W_POD,
  W_POD_OVER, cityBoard, cityPlan, cloudPath, granaryBox, granaryLayout, laneHalf, lanePaint, laneRoute, letteringFor, networksOf,
  roomsOf, stacksOf, storeyMuralFrame, storeyPaint, walletLabel, walletNameSize, type GranaryNetwork, type GranaryStorey,
} from './granary';

type Kind = ClaimState['kind'] | null;

const ROOM = {
  bayla: { chain: 'solana', symbol: 'BAYLA', accent: '#8ef0d8' },
  bobo: { chain: 'solana', symbol: 'BOBO', accent: '#dcae60' },
  pepe: { chain: 'ethereum', symbol: 'PEPE', accent: '#5f9e6e' },
  drb: { chain: 'base', symbol: 'DRB', accent: '#d4b168' },
  jbm: { chain: 'base', symbol: 'JBM', accent: '#ffd078' },
} as const;

/** Storeys in run order, as the card builds them: n is the row number. */
function storeys(rooms: (keyof typeof ROOM)[], states: Kind[] = []): GranaryStorey[] {
  return rooms.map((roomId, i) => ({
    key: `k${i + 1}`, n: i + 1, roomId, ...ROOM[roomId], caution: false, state: states[i] ?? null,
  }));
}

/** Seven claims on three networks: four BAYLA on Solana, PEPE on Ethereum, DRB and JBM on Base. */
const S2 = ['bayla', 'bayla', 'bayla', 'bayla', 'pepe', 'drb', 'jbm'] as (keyof typeof ROOM)[];
const S3: Kind[] = ['claimed', 'claimed', 'claimed', 'sending', 'waiting', 'waiting', 'waiting'];
const S4: Kind[] = ['claimed', 'claimed', 'claimed', 'reverted', 'claimed', 'claimed', 'claimed'];
/** Ten claims in five rooms: seven on Solana (BAYLA's run is broken by BOBO's two), then Ethereum and Base. */
const S8 = ['bayla', 'bayla', 'bayla', 'bayla', 'bobo', 'bobo', 'bayla', 'pepe', 'drb', 'jbm'] as (keyof typeof ROOM)[];

const zs = (rooms: (keyof typeof ROOM)[], states: Kind[] = []) =>
  granaryLayout(networksOf(storeys(rooms, states))).map((t) => t.placed.map((q) => `${q.storey.n}:${q.where}@${q.z.toFixed(2)}`));

/** mulberry32: a small seeded generator, so the property run is the same run every time. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('where everything stands (granaryLayout)', () => {
  it('ready: every storey hung over its footing in run order, each above the last, the roof hung above them all', () => {
    const towers = granaryLayout(networksOf(storeys(S2)));
    // One building a room, along one street: BAYLA, PEPE, then DRB and JBM, both on Base.
    expect(towers.map((t) => t.chain)).toEqual(['solana', 'ethereum', 'base', 'base']);
    expect(towers.map((t) => [t.x, t.y])).toEqual([[0, 0], [4.5, 0], [9, 0], [13, 0]]);
    for (const t of towers) {
      expect(t.placed.every((q) => q.where === 'aloft')).toBe(true);
      const z = t.placed.map((q) => q.z);
      expect(z[0]).toBeCloseTo(FOOT + FLOAT, 9);
      for (let i = 1; i < z.length; i++) expect(z[i]! - z[i - 1]!).toBeCloseTo(H + AIR, 9);
      expect(t.roof.mode).toBe('kit');
      expect(t.roof.base).toBeCloseTo(z[z.length - 1]! + H + ROOF_AIR, 9);
      expect(t.roof.e).toBeCloseTo(t.roof.base + CORNICE, 9);
      expect(t.anyAloft).toBe(true);
    }
  });

  it('the worked numbers: S2 ready, S3 mid-run, S4 done', () => {
    expect(zs(S2)).toEqual([
      ['1:aloft@1.55', '2:aloft@4.30', '3:aloft@7.05', '4:aloft@9.80'], ['5:aloft@1.55'], ['6:aloft@1.55'], ['7:aloft@1.55'],
    ]);
    expect(granaryLayout(networksOf(storeys(S2))).map((t) => t.roof.base.toFixed(2))).toEqual(['12.35', '4.10', '4.10', '4.10']);
    expect(zs(S2, S3)[0]).toEqual(['1:built@0.55', '2:built@2.25', '3:built@3.95', '4:aloft@7.15']);
    expect(granaryLayout(networksOf(storeys(S2, S3)))[0]!.roof.base).toBeCloseTo(9.7, 9);
    const done = granaryLayout(networksOf(storeys(S2, S4)));
    expect(done.map((t) => [t.topped, t.roof.mode, t.roof.base.toFixed(2)])).toEqual([
      [true, 'topped', '5.65'], [true, 'topped', '2.25'], [true, 'topped', '2.25'], [true, 'topped', '2.25'],
    ]);
    expect(zs(S2, S4)[0]).toEqual(['1:built@0.55', '2:built@2.25', '3:built@3.95', '4:ghost@8.65']);
  });

  it('the storey at the wallet, and everything hung above it, rises LIFT; nothing below it moves', () => {
    const ready = granaryLayout(networksOf(storeys(['bayla', 'bayla', 'bayla'])))[0]!;
    const run = granaryLayout(networksOf(storeys(['bayla', 'bayla', 'bayla'], ['claimed', 'sending', 'waiting'])))[0]!;
    const z = (t: typeof run, n: number) => t.placed.find((q) => q.storey.n === n)!;
    expect(z(run, 1).where).toBe('built');
    expect(z(run, 2).lifted && z(run, 3).lifted).toBe(true);
    expect(z(run, 3).z - z(run, 2).z).toBeCloseTo(H + AIR, 9);
    expect(z(run, 2).z).toBeCloseTo(FOOT + H + FLOAT + LIFT, 9);
    expect(ready.placed.some((q) => q.lifted)).toBe(false);
  });

  it('a claim paid comes down only once every claim before it in its own stack has an answer; one paid in the next building lands at once', () => {
    // DRB's building holds rows 1 and 3, JBM's row 2 (a wallet that signs them together answers them together).
    const [drb, jbm] = granaryLayout(networksOf(storeys(['drb', 'jbm', 'drb'], ['sending', 'claimed', 'claimed'])));
    expect(drb!.built).toBe(0);
    expect(drb!.placed.map((q) => `${q.storey.n}:${q.where}`)).toEqual(['1:aloft', '3:aloft']);
    expect(jbm!.placed.map((q) => `${q.storey.n}:${q.where}@${q.z.toFixed(2)}`)).toEqual(['2:built@0.55']);
    // Once the first has its answer, both of DRB's come down, in run order.
    const [after] = granaryLayout(networksOf(storeys(['drb', 'jbm', 'drb'], ['claimed', 'claimed', 'claimed'])));
    expect(after!.placed.map((q) => `${q.storey.n}:${q.where}@${q.z.toFixed(2)}`)).toEqual(['1:built@0.55', '3:built@2.25']);
  });

  it('[claimed, refused, claimed] builds two and hangs the dashed one over the topped-out roof, clear of its flag', () => {
    const t = granaryLayout(networksOf(storeys(['drb', 'drb', 'drb'], ['claimed', 'reverted', 'claimed'])))[0]!;
    expect(t.built).toBe(2);
    expect(t.topped).toBe(true);
    const ghost = t.placed.find((q) => q.where === 'ghost')!;
    expect(ghost.storey.n).toBe(2);
    expect(ghost.z).toBeCloseTo(t.builtTop + FLOAT_DONE, 9);
    expect(ghost.z).toBeGreaterThan(t.roof.e + RISE + FLAG_H);
  });

  it.each([
    [['claimed', 'reverted'], true, 'topped'],
    [['claimed', 'declined'], true, 'topped'],
    [['claimed', 'waiting'], false, 'kit'],
    [['reverted', 'declined'], false, 'ghost'],
    // Not confirmed or not sent is no answer: the roof stays hung, never topped out or dashed over it.
    [['unconfirmed'], false, 'kit'],
    [['not-sent', 'not-sent'], false, 'kit'],
    [['claimed', 'unconfirmed'], false, 'kit'],
    [['claimed', 'not-sent'], false, 'kit'],
    [['claimed', 'sending'], false, 'kit'],
  ] as [Kind[], boolean, string][])('%j: topped %s, roof %s (topped only once every claim was paid, refused or cancelled, and one was paid)', (states, topped, mode) => {
    const t = granaryLayout(networksOf(storeys(states.map(() => 'drb'), states)))[0]!;
    expect(t.topped).toBe(topped);
    expect(t.roof.mode).toBe(mode);
  });
});

describe('the terrace: a room stands in stacks of at most four on one footing', () => {
  it('stacksOf: as few stacks as hold them, each as full as the next, in run order, nothing lost', () => {
    const run = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect([1, 4, 5, 6, 7, 8, 9, 12, 13, 24].map((n) => stacksOf(run(n)).map((s) => s.length).join('+'))).toEqual([
      '1', '4', '3+2', '3+3', '4+3', '4+4', '3+3+3', '4+4+4', '4+3+3+3', '4+4+4+4+4+4',
    ]);
    for (const n of [1, 5, 7, 13, 24]) expect(stacksOf(run(n)).flat()).toEqual(run(n));
  });

  it('twelve in one room: three stacks at x 0, 4 and 8 (y 0) on one footing 11 long, each hung H + AIR apart', () => {
    const towers = granaryLayout(networksOf(storeys(Array(12).fill('bayla'))));
    expect(towers.map((t) => [t.x, t.y, t.net, t.stack, t.last])).toEqual([[0, 0, 0, 0, false], [4, 0, 0, 1, false], [8, 0, 0, 2, true]]);
    expect(towers.map((t) => t.storeys.map((s) => s.n))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]);
    expect(new Set(towers.map((t) => t.lot)).size).toBe(1);
    expect(towers[0]!.lot).toEqual({ x: 0, y: 0, length: 3 * W + 2 * ALLEY, net: 0, chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', first: true });
    for (const t of towers) {
      expect(t.storeys.length).toBeLessThanOrEqual(CAP);
      const z = t.placed.map((q) => q.z);
      expect(z[0]).toBeCloseTo(FOOT + FLOAT, 9);
      for (let i = 1; i < z.length; i++) expect(z[i]! - z[i - 1]!).toBeCloseTo(H + AIR, 9);
    }
  });

  it('a paid storey comes down once every storey before it in its own stack has an answer', () => {
    const towers = granaryLayout(networksOf(storeys(Array(5).fill('drb'), ['sending', 'claimed', 'claimed', 'claimed', 'claimed'])));
    expect(towers.map((t) => t.placed.map((q) => `${q.storey.n}:${q.where}`))).toEqual([['1:aloft', '2:aloft', '3:aloft'], ['4:built', '5:built']]);
  });

  it('a network tops out together: a finished stack keeps its roof hung until the last claim on its network answers', () => {
    const seven = Array<keyof typeof ROOM>(7).fill('bayla');
    const mid = granaryLayout(networksOf(storeys(seven, ['claimed', 'claimed', 'claimed', 'claimed', 'claimed', 'sending', 'waiting'])));
    expect(mid.map((t) => [t.storeys.length, t.built, t.topped, t.roof.mode])).toEqual([[4, 4, false, 'kit'], [3, 1, false, 'kit']]);
    const done = granaryLayout(networksOf(storeys(seven, Array(7).fill('claimed'))));
    expect(done.map((t) => [t.topped, t.roof.mode])).toEqual([[true, 'topped'], [true, 'topped']]);
  });

  it('once its network has every answer, a stack holding no paid storey keeps its roof hung, in dashes', () => {
    const towers = granaryLayout(networksOf(storeys(Array(5).fill('drb'), ['claimed', 'claimed', 'claimed', 'reverted', 'declined'])));
    expect(towers.map((t) => [t.storeys.length, t.topped, t.roof.mode])).toEqual([[3, true, 'topped'], [2, false, 'ghost']]);
  });
});

describe('every storey is the same storey: nothing in the drawing compares two coins', () => {
  it('a storey carries no amount, and two claim sets that differ only in their coins stand exactly alike', () => {
    // Each room renamed for another, one for one: the same rooms hold the same claims, in other coins.
    const coins = storeys(['bayla', 'bayla', 'drb']);
    const swapped = coins.map((s) => ({ ...s, roomId: s.roomId === 'bayla' ? 'pepe' : 'jbm', symbol: s.roomId === 'bayla' ? 'PEPE' : 'JBM', accent: '#123456', caution: true }));
    const at = (list: GranaryStorey[]) => granaryLayout(networksOf(list)).map((t) => t.placed.map((q) => q.z));
    expect(at(swapped)).toEqual(at(coins));
    expect(granaryBox(networksOf(swapped), 'claims')).toEqual(granaryBox(networksOf(coins), 'claims'));
    expect(Object.keys(coins[0]!).some((k) => /amount|raw|value|price/i.test(k))).toBe(false);
  });

  it('a storey drawn on any tower, at any height, has the same faces, moved', () => {
    const shape = (x: number, y: number) => {
      const b = solid(x, y, W, D, H, H, U, 0);
      const [ox, oy] = b.top[0]!;
      return [b.top, b.left, b.right].map((f) => f.map(([px, py]) => `${(px - ox).toFixed(2)},${(py - oy).toFixed(2)}`).join(' ')).join('|');
    };
    const towers = granaryLayout(networksOf(storeys(S2)));
    expect(new Set(towers.map((t) => shape(t.x, t.y))).size).toBe(1);
  });
});

describe('the box (granaryBox): fixed for a claim set, so the drawing never changes size during a run', () => {
  it('the measured boxes: one claim, seven before, during and after a run, 12 and 5 in one room, ten in five rooms, reading and nothing', () => {
    const box = (b: { x: number; y: number; w: number; h: number }) => `${b.x} ${b.y} ${b.w} ${b.h}`;
    // The left edge is YOUR WALLET's at its largest (it ends at -197.2), 7 past the board's padded corner (-190.1).
    expect(box(granaryBox(networksOf(storeys(['bayla'])), 'claims'))).toBe('-198 -121 289 223');
    for (const states of [[], S3, S4]) expect(box(granaryBox(networksOf(storeys(S2, states)), 'claims'))).toBe('-198 -286 514 518');
    expect(box(granaryBox(networksOf(storeys(Array(12).fill('bayla'))), 'claims'))).toBe('-198 -286 427 468');
    expect(box(granaryBox(networksOf(storeys(Array(5).fill('bayla'))), 'claims'))).toBe('-198 -231 358 373');
    expect(box(granaryBox(networksOf(storeys(S8)), 'claims'))).toBe('-198 -231 652 543');
    expect(box(granaryBox([], 'reading'))).toBe('-70 -23 152 95');
    expect(box(granaryBox([], 'nothing'))).toBe('-70 -23 152 95');
  });

  it('property: over random claim sets in random states, the box is the ready box; every stack holds four at most, in run order, none overlapping; a network tops out exactly when every claim on it has an answer, under each stack holding a paid one', () => {
    const rnd = seeded(20261115);
    const kinds: Kind[] = [null, 'waiting', 'sending', 'claimed', 'reverted', 'unconfirmed', 'declined', 'not-sent'];
    const answered = (k: Kind) => k === 'claimed' || k === 'reverted' || k === 'declined';
    const rooms = Object.keys(ROOM) as (keyof typeof ROOM)[];
    for (let trial = 0; trial < 4000; trial++) {
      const list = Array.from({ length: 1 + Math.floor(rnd() * 30) }, () => rooms[Math.floor(rnd() * rooms.length)]!);
      const states = list.map(() => kinds[Math.floor(rnd() * kinds.length)]!);
      const ready = networksOf(storeys(list));
      const now = networksOf(storeys(list, states));
      expect(granaryBox(now, 'claims')).toEqual(granaryBox(ready, 'claims'));
      const towers = granaryLayout(now);
      now.forEach((net, n) => {
        const stacks = towers.filter((t) => t.net === n);
        // The run order kept: room after room, each room's storeys in run order, stack after stack as stacksOf splits them.
        const rooms = roomsOf(net.storeys);
        expect(stacks.flatMap((t) => t.storeys)).toEqual(rooms.flatMap((r) => r.storeys));
        expect(stacks.map((t) => t.storeys.length)).toEqual(rooms.flatMap((r) => stacksOf(r.storeys).map((s) => s.length)));
        const done = net.storeys.every((s) => answered(s.state));
        for (const t of stacks) {
          expect(t.storeys.length).toBeLessThanOrEqual(CAP);
          expect(t.topped).toBe(done && t.storeys.some((s) => s.state === 'claimed'));
          expect(t.roof.mode).toBe(t.topped ? 'topped' : done ? 'ghost' : 'kit');
        }
      });
      // One street: every lot on the building line, each clear of the one before it.
      const lots = [...new Set(towers.map((t) => t.lot))];
      for (const l of lots) expect(l.y).toBe(0);
      for (let i = 1; i < lots.length; i++) expect(lots[i]!.x - M).toBeGreaterThan(lots[i - 1]!.x + lots[i - 1]!.length + M);
      for (const t of towers) {
        const all = [...t.placed].sort((a, b) => a.z - b.z);
        for (let i = 1; i < all.length; i++) expect(all[i]!.z).toBeGreaterThanOrEqual(all[i - 1]!.z + H - 1e-9);
        const solidOnes = all.filter((q) => q.where !== 'ghost');
        for (let i = 1; i < solidOnes.length; i++) expect(solidOnes[i]!.storey.n).toBeGreaterThan(solidOnes[i - 1]!.storey.n);
        // Only a claim paid is ever built; a claim that did not land is never part of the building.
        for (const q of t.placed) {
          if (q.where === 'built') expect(q.storey.state).toBe('claimed');
          if (q.storey.state && GHOST_STATES.has(q.storey.state)) expect(q.where).toBe('ghost');
        }
        if (t.topped) for (const q of t.placed.filter((p) => p.where === 'ghost')) expect(q.z).toBeGreaterThan(t.roof.e + RISE + FLAG_H);
      }
    }
  });
});

describe('the revision cloud (cloudPath)', () => {
  const P = (x: number, y: number, z: number) => iso([x, y, z], U);
  const silhouette: Pt[] = [P(0, 0, H), P(W, 0, H), P(W, D, H), P(0, D, H), P(0, D, 0), P(W, D, 0), P(W, 0, 0)];
  const d = cloudPath(silhouette, CLOUD_PAD, CLOUD_STEP);
  const arcs = [...d.matchAll(/A(-?[\d.]+) (-?[\d.]+) 0 0 (\d) (-?[\d.]+) (-?[\d.]+)/g)];

  it('closes, in at least 8 scallops, each bulging outward (sweep 1 on an outline walked clockwise)', () => {
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(arcs.length).toBeGreaterThanOrEqual(8);
    expect(arcs.length).toBe((d.match(/A/g) ?? []).length);
    expect(arcs.every((a) => a[3] === '1')).toBe(true);
  });

  it('every mark stands outside the storey, clear of it by at least half the pad', () => {
    const hull = convexHull(silhouette);
    const first = /^M(-?[\d.]+) (-?[\d.]+)/.exec(d)!;
    const marks: Pt[] = [[Number(first[1]), Number(first[2])], ...arcs.map((a) => [Number(a[4]), Number(a[5])] as Pt)];
    const toSegment = (p: Pt, a: Pt, b: Pt) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    const inside = (p: Pt) => hull.every((a, i) => {
      const b = hull[(i + 1) % hull.length]!;
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    });
    for (const m of marks) {
      expect(inside(m)).toBe(false);
      expect(Math.min(...hull.map((a, i) => toSegment(m, a, hull[(i + 1) % hull.length]!)))).toBeGreaterThanOrEqual(CLOUD_PAD / 2);
    }
  });
});

describe('networksOf, the mural frame and the paint', () => {
  it('networks in the order each first appears in the run, never a fixed order (a wallet on Base: Solana, Base, Ethereum)', () => {
    expect(networksOf(storeys(['bayla', 'drb', 'pepe', 'bayla', 'jbm'])).map((n) => [n.chain, n.storeys.map((s) => s.n)])).toEqual([
      ['solana', [1, 4]], ['base', [2, 5]], ['ethereum', [3]],
    ]);
  });

  it("a room's picture covers the band under the fascia, at the crop the room chose for its door card", () => {
    for (const natural of [{ w: 2009, h: 2046 }, { w: 931, h: 1248 }, { w: 2048, h: 1356 }, { w: 400, h: 2000 }]) {
      const f = storeyMuralFrame(natural, '50% 33%');
      expect(f.x).toBeLessThanOrEqual(1e-9);
      expect(f.x + f.width).toBeGreaterThanOrEqual(W * U - 1e-9);
      expect(f.y).toBeLessThanOrEqual(8.4 + 1e-9);
      expect(f.y + f.height).toBeGreaterThanOrEqual(32 - 1e-9);
      expect(f.width / f.height).toBeCloseTo(natural.w / natural.h, 9);
    }
    // Object-position read as CSS reads it: 0% puts the picture's top at the band's top.
    expect(storeyMuralFrame({ w: 400, h: 2000 }, '50% 0%').y).toBeCloseTo(8.4, 9);
  });

  it("the figure's paint: one colour per state, and only a claim paid lights its windows", () => {
    expect(storeyPaint('sending', false).edge).toBe(AMBER);
    expect(storeyPaint('claimed', false)).toMatchObject({ plate: GREEN, lit: true, seam: true });
    expect(GHOST_PAINT.reverted.colour).toBe(REFUSED);
    expect(GHOST_PAINT.unconfirmed.colour).toBe(UNSURE);
    expect(GHOST_PAINT.declined.colour).toBe(GHOST_PAINT['not-sent'].colour);
    expect(new Set(Object.values(GHOST_PAINT).map((g) => g.dash)).size).toBe(4);
    // Only claimed lights the windows; pointing at a storey never does.
    for (const k of [null, 'waiting', 'sending'] as Kind[]) for (const hot of [false, true]) expect(storeyPaint(k, hot).lit).toBe(false);
    expect([...GHOST_STATES].sort()).toEqual(['declined', 'not-sent', 'reverted', 'unconfirmed']);
  });

  it('the lettering is cut by how large the figure is drawn: the plaque from one sheet px a unit up, the number tile under it', () => {
    expect(letteringFor(0.99)).toBe('m');
    expect(letteringFor(1)).toBe('l');
    expect(letteringFor(1.9)).toBe('l');
    expect(letteringFor(0.5)).toBe('m');
  });
});

const nets = (rooms: (keyof typeof ROOM)[], states: Kind[] = []): GranaryNetwork[] => networksOf(storeys(rooms, states));
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const lotsOf = (rooms: (keyof typeof ROOM)[]) =>
  [...new Set(granaryLayout(nets(rooms)).map((t) => t.lot))].map((l) => [l.symbol, l.x, l.y, l.length, l.first]);

describe('the city: one building a room along one street, one lane a claim to YOUR WALLET', () => {
  it("roomsOf: a network's storeys by room, rooms in the order of their first storey, storeys in run order", () => {
    const solana = nets(S8)[0]!;
    expect(roomsOf(solana.storeys).map((r) => [r.roomId, r.symbol, r.storeys.map((s) => s.n)])).toEqual([
      ['bayla', 'BAYLA', [1, 2, 3, 4, 7]], ['bobo', 'BOBO', [5, 6]],
    ]);
  });

  it('each room with a claim is one lot on the street: 1.0 apart wall to wall on one network, 1.5 between networks, every y 0', () => {
    expect(lotsOf(S2)).toEqual([['BAYLA', 0, 0, 3, true], ['PEPE', 4.5, 0, 3, true], ['DRB', 9, 0, 3, true], ['JBM', 13, 0, 3, false]]);
    expect(lotsOf(Array(12).fill('bayla'))).toEqual([['BAYLA', 0, 0, 11, true]]);
    expect(granaryLayout(nets(Array(12).fill('bayla'))).map((t) => t.x)).toEqual([0, 4, 8]);
    expect(lotsOf(S8)).toEqual([['BAYLA', 0, 0, 7, true], ['BOBO', 8, 0, 3, false], ['PEPE', 12.5, 0, 3, true], ['DRB', 17, 0, 3, true], ['JBM', 21, 0, 3, false]]);
    // A room's stacks are counted within it: BAYLA's five stand 3 + 2, its last row after BOBO's two.
    const towers = granaryLayout(nets(S8));
    expect(towers.map((t) => [t.lot.symbol, t.stack, t.last, t.storeys.map((s) => s.n)])).toEqual([
      ['BAYLA', 0, false, [1, 2, 3]], ['BAYLA', 1, true, [4, 7]], ['BOBO', 0, true, [5, 6]], ['PEPE', 0, true, [8]], ['DRB', 0, true, [9]], ['JBM', 0, true, [10]],
    ]);
    for (const t of towers) expect(t.storeys.length).toBeLessThanOrEqual(CAP);
  });

  it('topping out stays per network: a room all built keeps its roof hung until the last claim on its network answers', () => {
    const run = (seventh: Kind): Kind[] => ['claimed', 'claimed', 'claimed', 'claimed', 'claimed', 'claimed', seventh];
    const bobo = granaryLayout(nets(S8, run('waiting'))).find((t) => t.lot.roomId === 'bobo')!;
    expect([bobo.built, bobo.storeys.length, bobo.topped, bobo.roof.mode]).toEqual([2, 2, false, 'kit']);
    const solana = granaryLayout(nets(S8, run('claimed'))).filter((t) => t.chain === 'solana');
    expect(solana.map((t) => [t.lot.symbol, t.stack, t.roof.mode])).toEqual([['BAYLA', 0, 'topped'], ['BAYLA', 1, 'topped'], ['BOBO', 0, 'topped']]);
  });

  it('cityPlan, the worked numbers: where each lane leaves its building, where it runs, its door, the plates, the board', () => {
    const plan = (rooms: (keyof typeof ROOM)[]) => cityPlan(granaryLayout(nets(rooms)));
    const one = plan(['bayla']);
    expect([one.wx, one.wy, one.face, one.kerb].map(r3)).toEqual([-3.8, 2.55, -1.2, 5.65]);
    expect(one.lanes.map((l) => [r3(l.x), r3(l.y)])).toEqual([[1.85, 3.85]]);
    expect(one.doors.map((d) => [d.chain, r3(d.lo), r3(d.hi), r3(d.spot[0]), r3(d.spot[1])])).toEqual([['solana', 3.68, 4.02, -1.96, 3.57]]);
    const s2 = plan(S2);
    expect(s2.lanes.map((l) => [l.storey.n, r3(l.x), r3(l.y)])).toEqual([
      [1, 0.95, 2.85], [2, 1.55, 3.1], [3, 2.15, 3.35], [4, 2.75, 3.6], [5, 6.35, 4.1], [6, 10.85, 4.6], [7, 14.85, 4.85],
    ]);
    expect([r3(s2.pitch), r3(s2.laneW), r3(s2.plateT)]).toEqual([0.25, 0.17, 0.12]);
    expect(s2.doors.map((d) => [d.chain, r3(d.lo), r3(d.hi), r3(d.spot[1])])).toEqual([
      ['solana', 2.68, 3.77, 2.945], ['ethereum', 3.93, 4.27, 3.82], ['base', 4.43, 5.02, 4.45],
    ]);
    expect(cityBoard(granaryLayout(nets(S2)), s2).map(([x, y]) => [r3(x), r3(y)])).toEqual([
      [-0.72, -0.72], [16.72, -0.72], [16.72, 5.9], [-4.27, 5.9], [-4.27, 2.08], [-0.72, 2.08],
    ]);
    expect(r3(plan(Array(12).fill('bayla')).laneW)).toBe(0.145);
    // The street's order: each building's lanes together, so a room's rows go where its building stands.
    expect(plan(S8).lanes.map((l) => l.storey.n)).toEqual([1, 2, 3, 4, 7, 5, 6, 8, 9, 10]);
    expect(r3(plan(S8).laneW)).toBe(0.133);
  });

  it("lanePaint: one table by state; a network's colour only on a lane at rest, green only for a claim paid", () => {
    expect(lanePaint(null, false)).toMatchObject({ line: null, lineOpacity: 0.85, core: BG, glow: null, march: false, run: false, short: false });
    expect(lanePaint('waiting', false)).toMatchObject({ line: null, lineOpacity: 0.42, core: BG });
    expect(lanePaint(null, true)).toMatchObject({ line: '#ffffff', lineOpacity: 1 });
    expect(lanePaint('sending', false)).toMatchObject({ line: AMBER, glow: AMBER, core: BG, march: true, run: false, short: false });
    expect(lanePaint('claimed', false)).toMatchObject({ line: GREEN, glow: GREEN, march: false, run: true, short: false });
    for (const k of GHOST_STATES) {
      expect(lanePaint(k, false)).toMatchObject({ line: GHOST_PAINT[k as keyof typeof GHOST_PAINT].colour, dash: GHOST_PAINT[k as keyof typeof GHOST_PAINT].dash, core: null, glow: null, short: true, run: false, march: false });
    }
    // Pointing at a lane whitens it only before it is sent; never a lane at the wallet, paid or dashed.
    for (const k of ['sending', 'claimed', 'reverted'] as Kind[]) expect(lanePaint(k, true).line).toBe(lanePaint(k, false).line);
    const all: Kind[] = [null, 'waiting', 'sending', 'claimed', 'reverted', 'unconfirmed', 'declined', 'not-sent'];
    expect(all.filter((k) => lanePaint(k, false).line === GREEN || lanePaint(k, false).core === lanePaint('claimed', false).core)).toEqual(['claimed']);
    for (const c of Object.values(NET_COLOUR)) expect([GREEN, AMBER, REFUSED, UNSURE, GHOST_PAINT.declined.colour, '#ffffff']).not.toContain(c);
  });

  it('property: over random streets in every state, the lanes rise and never cross, each from its own stack to its network’s door, one width, plates inside the glass; plan and box read no state', () => {
    const rnd = seeded(20261116);
    const kinds: Kind[] = [null, 'waiting', 'sending', 'claimed', 'reverted', 'unconfirmed', 'declined', 'not-sent'];
    const fails = { count: 0, order: 0, cross: 0, zone: 0, root: 0, door: 0, width: 0, plates: 0, plan: 0, box: 0 };
    for (let trial = 0; trial < 1500; trial++) {
      const list: GranaryStorey[] = [];
      for (const chain of (['solana', 'ethereum', 'base'] as const).slice(0, 1 + Math.floor(rnd() * 3))) {
        const mine: { roomId: string; symbol: string }[] = [];
        for (let r = 0, rooms = 1 + Math.floor(rnd() * 3); r < rooms; r++) {
          for (let i = 0, k = 1 + Math.floor(rnd() * (rnd() < 0.15 ? 13 : 4)); i < k; i++) mine.push({ roomId: `${chain}-${r}`, symbol: `R${r}` });
        }
        // A network's rooms interleave in the run.
        for (let i = mine.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [mine[i], mine[j]] = [mine[j]!, mine[i]!];
        }
        for (const m of mine) list.push({ key: `k${list.length + 1}`, n: list.length + 1, chain, ...m, accent: '#8ef0d8', caution: false, state: null });
      }
      const ready = networksOf(list);
      const now = networksOf(list.map((s) => ({ ...s, state: kinds[Math.floor(rnd() * kinds.length)]! })));
      const towers = granaryLayout(now);
      const plan = cityPlan(towers);
      const lanes = plan.lanes;
      if (lanes.length !== list.length || new Set(lanes.map((l) => l.storey.key)).size !== list.length) fails.count++;
      for (let j = 1; j < lanes.length; j++) if (!(lanes[j]!.x > lanes[j - 1]!.x && lanes[j]!.y > lanes[j - 1]!.y)) fails.order++;
      // Each lane: a stub from its footing's front (y = D + M) to its run, then the run back to the wallet.
      for (let a = 0; a < lanes.length; a++) {
        for (let b = a + 1; b < lanes.length; b++) {
          const A = lanes[a]!, B = lanes[b]!;
          if ((B.x <= A.x && A.y <= B.y) || (A.x <= B.x && B.y <= A.y)) fails.cross++;
        }
      }
      for (const l of lanes) {
        if (l.y < plan.wy + DOOR_IN - 1e-9 || l.y > plan.wy + WT - DOOR_IN + 1e-9 || l.y < D + M + 0.3) fails.zone++;
        const own = towers.find((t) => t.storeys.includes(l.storey))!;
        if (!(l.x > own.x && l.x < own.x + W)) fails.root++;
        const door = plan.doors.find((d) => d.chain === l.storey.chain)!;
        if (!(l.y > door.lo && l.y < door.hi)) fails.door++;
      }
      if (plan.laneW > LANE_W + 1e-12 || (lanes.length > 1 && plan.laneW > plan.pitch + 1e-12)) fails.width++;
      plan.doors.forEach((d, i) => {
        const inside = d.spot[0] >= plan.wx && d.spot[0] + PLATE <= plan.face && d.spot[1] >= plan.wy - 1e-9 && d.spot[1] + PLATE <= plan.wy + WT + 1e-9;
        const clear = i === 0 || d.spot[1] >= plan.doors[i - 1]!.spot[1] + PLATE - 1e-9;
        if (!inside || !clear || W_POD + d.count * (plan.plateT + plan.plateAir) > W_GLASS + 1e-9 || plan.plateT <= 0) fails.plates++;
      });
      const shape = (p: typeof plan) => JSON.stringify([p.lanes.map((l) => [l.storey.key, l.x, l.y]), p.doors, p.pitch, p.laneW, p.plateT, p.kerb]);
      if (shape(plan) !== shape(cityPlan(granaryLayout(ready)))) fails.plan++;
      if (JSON.stringify(granaryBox(now, 'claims')) !== JSON.stringify(granaryBox(ready, 'claims'))) fails.box++;
    }
    expect(fails).toEqual({ count: 0, order: 0, cross: 0, zone: 0, root: 0, door: 0, width: 0, plates: 0, plan: 0, box: 0 });
  });
});

describe('a lane that did not land, and YOUR WALLET lettered to be read', () => {
  /** A route's length in the world, leg by leg. */
  const lengthOf = (route: readonly (readonly number[])[]) =>
    route.slice(1).reduce((sum, b, i) => sum + Math.hypot(b[0]! - route[i]![0]!, b[1]! - route[i]![1]!, b[2]! - route[i]![2]!), 0);
  const rooms = Object.keys(ROOM) as (keyof typeof ROOM)[];

  it('property: over random streets a lane runs from its building to its network’s door, and one that did not land is the first half of it, ending on the street short of the wallet’s step', () => {
    const rnd = seeded(20261117);
    const fails = { from: 0, door: 0, prefix: 0, half: 0, street: 0, short: 0 };
    for (let trial = 0; trial < 1500; trial++) {
      const list = Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => rooms[Math.floor(rnd() * rooms.length)]!);
      const plan = cityPlan(granaryLayout(networksOf(storeys(list))));
      for (const l of plan.lanes) {
        const route = laneRoute(plan, l);
        const half = laneHalf(plan, l);
        const end = half[half.length - 1]!;
        if (route[0]!.join() !== [l.x, D + M, 0].join()) fails.from++;
        if (route[route.length - 1]!.join() !== [plan.face, l.y, W_POD].join()) fails.door++;
        if (half.slice(0, -1).some((p, i) => p.join() !== route[i]!.join())) fails.prefix++;
        if (!(Math.abs(lengthOf(half) - lengthOf(route) / 2) < 1e-9)) fails.half++;
        if (end[1] !== l.y || end[2] !== 0) fails.street++;
        if (!(end[0] > plan.face + W_POD_OVER)) fails.short++;
      }
    }
    expect(fails).toEqual({ from: 0, door: 0, prefix: 0, half: 0, street: 0, short: 0 });
  });

  it('YOUR WALLET’s type: its cut’s size until measured; raised to draw NAME_PX on screen down to a drawing at half a sheet px a unit; never past NAME_MAX', () => {
    expect([NAME_PX, NAME_MAX]).toEqual([10, 20]);
    expect([walletNameSize('l', 0), walletNameSize('m', 0)]).toEqual([7.4, 10.4]);
    for (let s = 0.5; s <= 3; s += 0.005) {
      const cut = letteringFor(s);
      const size = walletNameSize(cut, s);
      expect(size * s, `at ${s}`).toBeGreaterThanOrEqual(NAME_PX);
      expect(size, `at ${s}`).toBeLessThanOrEqual(NAME_MAX);
      expect(size, `at ${s}`).toBeGreaterThanOrEqual(cut === 'm' ? 10.4 : 7.4);
    }
    // Drawn smaller still, it stops at its most.
    expect(walletNameSize('m', 0.3)).toBe(NAME_MAX);
  });

  it('YOUR WALLET is centred on its lantern while it fits; at its most it stays inside the box, short of the first building and its cloud, and over its callout', () => {
    const plan = cityPlan(granaryLayout(networksOf(storeys(S2))));
    const small = walletLabel(plan, 7.4);
    expect([r3(small.at[0]), r3(small.at[1])]).toEqual([r3(small.foot[0]), -76.5]);
    // Its reach counts every letter at JetBrains Mono's 0.6 em.
    expect(2 * walletLabel(plan, NAME_MAX).half).toBeGreaterThanOrEqual('YOUR WALLET'.length * 0.6 * NAME_MAX);
    const rnd = seeded(20261118);
    // The first building's near edge (every street starts at x 0), less the cloud round a storey there.
    const firstReach = iso([0, D, 0], U)[0] - CLOUD_PAD;
    const fails = { left: 0, right: 0, top: 0, first: 0, callout: 0 };
    for (let trial = 0; trial < 800; trial++) {
      const nets = networksOf(storeys(Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => rooms[Math.floor(rnd() * rooms.length)]!)));
      const box = granaryBox(nets, 'claims');
      const name = walletLabel(cityPlan(granaryLayout(nets)), NAME_MAX);
      const [x0, x1] = [name.at[0] - name.half, name.at[0] + name.half];
      if (!(x0 >= box.x)) fails.left++;
      if (!(x1 <= box.x + box.w)) fails.right++;
      if (!(name.at[1] - name.rise >= box.y)) fails.top++;
      if (!(x1 < firstReach)) fails.first++;
      if (!(name.foot[0] >= x0 && name.foot[0] <= x1)) fails.callout++;
    }
    expect(fails).toEqual({ left: 0, right: 0, top: 0, first: 0, callout: 0 });
  });
});
