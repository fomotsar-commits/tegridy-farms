// The island's plan: a city's streets on a tropical island, twenty equal plots in four districts.
//
// Pure: a list of rooms in, a plan out. No canvas, no reads. Every plot is the same size on
// purpose, the rule Earn's houses keep (lib/isoBungalow.ts): a busier pool shows as more water
// and more people, never as a bigger building.
//
// The streets are a city's (districts, avenues, crossings, a pier). The buildings are an
// island's, and each plot is one idea (lib/city/pieces.ts).

import type { Pt } from '../iso';
import { hash, TAU } from './kit';

/* The grid. A plot is PW by PD; a road is RW wide; NC avenues' worth of plots by NR streets'. */
export const PW = 7;
export const PD = 6;
export const RW = 2.4;
export const SX = PW + RW;
export const SY = PD + RW;
export const NC = 5;
export const NR = 4;
export const XMAX = NC * SX + RW;
export const YMAX = NR * SY + RW;
/** A plot's near corner, by column and row. */
export const px0 = (c: number): number => c * SX + RW;
export const py0 = (r: number): number => r * SY + RW;
/** The centre line of street `i` (runs along x) and of avenue `k` (runs along y). */
export const Hr = (i: number): number => i * SY + RW / 2;
export const Vr = (k: number): number => k * SX + RW / 2;
/** Where a building stands on its plot, and how much ground it may take. */
export const FX = 0.6;
export const FY = 0.5;
export const FW = 3.2;
export const FD = 2.8;
/** Half a road lane: how far off the centre line a vehicle drives. */
export const LANE = 0.55;

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

interface RoomSlot {
  c: number;
  r: number;
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

/**
 * Who stands where. Rows are districts: Ethereum's old town, Base, Solana's boulevard, and the
 * harbour walk. A room that is not in the registry yet keeps its plot as an open lot, drawn in
 * dashed line, so a new room is one line here and one piece away from having a building.
 */
export const SLOTS: readonly Slot[] = [
  { c: 0, r: 0, room: 'toweli', piece: 'wing', water: '#2bbf6a', shape: 'pond' },
  { c: 1, r: 0, room: 'pepe', piece: 'pads', water: '#a6e83a', shape: 'kidney', lilies: true },
  { c: 2, r: 0, civic: 'loans', piece: 'blade', name: 'NFT loans', tick: 'LOANS', acc: '#b49cff', href: '/nft-finance' },
  { c: 3, r: 0, civic: 'keeper', piece: 'balance', name: 'Price keeper', tick: 'KEEPER', acc: '#9aa6b2' },
  { c: 4, r: 0, civic: 'lot', piece: 'ghost', name: 'Open lot', tick: 'OPEN LOT', acc: '#f5e4b8', shape: 'rect' },

  { c: 0, r: 1, room: 'mfer', piece: 'slouch', water: '#9db3c9', shape: 'lap' },
  { c: 1, r: 1, room: 'bnkr', piece: 'monolith', water: '#3f63ff', shape: 'oct' },
  { c: 2, r: 1, room: 'drb', piece: 'gridshell', water: '#e8b23a', shape: 'round' },
  { c: 3, r: 1, room: 'jbm', piece: 'wave', water: '#ff7a30', shape: 'L' },
  { c: 4, r: 1, room: 'qr', piece: 'lantern', water: '#cfefff', shape: 'pixel' },

  { c: 0, r: 2, room: 'bayla', piece: 'lighthouse', water: '#2fe0c8', shape: 'lagoon' },
  { c: 1, r: 2, civic: 'station', piece: 'canopy', name: 'Central Station', tick: 'VENUE', acc: '#c9b88a', href: '/pools' },
  { c: 2, r: 2, civic: 'treasury', piece: 'hourglass', name: 'Treasury', tick: 'TREASURY', acc: '#e3b341', water: '#ffd76a', shape: 'fountain' },
  { c: 3, r: 2, civic: 'range', piece: 'lifeguard', name: 'Range pools', tick: 'RANGE', acc: '#5ad1e6', water: '#47b5ff', shape: 'lanes', href: '/range-pools' },
  { c: 4, r: 2, room: 'bobo', piece: 'lift', water: '#d08b2c', shape: 'peanut' },

  { c: 0, r: 3, room: 'soy', piece: 'halo', water: '#ff4fc8', shape: 'rect' },
  { c: 1, r: 3, room: 'brainlet', piece: 'stack', water: '#9a63ff', shape: 'blob' },
  { c: 2, r: 3, civic: 'wallet', piece: 'villa', name: 'Your wallet', tick: 'YOUR WALLET', acc: '#8ef0d8' },
  { c: 3, r: 3, room: 'rizz', piece: 'bloom', water: '#ff5a5a', shape: 'hex' },
  { c: 4, r: 3, civic: 'launch', piece: 'slip', name: 'Launch slip', tick: 'LAUNCHER', acc: '#e3b341' },
];
export const DISTRICTS = ['ETHEREUM', 'BASE', 'SOLANA', 'HARBOUR'] as const;

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

export interface Plot {
  /** The room's id, or the civic building's. */
  id: string;
  kind: 'room' | 'civic';
  civic?: CivicId;
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
  /** The plot's near corner, and the building's. */
  x0: number;
  y0: number;
  X: number;
  Y: number;
  /** Where its plaque hangs. */
  cx: number;
  cy: number;
  /** Its place in the painter's order: nearer the eye is drawn later. */
  depth: number;
  /** Its roof, set by the piece as it draws: where the plaque hangs and how far a press reaches. */
  top: number;
  pool?: Pool;
  /** The path from its door to the street, when it has one. */
  garden?: WalkPt[];
  /** The whole walk from its door to the wallet's. */
  walk?: WalkPt[];
}
/** A crossing. 'v' goes over avenue `i` at height `at`; 'h' goes over street `i` at `at`. */
export interface Zebra {
  kind: 'v' | 'h';
  i: number;
  at: number;
}
export interface Plan {
  plots: Plot[];
  byId: Map<string, Plot>;
  wallet: Plot;
  palms: (Palm & { plot?: Plot })[];
  lamps: { x: number; y: number }[];
  zebras: Zebra[];
  /** Rooms in the registry with no plot. A test holds this empty. */
  unplaced: string[];
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

/** Set the island out for the rooms the registry lists. */
export function buildPlan(rooms: readonly Room[]): Plan {
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const plots: Plot[] = [];
  const palms: Plan['palms'] = [];
  const lamps: Plan['lamps'] = [];
  for (const s of SLOTS) {
    const x0 = px0(s.c);
    const y0 = py0(s.r);
    const X = x0 + FX;
    const Y = y0 + FY;
    const room = 'room' in s ? roomById.get(s.room) : undefined;
    // A room the registry does not list yet: its plot waits as an open lot.
    const vacant = 'room' in s && !room;
    const base = { c: s.c, r: s.r, x0, y0, X, Y, cx: X + FW / 2, cy: Y + FD / 2, depth: X + FW / 2 + Y + FD / 2, top: ZP_TOP };
    let plot: Plot;
    if ('room' in s && room) {
      plot = { ...base, id: room.id, kind: 'room', piece: s.piece, name: room.name, tick: room.symbol, chain: room.chain, acc: room.accent, addr: room.address, href: `/${room.id}`, mural: room.id };
      plot.pool = makePool(SHAPES[s.shape]().map(([x, y]): Pt => [x0 + x, y0 + y]), s.water, { lilies: s.lilies });
    } else if ('civic' in s) {
      plot = { ...base, id: s.civic, kind: 'civic', civic: s.civic, piece: s.piece, name: s.name, tick: s.tick, acc: s.acc, href: s.href };
      if (s.shape) plot.pool = makePool(SHAPES[s.shape]().map(([x, y]): Pt => [x0 + x, y0 + y]), s.water ?? '#5ad1e6', { lanes: s.shape === 'lanes', jet: s.shape === 'fountain' });
      if (s.civic === 'range' && plot.pool) {
        plot.cx = plot.pool.cx;
        plot.cy = plot.pool.cy;
      }
    } else {
      plot = { ...base, id: `lot-${s.c}-${s.r}`, kind: 'civic', civic: 'lot', piece: 'ghost', name: 'Open lot', tick: 'OPEN LOT', acc: '#f5e4b8' };
      plot.pool = makePool(SHAPES.rect().map(([x, y]): Pt => [x0 + x, y0 + y]), '#5ad1e6', {});
    }
    plots.push(plot);
    const spots = plot.kind === 'civic' && !vacant ? PALM_SPOTS[plot.civic!] : undefined;
    (spots ?? [[0.5, 5.45], [3.75, 5.6]]).forEach(([x, y], i) => palms.push({ ...mkPalm(x0 + x, y0 + y, i), plot }));
    lamps.push({ x: x0 + 0.18, y: y0 + PD - 0.18 }, { x: x0 + PW - 0.18, y: y0 + 0.18 });
  }
  const byId = new Map(plots.map((p) => [p.id, p]));
  const wallet = byId.get('wallet')!;

  // The way to the wallet's front door: the pavement in front of it, its garden path, its steps.
  const doorX = wallet.x0 + 2.2;
  const frontY = wallet.y0 + PD - 0.16;
  const tail: WalkPt[] = [[doorX, frontY], [doorX, wallet.Y + 3.45], [doorX, wallet.Y + 2.92, VILLA_DECK], [doorX, wallet.Y + 2.12, VILLA_DECK]];
  wallet.garden = [tail[0]!, tail[1]!];
  wallet.walk = tail;
  const zebras: Zebra[] = [];
  const seen = new Set<string>();
  const cross = (kind: Zebra['kind'], i: number, at: number): void => {
    const key = `${kind}${i}@${at.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    zebras.push({ kind, i, at });
  };
  /** Walk along a street's pavement from `xa` to `xb`, crossing every avenue on the way. */
  const along = (pts: WalkPt[], xa: number, xb: number, y: number): void => {
    for (let c = 0; c <= NC; c++) if (Vr(c) > Math.min(xa, xb) && Vr(c) < Math.max(xa, xb)) cross('v', c, y);
    pts.push([xb, y]);
  };
  /** Walk down an avenue's pavement from `ya` to `yb`, crossing every street on the way. */
  const down = (pts: WalkPt[], ya: number, yb: number, x: number): void => {
    for (let h = 0; h <= NR; h++) if (Hr(h) > Math.min(ya, yb) && Hr(h) < Math.max(ya, yb)) cross('h', h, x);
    pts.push([x, yb]);
  };
  for (const p of plots) {
    if (p.kind !== 'room') continue;
    const [ex, ey] = EXITS[p.piece] ?? [1.6, FD + 0.05];
    const kerbY = p.y0 + PD - 0.16;
    const pathX = p.x0 + 1.2;
    const turnY = p.y0 + 3.95;
    p.garden = dedupe([[p.X + ex, p.Y + ey], [p.X + ex, turnY], [pathX, turnY], [pathX, kerbY]]);
    const pts = p.garden.slice();
    if (p.r === wallet.r) along(pts, pathX, doorX, kerbY);
    else {
      const avenueX = p.x0 < wallet.x0 ? wallet.x0 + 0.16 : wallet.x0 + PW - 0.16;
      along(pts, pathX, avenueX, kerbY);
      down(pts, kerbY, frontY, avenueX);
      along(pts, avenueX, doorX, frontY);
    }
    p.walk = dedupe(pts.concat(tail));
  }

  // Palms along the shore, wherever a road does not run.
  const onRoad = (x: number, y: number): boolean =>
    (x > -1.5 && x < XMAX + 4.2 && y > -1.5 && y < YMAX + 4.2) || (Math.abs(x - Vr(PIER_AVENUE)) < 2.2 && y > YMAX);
  for (let i = 0; i < 120; i++) {
    const a = hash(i, 1, 2) * TAU;
    const r = coastR(a) * (0.93 + hash(i, 5, 9) * 0.045);
    const x = ISLAND_CX + r * Math.cos(a);
    const y = ISLAND_CY + r * Math.sin(a);
    if (!onRoad(x, y)) palms.push(mkPalm(x, y, i));
  }
  const placed = new Set(SLOTS.flatMap((s) => ('room' in s ? [s.room] : [])));
  return { plots, byId, wallet, palms, lamps, zebras, unplaced: rooms.filter((r) => !placed.has(r.id)).map((r) => r.id) };
}
/** A plot's roof before its piece has drawn once. */
const ZP_TOP = 2.06;

/* ── The island itself: a rounded shore with a little noise, a pier on the harbour side. ── */
export const ISLAND_CX = XMAX / 2;
export const ISLAND_CY = YMAX / 2;
const ISLAND_A = 34.5;
const ISLAND_B = 28;
/** The avenue that runs out onto the pier. */
export const PIER_AVENUE = 2;
export const PIER_Y0 = 45;
export const PIER_Y1 = 54.5;
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
