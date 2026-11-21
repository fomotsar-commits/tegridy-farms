// The island's plan: a harbour town on a tropical island, twenty equal plots along winding streets.
//
// Pure: a list of rooms in, a plan out. No canvas, no reads. Every plot is the same size on
// purpose, the rule Earn's houses keep (lib/isoBungalow.ts): a busier pool shows as more water
// and more people, never as a bigger building.
//
// The town is not a grid (owner, 2026-11-20: "too gridlike ... scatter some things around"). Its
// streets curve: a promenade along the harbour, a boulevard up from the pier to the plaza, lanes
// out to each quarter. Each building stands on a street's far side, turned to face it, so every
// front faces the harbour side of the island and the eye; the gaps between are the island's own
// growth. The buildings are an island's, and each plot is one idea (scripts/city-render/buildings.py).
//
// TWO PLACES PER PLOT. A building is MADE in its frame, the slot it had on the old grid (where its
// close-up was rendered, scripts/city-render/maquette.py), and SET DOWN on its site: turned about
// the frame's middle and moved there. `onSite` carries a frame point to the island.

import type { Pt } from '../iso';
import { hash, TAU } from './kit';

/* The frames. A plot is PW by PD; frames sit SX by SY apart, NC across and NR down. */
export const PW = 7;
export const PD = 6;
export const RW = 2.4;
export const SX = PW + RW;
export const SY = PD + RW;
export const NC = 5;
export const NR = 4;
/** A frame's near corner, by column and row. */
export const px0 = (c: number): number => c * SX + RW;
export const py0 = (r: number): number => r * SY + RW;
/** Where a building stands in its frame, and how much ground it may take. */
export const FX = 0.6;
export const FY = 0.5;
export const FW = 3.2;
export const FD = 2.8;

/* The streets. */
/** A road's asphalt reaches this far either side of its centre line; its pavements PAVE_W further. */
export const ROAD_HALF = RW / 2;
export const PAVE_W = 0.7;
/** How far off a road's centre line people walk: the middle of its pavement. */
export const KERB = ROAD_HALF + PAVE_W / 2;
/** How far in front of a plot its street's centre line runs, at the least. */
export const SETBACK = ROAD_HALF + PAVE_W + 0.3;
/** How near a junction a pavement stops, a centre line's paint stops, and no plot may stand. */
export const JUNCTION_R = 2.3;

export type PieceId =
  | 'wing' | 'pads' | 'blade' | 'balance' | 'ghost'
  | 'slouch' | 'monolith' | 'gridshell' | 'wave' | 'lantern'
  | 'lighthouse' | 'canopy' | 'hourglass' | 'lifeguard' | 'lift'
  | 'halo' | 'stack' | 'villa' | 'bloom' | 'slip';

/** What each piece is called on the sheet. */
export const PIECE_NAME: Record<PieceId, string> = {
  wing: 'The Saddle', pads: 'The Lily Pads', blade: 'The Blade', balance: 'The Balance', ghost: 'The Ghost',
  slouch: 'The Slouch', monolith: 'The Monolith', gridshell: 'The Gridshell', wave: 'The Surf', lantern: 'The Lantern',
  lighthouse: 'The Lighthouse', canopy: 'The Umbrellas', hourglass: 'The Hourglass', lifeguard: 'The Diving Tower', lift: 'The Raising',
  halo: 'The Halo', stack: 'The Wrong Way Up', villa: 'The Villa', bloom: 'The Bloom', slip: 'The Slip',
};

export type PoolShape = 'rect' | 'lap' | 'round' | 'oct' | 'hex' | 'kidney' | 'pond' | 'lagoon' | 'blob' | 'peanut' | 'L' | 'pixel' | 'lanes' | 'fountain';
export type CivicId = 'loans' | 'keeper' | 'lot' | 'station' | 'treasury' | 'range' | 'wallet' | 'launch';

/**
 * Where a plot is set down. On a street: `s` units along it from its first point, on its far side,
 * its front to the street, `back` further off it, turned `turn` degrees more. Or stood on its own:
 * its middle at x, y, turned `deg` degrees.
 */
export type Place = { road: string; s: number; back?: number; turn?: number } | { x: number; y: number; deg: number };

interface RoomSlot {
  c: number;
  r: number;
  at: Place;
  /** The room's id in the island registry (lib/bungalows.ts). */
  room: string;
  piece: PieceId;
  water: string;
  shape: PoolShape;
  lilies?: boolean;
}
interface CivicSlot {
  c: number;
  r: number;
  at: Place;
  civic: CivicId;
  piece: PieceId;
  name: string;
  tick: string;
  acc: string;
  water?: string;
  shape?: PoolShape;
  /** A page of the site this building stands for. */
  href?: string;
}
export type Slot = RoomSlot | CivicSlot;

/* ── The town ── */
/** The island's middle. The shore is drawn round it (`coast`), and the render is framed on it. */
export const ISLAND_CX = 24.7;
export const ISLAND_CY = 18;
/** The pier: it runs out to sea along x = PIER_X, from the end of the pier road. */
export const PIER_X = 20;
export const PIER_Y0 = 45;
export const PIER_Y1 = 54.5;

/** Where the streets meet and end. */
const NODES = {
  pier: [PIER_X, PIER_Y0],
  harbour: [20, 37.8],
  plaza: [24, 18.5],
  farJ: [13.5, 2.5],
  crossEnd: [38.5, 14.5],
} as const satisfies Record<string, Pt>;
type NodeId = keyof typeof NODES;

interface RoadDef {
  id: string;
  /** Its course: named meeting points and the points it bends through between them. */
  via: readonly (NodeId | Pt)[];
  /** It comes back round to its first point. */
  loop?: boolean;
}
/** The streets, each a smooth curve through its points. Two streets meet only at a named point. */
const ROADS: readonly RoadDef[] = [
  { id: 'pier', via: ['harbour', [20, 41.5], 'pier'] },
  { id: 'ring', loop: true, via: ['harbour', [10.5, 37.2], [4, 30], [3.5, 21], [2.5, 13], [7, 5.5], 'farJ', [22, 3], [31, 0.8], [40.5, 2.5], [46.5, 9], [49.5, 17.5], [49, 27.5], [41.5, 34.6], [31, 38.7]] },
  { id: 'boulevard', via: ['harbour', [22, 28.5], 'plaza', [16, 13], [12.5, 7.5], 'farJ'] },
  { id: 'cross', via: ['plaza', [31, 16], 'crossEnd'] },
];

/**
 * Who stands where. A room that is not in the registry yet keeps its plot as an open lot, drawn in
 * dashed line, so a new room is one line here and one piece away from having a building. `c` and
 * `r` name its frame (where it is made); `at` is where it stands.
 */
export const SLOTS: readonly Slot[] = [
  { c: 0, r: 0, at: { road: 'ring', s: 25.5 }, room: 'toweli', piece: 'wing', water: '#2bbf6a', shape: 'pond' },
  { c: 1, r: 0, at: { road: 'ring', s: 36 }, room: 'pepe', piece: 'pads', water: '#a6e83a', shape: 'kidney', lilies: true },
  { c: 2, r: 0, at: { x: 51, y: 4.5, deg: -110 }, civic: 'loans', piece: 'blade', name: 'NFT loans', tick: 'LOANS', acc: '#b49cff', href: '/nft-finance' },
  { c: 3, r: 0, at: { x: 55.5, y: 18, deg: -85 }, civic: 'keeper', piece: 'balance', name: 'Price keeper', tick: 'KEEPER', acc: '#9aa6b2' },
  { c: 4, r: 0, at: { x: -1.5, y: 4.7, deg: -14 }, civic: 'lot', piece: 'ghost', name: 'Open lot', tick: 'OPEN LOT', acc: '#f5e4b8', shape: 'rect' },

  { c: 0, r: 1, at: { road: 'ring', s: 61.5 }, room: 'mfer', piece: 'slouch', water: '#9db3c9', shape: 'lap' },
  { c: 1, r: 1, at: { road: 'ring', s: 71, back: 0.6 }, room: 'bnkr', piece: 'monolith', water: '#3f63ff', shape: 'oct' },
  { c: 2, r: 1, at: { road: 'cross', s: 11.5 }, room: 'drb', piece: 'gridshell', water: '#e8b23a', shape: 'round' },
  { c: 3, r: 1, at: { road: 'ring', s: 80 }, room: 'jbm', piece: 'wave', water: '#ff7a30', shape: 'L' },
  { c: 4, r: 1, at: { road: 'ring', s: 102.5 }, room: 'qr', piece: 'lantern', water: '#cfefff', shape: 'pixel' },

  { c: 0, r: 2, at: { road: 'ring', s: 47.5 }, room: 'bayla', piece: 'lighthouse', water: '#2fe0c8', shape: 'lagoon' },
  { c: 1, r: 2, at: { x: 10.5, y: 21, deg: -54 }, civic: 'station', piece: 'canopy', name: 'Central Station', tick: 'VENUE', acc: '#c9b88a', href: '/pools' },
  { c: 2, r: 2, at: { x: 30, y: 24, deg: -54 }, civic: 'treasury', piece: 'hourglass', name: 'Treasury', tick: 'TREASURY', acc: '#e3b341', water: '#ffd76a', shape: 'fountain' },
  { c: 3, r: 2, at: { x: 45.5, y: 39, deg: -21 }, civic: 'range', piece: 'lifeguard', name: 'Range pools', tick: 'RANGE', acc: '#5ad1e6', water: '#47b5ff', shape: 'lanes', href: '/range-pools' },
  { c: 4, r: 2, at: { road: 'boulevard', s: 26 }, room: 'bobo', piece: 'lift', water: '#d08b2c', shape: 'peanut' },

  { c: 0, r: 3, at: { road: 'boulevard', s: 13 }, room: 'soy', piece: 'halo', water: '#ff4fc8', shape: 'rect' },
  { c: 1, r: 3, at: { road: 'ring', s: 133 }, room: 'brainlet', piece: 'stack', water: '#9a63ff', shape: 'blob' },
  { c: 2, r: 3, at: { road: 'ring', s: 6.5 }, civic: 'wallet', piece: 'villa', name: 'Your wallet', tick: 'YOUR WALLET', acc: '#8ef0d8' },
  { c: 3, r: 3, at: { road: 'ring', s: 119.5 }, room: 'rizz', piece: 'bloom', water: '#ff5a5a', shape: 'hex' },
  { c: 4, r: 3, at: { x: 1, y: 37, deg: -28 }, civic: 'launch', piece: 'slip', name: 'Launch slip', tick: 'LAUNCHER', acc: '#e3b341' },
];
/** Each quarter's name, painted along one of its streets. */
export const DISTRICTS: readonly { name: string; road: string; s: number }[] = [
  { name: 'ETHEREUM', road: 'ring', s: 40 },
  { name: 'BASE', road: 'ring', s: 92 },
  { name: 'SOLANA', road: 'ring', s: 123 },
  { name: 'HARBOUR', road: 'pier', s: 2 },
];
/** The middle of town: where a narrow sheet opens. */
export const TOWN_CENTRE: Pt = [NODES.plaza[0], NODES.plaza[1]];

/** What the plan needs to know about a room: the island registry's own facts, nothing invented. */
export interface Room {
  id: string;
  name: string;
  /** Its coin's ticker. */
  symbol: string;
  chain: string;
  /** Its coin's whole address. */
  address?: string;
  accent: string;
}

/** What a read says of a room's market pool: not read yet, read but with no dollar figure, or its dollars. */
export type PoolRead = { state: 'dry' } | { state: 'still' } | { state: 'level'; usd: number };

export interface Pool {
  pts: Pt[];
  cx: number;
  cy: number;
  rw: number;
  rd: number;
  water: string;
  lanes: boolean;
  jet: boolean;
  lilies: boolean;
  seed: number;
}
export interface Palm {
  x: number;
  y: number;
  h: number;
  lean: number;
  r: number;
  ph: number;
}
/** A point on a walk. The third number lifts it off the ground: steps, a deck. */
export type WalkPt = readonly [number, number, number?];

/** Where a plot stands: its middle on the island, and how far it is turned from its frame (radians). */
export interface Site {
  x: number;
  y: number;
  rot: number;
}
export interface Plot {
  /** The room's id, or the civic building's. */
  id: string;
  kind: 'room' | 'civic';
  civic?: CivicId;
  /** Its frame's column and row. */
  c: number;
  r: number;
  piece: PieceId;
  name: string;
  tick: string;
  chain?: string;
  acc: string;
  addr?: string;
  href?: string;
  /** The room whose picture its walls wear. */
  mural?: string;
  /** IN ITS FRAME: the plot's near corner, and the building's. */
  x0: number;
  y0: number;
  X: number;
  Y: number;
  /** Where it stands on the island. */
  site: Site;
  /** IN ITS FRAME: the middle its plaque hangs over (the builders in scripts/city-render/ stand on it). */
  fx: number;
  fy: number;
  /** ON THE ISLAND: where its plaque hangs. */
  cx: number;
  cy: number;
  /** Its place in the painter's order: nearer the eye is drawn later. */
  depth: number;
  /** Its roof, set by the piece as it draws: where the plaque hangs and how far a press reaches. */
  top: number;
  /** In its frame. */
  pool?: Pool;
  /** In its frame: the path from its door to the front of its plot, when it has one. */
  garden?: WalkPt[];
  /** On the island: the whole walk from its door to the wallet's. */
  walk?: WalkPt[];
}
/** A street, as drawn: its centre line, closely set, and whether each end stops short (a turning circle). */
export interface Road {
  id: string;
  pts: Pt[];
  dead: [boolean, boolean];
}
/** A crossing, painted where a walk goes over a road: its middle, and the road's heading there (radians). */
export interface Zebra {
  road: string;
  x: number;
  y: number;
  a: number;
}
export interface Plan {
  plots: Plot[];
  byId: Map<string, Plot>;
  wallet: Plot;
  roads: Road[];
  /** Where two or more roads meet. */
  junctions: Pt[];
  /** A plot's palms stand in its frame; the rest on the island. */
  palms: (Palm & { plot?: Plot })[];
  /** Each plot's own lamps, in its frame. */
  lamps: { x: number; y: number; plot: Plot }[];
  /** Lamps along the streets, on the island. */
  streetLamps: Pt[];
  zebras: Zebra[];
  /** Rooms in the registry with no plot. A test holds this empty. */
  unplaced: string[];
}

/** A point of a plot's frame, where it stands on the island. */
export function onSite(p: Pick<Plot, 'x0' | 'y0' | 'site'>, fx: number, fy: number): Pt {
  const dx = fx - (p.x0 + PW / 2);
  const dy = fy - (p.y0 + PD / 2);
  const c = Math.cos(p.site.rot);
  const s = Math.sin(p.site.rot);
  return [p.site.x + dx * c - dy * s, p.site.y + dx * s + dy * c];
}
/** A plot's ground on the island: its four corners, `grow` further out. */
export function plotCorners(p: Pick<Plot, 'x0' | 'y0' | 'site'>, grow = 0): Pt[] {
  return [
    onSite(p, p.x0 - grow, p.y0 - grow), onSite(p, p.x0 + PW + grow, p.y0 - grow),
    onSite(p, p.x0 + PW + grow, p.y0 + PD + grow), onSite(p, p.x0 - grow, p.y0 + PD + grow),
  ];
}

const ring = (cx: number, cy: number, rx: number, ry: number, n: number, f: (a: number) => number): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push([cx + rx * f(a) * Math.cos(a), cy + ry * f(a) * Math.sin(a)]);
  }
  return out;
};
const ngon = (cx: number, cy: number, r: number, n: number, rot: number): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    out.push([cx + r * Math.cos(a), cy + r * 1.55 * Math.sin(a)]);
  }
  return out;
};
/** Each pool's outline, in its plot's own coordinates. No two rooms share one. */
const SHAPES: Record<PoolShape, () => Pt[]> = {
  rect: () => [[4.2, 0.85], [6.55, 0.85], [6.55, 5.3], [4.2, 5.3]],
  lap: () => [[4.65, 0.7], [6.2, 0.7], [6.2, 5.45], [4.65, 5.45]],
  round: () => ring(5.38, 3.1, 1.15, 1.15, 40, () => 1),
  oct: () => ngon(5.38, 3.1, 1.15, 8, Math.PI / 8),
  hex: () => ngon(5.38, 3.1, 1.18, 6, 0),
  kidney: () => ring(5.38, 3.1, 1.05, 2.0, 56, (a) => 1 - 0.32 * Math.pow(Math.max(0, Math.cos(a)), 3)),
  pond: () => ring(5.3, 3.1, 1.08, 1.95, 60, (a) => 1 + 0.09 * Math.sin(3 * a + 1) + 0.06 * Math.sin(5 * a + 2)),
  lagoon: () => ring(5.3, 3.0, 1.05, 1.95, 60, (a) => 1 + 0.12 * Math.sin(2 * a + 0.6) + 0.07 * Math.sin(4 * a + 1.9)),
  blob: () => ring(5.35, 3.1, 1.05, 1.9, 60, (a) => 1 + 0.14 * Math.sin(3 * a + 0.3) + 0.05 * Math.cos(6 * a)),
  peanut: () => ring(5.38, 3.1, 1.1, 1.55, 64, (a) => 1 - 0.42 * Math.cos(2 * a)),
  L: () => [[4.2, 0.85], [6.55, 0.85], [6.55, 5.3], [5.45, 5.3], [5.45, 2.7], [4.2, 2.7]],
  pixel: () => [[4.2, 0.85], [5.4, 0.85], [5.4, 1.65], [6.55, 1.65], [6.55, 4.1], [5.8, 4.1], [5.8, 5.3], [4.2, 5.3], [4.2, 3.7], [4.85, 3.7], [4.85, 2.5], [4.2, 2.5]],
  lanes: () => [[0.7, 0.8], [6.0, 0.8], [6.0, 5.3], [0.7, 5.3]],
  fountain: () => ring(5.3, 3.05, 0.95, 0.95, 40, () => 1),
};

function makePool(pts: Pt[], water: string, o: { lanes?: boolean; jet?: boolean; lilies?: boolean }): Pool {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return {
    pts, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rw: x1 - x0, rd: y1 - y0, water,
    lanes: Boolean(o.lanes), jet: Boolean(o.jet), lilies: Boolean(o.lilies), seed: hash(x0 | 0, y0 | 0, 1),
  };
}

/* ── Streets: smooth curves, and the way along them ── */
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
};
/** A heading turned a quarter to the left, in the island's own coordinates. */
const left = (t: Pt): Pt => [-t[1], t[0]];
/** Of a road's two sides, the one facing the eye (the harbour side): the camera looks from +x, +y. */
const eyeward = (t: Pt): Pt => {
  const n = left(t);
  return n[0] + n[1] >= 0 ? n : [-n[0], -n[1]];
};

/** A curve through every point, rounded between them (centripetal Catmull-Rom), set every `step` or closer. */
function smooth(ctrl: readonly Pt[], step = 0.5, loop = false): Pt[] {
  if (ctrl.length < 2) return ctrl.slice();
  const P: Pt[] = loop
    ? [ctrl.at(-1)!, ...ctrl, ctrl[0]!, ctrl[1]!]
    : [sub(ctrl[0]!, sub(ctrl[1]!, ctrl[0]!)), ...ctrl, sub(ctrl.at(-1)!, sub(ctrl.at(-2)!, ctrl.at(-1)!))];
  const out: Pt[] = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1]!, P[i]!, P[i + 1]!, P[i + 2]!];
    const t0 = 0;
    const t1 = t0 + Math.sqrt(len(sub(p1, p0)));
    const t2 = t1 + Math.sqrt(len(sub(p2, p1)));
    const t3 = t2 + Math.sqrt(len(sub(p3, p2)));
    const n = Math.max(2, Math.ceil(len(sub(p2, p1)) / step));
    const lerp = (a: Pt, b: Pt, ta: number, tb: number, t: number): Pt => {
      const u = (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };
    for (let j = 0; j < n; j++) {
      const t = t1 + ((t2 - t1) * j) / n;
      const a1 = lerp(p0, p1, t0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      out.push(j === 0 ? [p1[0], p1[1]] : lerp(b1, b2, t1, t2, t));
    }
  }
  const last = loop ? ctrl[0]! : ctrl.at(-1)!;
  out.push([last[0], last[1]]);
  return out;
}
const nodeAt = (v: NodeId | Pt): Pt => (typeof v === 'string' ? [NODES[v][0], NODES[v][1]] : v);

/** A point `s` along a road, and its heading there. */
export function roadAt(road: Road, s: number): { p: Pt; t: Pt } {
  let left_ = Math.max(0, s);
  for (let i = 0; i < road.pts.length - 1; i++) {
    const a = road.pts[i]!;
    const b = road.pts[i + 1]!;
    const l = len(sub(b, a));
    if (left_ <= l || i === road.pts.length - 2) {
      const u = l ? Math.min(1, left_ / l) : 0;
      return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], t: unit(sub(b, a)) };
    }
    left_ -= l;
  }
  return { p: road.pts[0]!, t: [1, 0] };
}
/** How far a point is from a stretch of road, and the nearest point on it. */
function nearestOn(a: Pt, b: Pt, q: Pt): { d: number; at: Pt; u: number } {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const u = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / l2)) : 0;
  const at: Pt = [a[0] + ab[0] * u, a[1] + ab[1] * u];
  return { d: len(sub(q, at)), at, u };
}
/** How far a point is from the nearest road's centre line. */
export function roadDistance(roads: readonly Road[], q: Pt): number {
  let best = Infinity;
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) best = Math.min(best, nearestOn(r.pts[i]!, r.pts[i + 1]!, q).d);
  return best;
}
/** Where two stretches cross, if they do: the point, and how far along the first. */
export function crossing(a: Pt, b: Pt, c: Pt, d: Pt): { at: Pt; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const ca = sub(c, a);
  const u = (ca[0] * s[1] - ca[1] * s[0]) / den;
  const v = (ca[0] * r[1] - ca[1] * r[0]) / den;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { at: [a[0] + r[0] * u, a[1] + r[1] * u], u };
}

function buildRoads(): { roads: Road[]; junctions: Pt[] } {
  const uses = new Map<string, number>();
  for (const r of ROADS) for (const v of r.via) if (typeof v === 'string') uses.set(v, (uses.get(v) ?? 0) + 1);
  const roads = ROADS.map((r): Road => {
    const ends = [r.via[0]!, r.via.at(-1)!];
    // an end that meets no other road stops in a turning circle; the pier road runs on onto the pier
    const dead = ends.map((v) => !r.loop && typeof v === 'string' && v !== 'pier' && uses.get(v) === 1) as [boolean, boolean];
    return { id: r.id, pts: smooth(r.via.map(nodeAt), 0.5, r.loop), dead };
  });
  const junctions = [...uses].filter(([, n]) => n > 1).map(([id]) => nodeAt(id as NodeId));
  return { roads, junctions };
}

/**
 * The way along the streets from one point to another, by the shortest road: points on the centre
 * lines, the first and last where each point is nearest a road.
 */
function route(roads: readonly Road[], from: Pt, to: Pt): Pt[] {
  const key = (p: Pt): string => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const pts: Pt[] = [];
  const idOf = new Map<string, number>();
  const edges: Map<number, number>[] = [];
  const vertex = (p: Pt): number => {
    const k = key(p);
    let i = idOf.get(k);
    if (i === undefined) {
      i = pts.length;
      idOf.set(k, i);
      pts.push(p);
      edges.push(new Map());
    }
    return i;
  };
  const link = (i: number, j: number): void => {
    if (i === j) return;
    const d = len(sub(pts[i]!, pts[j]!));
    edges[i]!.set(j, d);
    edges[j]!.set(i, d);
  };
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) link(vertex(r.pts[i]!), vertex(r.pts[i + 1]!));
  // each end joins the road nearest it, at its nearest point
  const attach = (q: Pt): number => {
    let best: { d: number; at: Pt; a: Pt; b: Pt } | null = null;
    for (const r of roads)
      for (let i = 0; i < r.pts.length - 1; i++) {
        const n = nearestOn(r.pts[i]!, r.pts[i + 1]!, q);
        if (!best || n.d < best.d) best = { d: n.d, at: n.at, a: r.pts[i]!, b: r.pts[i + 1]! };
      }
    const v = vertex(best!.at);
    link(v, vertex(best!.a));
    link(v, vertex(best!.b));
    return v;
  };
  const s = attach(from);
  const t = attach(to);
  const dist = pts.map(() => Infinity);
  const prev = pts.map(() => -1);
  const done = pts.map(() => false);
  dist[s] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < pts.length; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
    if (u < 0 || u === t) break;
    done[u] = true;
    for (const [v, d] of edges[u]!) if (dist[u]! + d < dist[v]!) {
      dist[v] = dist[u]! + d;
      prev[v] = u;
    }
  }
  const out: Pt[] = [];
  for (let v = t; v >= 0; v = prev[v]!) out.unshift(pts[v]!);
  return out;
}
/** A line set off to one side of itself, `by` to its left (negative: its right), mitred at each bend. */
function offset(line: readonly Pt[], by: number): Pt[] {
  return line.map((p, i) => {
    const tin = i > 0 ? unit(sub(p, line[i - 1]!)) : null;
    const tout = i < line.length - 1 ? unit(sub(line[i + 1]!, p)) : null;
    const nin = tin && left(tin);
    const nout = tout && left(tout);
    if (!nin || !nout) {
      const n = (nin ?? nout)!;
      return [p[0] + n[0] * by, p[1] + n[1] * by];
    }
    const m = unit([nin[0] + nout[0], nin[1] + nout[1]]);
    const k = Math.min(2, 1 / Math.max(0.5, m[0] * nin[0] + m[1] * nin[1]));
    return [p[0] + m[0] * by * k, p[1] + m[1] * by * k];
  });
}

/** How high the wallet's deck stands. */
export const VILLA_DECK = 0.55;
/** Where a room's people leave its building, from its near corner. A plot not listed uses the middle of its front. */
const EXITS: Record<string, Pt> = { lighthouse: [1.35, 2.6], slouch: [1.25, 2.5], lift: [1.6, 2.4], halo: [1.55, 2.7] };
const PALM_SPOTS: Partial<Record<CivicId, Pt[]>> = {
  station: [[6.4, 2.6], [6.2, 4.9]], treasury: [[0.45, 5.4]], range: [], lot: [[0.55, 5.4], [3.7, 0.7]],
  launch: [[4.8, 1.3], [6.1, 2.8], [5.0, 4.7]], loans: [[5.6, 0.7], [6.3, 5.2]], keeper: [[5.6, 1.2], [6.1, 4.6]], wallet: [[4.7, 0.9], [6.3, 4.3], [5.0, 5.1]],
};
const mkPalm = (x: number, y: number, i: number): Palm => ({
  x, y, h: 1.5 + hash(x | 0, y | 0, i) * 0.9, lean: (hash(i, x | 0, 5) - 0.5) * 0.7, r: 0.85 + hash(y | 0, i, 2) * 0.3, ph: hash(i, 3, y | 0) * 6,
});
const dedupe = (pts: WalkPt[]): WalkPt[] =>
  pts.filter((p, i) => {
    const q = pts[i - 1];
    return !q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6 || (p[2] ?? 0) !== (q[2] ?? 0);
  });
const inPoly = (poly: readonly Pt[], x: number, y: number): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/** Where a slot stands: on its street's far side facing it, or where it says. */
function siteOf(at: Place, roads: readonly Road[]): Site {
  if ('x' in at) return { x: at.x, y: at.y, rot: (at.deg * Math.PI) / 180 };
  const road = roads.find((r) => r.id === at.road);
  if (!road) throw new Error(`no road ${at.road}`);
  const { p, t } = roadAt(road, at.s);
  const n = eyeward(t);
  // turned so its front (the frame's +y) faces the street: (-sin, cos) of the turn is the street's eyeward side
  const rot = Math.atan2(-n[0], n[1]) + ((at.turn ?? 0) * Math.PI) / 180;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  // where a street bends toward a plot, its corners near the kerb: it stands back as far as it must to clear it
  const rim: Pt[] = [];
  for (let u = 0; u <= PW; u += 0.5) rim.push([u - PW / 2, -PD / 2], [u - PW / 2, PD / 2]);
  for (let v = 0; v <= PD; v += 0.5) rim.push([-PW / 2, v - PD / 2], [PW / 2, v - PD / 2]);
  for (let back = SETBACK + (at.back ?? 0) + PD / 2; ; back += 0.05) {
    const x = p[0] - n[0] * back;
    const y = p[1] - n[1] * back;
    const near = Math.min(...rim.map(([dx, dy]) => roadDistance([road], [x + dx * c - dy * sn, y + dx * sn + dy * c])));
    if (near >= SETBACK || back > SETBACK + PD / 2 + 4) return { x, y, rot };
  }
}

/** Set the island out for the rooms the registry lists. */
export function buildPlan(rooms: readonly Room[]): Plan {
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const { roads, junctions } = buildRoads();
  const plots: Plot[] = [];
  const palms: Plan['palms'] = [];
  const lamps: Plan['lamps'] = [];
  for (const s of SLOTS) {
    const x0 = px0(s.c);
    const y0 = py0(s.r);
    const X = x0 + FX;
    const Y = y0 + FY;
    const site = siteOf(s.at, roads);
    const room = 'room' in s ? roomById.get(s.room) : undefined;
    // A room the registry does not list yet: its plot waits as an open lot.
    const vacant = 'room' in s && !room;
    const [cx, cy] = onSite({ x0, y0, site }, X + FW / 2, Y + FD / 2);
    const base = { c: s.c, r: s.r, x0, y0, X, Y, site, fx: X + FW / 2, fy: Y + FD / 2, cx, cy, depth: cx + cy, top: ZP_TOP };
    let plot: Plot;
    if ('room' in s && room) {
      plot = { ...base, id: room.id, kind: 'room', piece: s.piece, name: room.name, tick: room.symbol, chain: room.chain, acc: room.accent, addr: room.address, href: `/${room.id}`, mural: room.id };
      plot.pool = makePool(SHAPES[s.shape]().map(([x, y]): Pt => [x0 + x, y0 + y]), s.water, { lilies: s.lilies });
    } else if ('civic' in s) {
      plot = { ...base, id: s.civic, kind: 'civic', civic: s.civic, piece: s.piece, name: s.name, tick: s.tick, acc: s.acc, href: s.href };
      if (s.shape) plot.pool = makePool(SHAPES[s.shape]().map(([x, y]): Pt => [x0 + x, y0 + y]), s.water ?? '#5ad1e6', { lanes: s.shape === 'lanes', jet: s.shape === 'fountain' });
      if (s.civic === 'range' && plot.pool) {
        [plot.fx, plot.fy] = [plot.pool.cx, plot.pool.cy];
        [plot.cx, plot.cy] = onSite(plot, plot.fx, plot.fy);
        plot.depth = plot.cx + plot.cy;
      }
    } else {
      plot = { ...base, id: `lot-${s.c}-${s.r}`, kind: 'civic', civic: 'lot', piece: 'ghost', name: 'Open lot', tick: 'OPEN LOT', acc: '#f5e4b8' };
      plot.pool = makePool(SHAPES.rect().map(([x, y]): Pt => [x0 + x, y0 + y]), '#5ad1e6', {});
    }
    plots.push(plot);
    const spots = plot.kind === 'civic' && !vacant ? PALM_SPOTS[plot.civic!] : undefined;
    (spots ?? [[0.5, 5.45], [3.75, 5.6]]).forEach(([x, y], i) => palms.push({ ...mkPalm(x0 + x, y0 + y, i), plot }));
    lamps.push({ x: x0 + 0.18, y: y0 + PD - 0.18, plot }, { x: x0 + PW - 0.18, y: y0 + 0.18, plot });
  }
  const byId = new Map(plots.map((p) => [p.id, p]));
  const wallet = byId.get('wallet')!;

  // The way in at the wallet: from the front of its plot, up its garden path, up its steps.
  const doorX = wallet.x0 + 2.2;
  const frontY = wallet.y0 + PD - 0.16;
  const tailF: WalkPt[] = [[doorX, frontY], [doorX, wallet.Y + 3.45], [doorX, wallet.Y + 2.92, VILLA_DECK], [doorX, wallet.Y + 2.12, VILLA_DECK]];
  wallet.garden = [tailF[0]!, tailF[1]!];
  const toIsland = (p: Plot, w: WalkPt): WalkPt => {
    const [x, y] = onSite(p, w[0], w[1]);
    return w[2] === undefined ? [x, y] : [x, y, w[2]];
  };
  const tail = tailF.map((w) => toIsland(wallet, w));
  wallet.walk = tail;
  const walletFront: Pt = [tail[0]![0], tail[0]![1]];

  for (const p of plots) {
    if (p.kind !== 'room') continue;
    const [ex, ey] = EXITS[p.piece] ?? [1.6, FD + 0.05];
    const kerbY = p.y0 + PD - 0.16;
    const pathX = p.x0 + 1.2;
    const turnY = p.y0 + 3.95;
    p.garden = dedupe([[p.X + ex, p.Y + ey], [p.X + ex, turnY], [pathX, turnY], [pathX, kerbY]]);
    const out = p.garden.map((w) => toIsland(p, w));
    const front: Pt = [out.at(-1)![0], out.at(-1)![1]];
    // down the street to the wallet, on the pavement of the side the walk set out on
    const way = route(roads, front, walletFront);
    const t0 = unit(sub(way[Math.min(1, way.length - 1)]!, way[0]!));
    const side = Math.sign(left(t0)[0] * (front[0] - way[0]![0]) + left(t0)[1] * (front[1] - way[0]![1])) || 1;
    // through a junction in one straight step, from one pavement to the next, over the road between
    const pave = offset(way, side * KERB).filter((_, i) => i === 0 || i === way.length - 1 || !junctions.some((j) => len(sub(way[i]!, j)) < JUNCTION_R));
    p.walk = dedupe([...out, ...pave.map((q): WalkPt => [q[0], q[1]]), ...tail]);
  }

  // A crossing wherever a walk goes over a road. Walks crossing a road at nearly the same place share one.
  const zebras: Zebra[] = [];
  for (const p of plots) {
    const walk = p.walk;
    if (!walk || p.kind !== 'room') continue;
    for (let i = 0; i < walk.length - 1; i++) {
      const a: Pt = [walk[i]![0], walk[i]![1]];
      const b: Pt = [walk[i + 1]![0], walk[i + 1]![1]];
      for (const r of roads)
        for (let j = 0; j < r.pts.length - 1; j++) {
          const x = crossing(a, b, r.pts[j]!, r.pts[j + 1]!);
          if (!x) continue;
          const t = sub(r.pts[j + 1]!, r.pts[j]!);
          if (zebras.some((z) => z.road === r.id && Math.hypot(z.x - x.at[0], z.y - x.at[1]) < ZEBRA_SHARE)) continue;
          zebras.push({ road: r.id, x: x.at[0], y: x.at[1], a: Math.atan2(t[1], t[0]) });
        }
    }
  }

  // Palms and lamps along the streets, on the side with no plot, never in a junction.
  const plotGround = plots.map((p) => plotCorners(p, 0.35));
  const onPlot = (x: number, y: number): boolean => plotGround.some((g) => inPoly(g, x, y));
  const nearJunction = (q: Pt, r = JUNCTION_R + 0.6): boolean => junctions.some((j) => len(sub(q, j)) < r);
  const streetLamps: Pt[] = [];
  let n = 0;
  for (const road of roads) {
    const total = walkLength(road.pts.map((q): WalkPt => q));
    for (let s = 2.5; s < total - 1.5; s += 4.6) {
      const { p, t } = roadAt(road, s);
      const e = eyeward(t);
      const side = n % 2 ? 1 : -1;
      const lampAt: Pt = [p[0] + e[0] * side * (ROAD_HALF + PAVE_W - 0.15), p[1] + e[1] * side * (ROAD_HALF + PAVE_W - 0.15)];
      if (n % 2 === 0 && !nearJunction(lampAt) && !onPlot(lampAt[0], lampAt[1]) && roadDistance(roads, lampAt) > ROAD_HALF + 0.3) streetLamps.push(lampAt);
      const palmAt: Pt = [p[0] + e[0] * (SETBACK + 0.45), p[1] + e[1] * (SETBACK + 0.45)];
      if (n % 3 === 1 && !nearJunction(palmAt) && !onPlot(palmAt[0], palmAt[1]) && roadDistance(roads, palmAt) > SETBACK) palms.push(mkPalm(palmAt[0], palmAt[1], 200 + n));
      n++;
    }
  }

  // Palms along the shore, wherever a road or a plot does not stand.
  const clear = (x: number, y: number): boolean =>
    roadDistance(roads, [x, y]) > SETBACK + 0.4 && !onPlot(x, y) && !(Math.abs(x - PIER_X) < 2.2 && y > PIER_Y0 - 4);
  for (let i = 0; i < 120; i++) {
    const a = hash(i, 1, 2) * TAU;
    const r = coastR(a) * (0.93 + hash(i, 5, 9) * 0.045);
    const x = ISLAND_CX + r * Math.cos(a);
    const y = ISLAND_CY + r * Math.sin(a);
    if (clear(x, y)) palms.push(mkPalm(x, y, i));
  }
  const placed = new Set(SLOTS.flatMap((s) => ('room' in s ? [s.room] : [])));
  return { plots, byId, wallet, roads, junctions, palms, lamps, streetLamps, zebras, unplaced: rooms.filter((r) => !placed.has(r.id)).map((r) => r.id) };
}
/** A plot's roof before its piece has drawn once. */
const ZP_TOP = 2.06;
/** How near two walks' crossings of one road must be to share a zebra: within its own width. */
export const ZEBRA_SHARE = 1.1;

/* ── The island itself: a rounded shore with a little noise, a pier on the harbour side. ── */
const ISLAND_A = 34.5;
const ISLAND_B = 28;
/** The shore's distance from the island's centre, by bearing. */
export function coastR(a: number): number {
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const round = Math.pow(Math.pow(c / ISLAND_A, 3.2) + Math.pow(s / ISLAND_B, 3.2), -1 / 3.2);
  return round * (1 + 0.035 * Math.sin(3 * a + 1) + 0.022 * Math.sin(7 * a + 2) + 0.013 * Math.sin(11 * a + 0.5));
}
/** The shore, scaled: 1 is the waterline, under 1 is inland, over 1 is out to the reef. */
export function coast(scale: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * TAU;
    const r = coastR(a) * scale;
    out.push([ISLAND_CX + r * Math.cos(a), ISLAND_CY + r * Math.sin(a)]);
  }
  return out;
}
/** How far the island reaches from its centre, for fitting it to a sheet. */
export const ISLAND_REACH = ISLAND_A + ISLAND_B;

/** A closed ring with a wobble, for the contour lines of a hill. */
export function contour(x: number, y: number, r: number, seed: number, i: number): Pt[] {
  return ring(x, y, r, r * 0.9, 40, (a) => 1 + 0.08 * Math.sin(3 * a + seed + i) + 0.05 * Math.sin(5 * a + i * 2));
}
export const HILLS = [
  { x: 33, y: -5.4, r: 3.3, n: 5, seed: 3 },
  { x: 12, y: -5.2, r: 2.5, n: 4, seed: 8 },
  { x: -5.2, y: 9, r: 2.6, n: 4, seed: 5 },
  { x: 54.6, y: 26, r: 2.3, n: 4, seed: 2 },
] as const;

/* ── Walking ── */
/** The length of a walk. */
export function walkLength(pts: readonly WalkPt[]): number {
  let t = 0;
  for (let i = 0; i < pts.length - 1; i++) t += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  return t;
}
/** Where someone is after walking `d` along a walk, or null once they have arrived. */
export function walkAt(pts: readonly WalkPt[], d: number): [number, number, number] | null {
  let left = d;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= len) {
      const t = len ? left / len : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * t];
    }
    left -= len;
  }
  return null;
}
