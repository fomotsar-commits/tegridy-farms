// The city, put together: sea, island, streets, plots, pools, buildings, and the people.
//
// NOTHING FLIES, AND NOTHING MOVES WITHOUT A READ (owner, 2026-11-18). A person on a pavement is
// staking pay walking from a pool that a read says is paying the connected wallet, to that
// wallet's front door. With no wallet, or no such read, the streets are empty: the island is
// then a still drawing. What does move with no read is ornament and says no figure: a palm, a
// lamp's sweep, water's shimmer.
//
// The scene draws; it reads nothing. components/city/CityCanvas.tsx hands it what the page read.

import type { Pt } from '../iso';
import { AQUA, BG, COS30, GLOW, INK, ROAD, SPOT, STONE_D, STONE_L, TAU, UNIT, WOOD, WOOD_D, ZP, alpha, createKit, ink, mix, type Cam, type Mural } from './kit';
import { makePieces } from './pieces';
import {
  DISTRICTS, HILLS, Hr, ISLAND_CX, ISLAND_CY, ISLAND_REACH, NC, NR, PD, PIER_AVENUE, PIER_Y0, PIER_Y1, PW, RW, SX, SY, Vr, XMAX, YMAX,
  coast, contour, levelOf, px0, py0, walkAt, walkLength, type Plan, type Plot, type Pool, type PoolRead,
} from './plan';

/** A room whose pool a read says is paying the connected wallet. */
export interface Paying {
  roomId: string;
}
export interface SceneData {
  /** Each room's pool, as read. A room not listed has not been read. */
  pools: ReadonlyMap<string, PoolRead>;
  paying: readonly Paying[];
  /** A wallet is connected. */
  walletLit: boolean;
}

interface Walker {
  plot: Plot;
  /** How far along the plot's walk. */
  d: number;
  ph: number;
}
/** How fast people walk, in world units a second, and how often one sets off from a paying pool. */
const WALK_SPEED = 1.25;
const WALK_EVERY = 2.4;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 2.8;

const convexHull = (points: Pt[]): Pt[] => {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [];
  const up: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop();
  up.pop();
  return lo.concat(up);
};
const inHull = (poly: readonly Pt[], x: number, y: number): boolean => {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c !== 0) {
      const s = Math.sign(c);
      if (!sign) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
};

export type Scene = ReturnType<typeof createScene>;

export function createScene(opts: { ctx: CanvasRenderingContext2D; plan: Plan; mural: Mural; monoFont: string }) {
  const { ctx, plan, monoFont } = opts;
  const cam: Cam = { x: 0, y: 0, z: 1 };
  let W = 0;
  let H = 0;
  let DPR = 1;
  /** The scene's clock, in seconds. It stops when motion is reduced or the sheet is paused. */
  let T = 0;
  let data: SceneData = { pools: new Map(), paying: [], walletLit: false };
  let selected: Plot | null = null;
  let doorPulse = 0;
  let fly: { from: Cam; to: Cam; t0: number; dur: number } | null = null;
  let dirty = true;
  const walkers: Walker[] = [];
  /** Seconds until each paying room's next person sets off. */
  const nextOut = new Map<string, number>();
  /** How many of each room's people have walked in since the page opened. */
  const walkedIn = new Map<string, number>();
  const hits: { plot: Plot; hull: Pt[] }[] = [];
  const labels: { x: number; y: number; text: string; dot: string; sel: boolean }[] = [];

  const kit = createKit({ ctx, cam, time: () => T, mural: opts.mural });
  const { K, LW, P, path, fillP, face, seg, dot, glow, box, ellipseG, post, thatchCone, stones, palm, flushGlows } = kit;
  const waterOf = (plot: Plot): string => plot.pool?.water ?? AQUA;
  const pieces = makePieces(kit, {
    walletLit: () => data.walletLit,
    doorPulse: () => doorPulse,
    stacks: () => data.paying.flatMap((p) => {
      const plot = plan.byId.get(p.roomId);
      return plot ? [{ col: waterOf(plot), n: Math.min(6, 1 + Math.floor((walkedIn.get(p.roomId) ?? 0) / 3)) }] : [];
    }),
  });

  const COAST = coast(1);
  const LAND = coast(0.95);
  const FOAM = coast(1.03);
  const REEF = coast(1.12);
  const REEF2 = coast(1.26);
  const strokeRing = (pts: readonly Pt[], z: number, col: string, lw: number, dash?: number[], offset = 0): void => {
    path(pts.map((p) => P(p[0], p[1], z)));
    if (dash) {
      ctx.setLineDash(dash);
      ctx.lineDashOffset = offset;
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.stroke();
    if (dash) {
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  };
  /** Words painted flat on the ground, reading along a street, as a district's name is on Earn. */
  function groundText(txt: string, x: number, y: number, size: number, col: string, gap = 0.34): void {
    const k = K();
    const [ox, oy] = P(x, y, 0.01);
    const sc = size / 10;
    ctx.save();
    ctx.transform(COS30 * k * sc, 0.5 * k * sc, -COS30 * k * sc, 0.5 * k * sc, ox, oy);
    ctx.font = `600 10px ${monoFont}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = col;
    let at = 0;
    for (const ch of txt) {
      ctx.fillText(ch, at, 0);
      at += ctx.measureText(ch).width + (gap * 10) / size;
    }
    ctx.restore();
  }

  function drawSea(): void {
    const k = K();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const c = P(ISLAND_CX, ISLAND_CY, 0);
    const g = ctx.createRadialGradient(c[0], c[1], 10 * k, c[0], c[1], 70 * k);
    g.addColorStop(0, 'rgba(17,75,95,.42)');
    g.addColorStop(1, 'rgba(17,75,95,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    strokeRing(REEF2, 0, alpha(AQUA, 0.14), LW(), [0.25 * k, 0.5 * k]);
    strokeRing(REEF, 0, alpha(AQUA, 0.3), LW(), [0.6 * k, 0.4 * k]);
  }
  function drawIsland(): void {
    const k = K();
    fillP(COAST.map((p) => P(p[0], p[1], -0.45)), mix(BG, '#e8c98a', 0.14));
    path(COAST.map((p) => P(p[0], p[1], 0)));
    ctx.fillStyle = mix(BG, '#e8c98a', 0.3);
    ctx.fill();
    ctx.strokeStyle = ink(0.55);
    ctx.lineWidth = LW() * 1.2;
    ctx.stroke();
    strokeRing(FOAM, -0.1, 'rgba(255,255,255,.5)', Math.max(1, 0.07 * k), [0.9 * k, 0.7 * k], -T * 0.5 * k);
    const land = LAND.map((p) => P(p[0], p[1], 0));
    path(land);
    ctx.fillStyle = mix(BG, '#1f8a55', 0.17);
    ctx.fill();
    ctx.strokeStyle = ink(0.2);
    ctx.lineWidth = LW();
    ctx.stroke();
    ctx.save();
    path(land);
    ctx.clip();
    if (cam.z > 0.3) {
      // the sheet's faint ground grid
      ctx.beginPath();
      for (let x = -12; x <= XMAX + 12; x += 2) {
        const a = P(x, -14, 0);
        const b = P(x, YMAX + 14, 0);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      for (let y = -14; y <= YMAX + 14; y += 2) {
        const a = P(-12, y, 0);
        const b = P(XMAX + 12, y, 0);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.strokeStyle = ink(0.05);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const h of HILLS) for (let i = 0; i < h.n; i++) strokeRing(contour(h.x, h.y, h.r * (1 - i / h.n), h.seed, i), 0, ink(0.16 + i * 0.05), LW());
    ctx.restore();
    // roads, each ending in a turning circle, as on Earn
    const road = (pts: Pt[]): void => face(pts.map((p) => P(p[0], p[1], 0.005)), ROAD, 0.14);
    for (let i = 0; i <= NR; i++) {
      road([[-0.8, i * SY], [XMAX + 2.0, i * SY], [XMAX + 2.0, i * SY + RW], [-0.8, i * SY + RW]]);
      ellipseG(XMAX + 2.3, Hr(i), 1.55, 0.005, ROAD, ink(0.3));
    }
    for (let c = 0; c <= NC; c++) {
      const end = c === PIER_AVENUE ? PIER_Y0 : YMAX + 2.0;
      road([[c * SX, -0.8], [c * SX + RW, -0.8], [c * SX + RW, end], [c * SX, end]]);
      if (c !== PIER_AVENUE) ellipseG(Vr(c), YMAX + 2.3, 1.55, 0.005, ROAD, ink(0.3));
    }
    ctx.setLineDash([0.55 * k, 0.55 * k]);
    ctx.strokeStyle = ink(0.42);
    ctx.lineWidth = Math.max(1, 0.06 * k);
    ctx.beginPath();
    for (let i = 0; i <= NR; i++) {
      const a = P(-0.8, Hr(i), 0.01);
      const b = P(XMAX + 2.0, Hr(i), 0.01);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    for (let c = 0; c <= NC; c++) {
      const a = P(Vr(c), -0.8, 0.01);
      const b = P(Vr(c), c === PIER_AVENUE ? PIER_Y1 : YMAX + 2.0, 0.01);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // crossings, wherever a walk to the wallet goes over a road
    if (cam.z >= 0.4) {
      for (const z of plan.zebras) {
        for (let j = 0; j < 5; j++) {
          const o = 0.2 + j * 0.44;
          const bar: Pt[] = z.kind === 'v'
            ? [[z.i * SX + o, z.at - 0.3], [z.i * SX + o + 0.22, z.at - 0.3], [z.i * SX + o + 0.22, z.at + 0.3], [z.i * SX + o, z.at + 0.3]]
            : [[z.at - 0.3, z.i * SY + o], [z.at + 0.3, z.i * SY + o], [z.at + 0.3, z.i * SY + o + 0.22], [z.at - 0.3, z.i * SY + o + 0.22]];
          fillP(bar.map((p) => P(p[0], p[1], 0.012)), ink(0.3));
        }
      }
    }
    // the pier
    const pv = Vr(PIER_AVENUE);
    box(pv - 1.2, PIER_Y0, 2.4, PIER_Y1 - PIER_Y0, 0.14, -0.1, { l: STONE_D, r: STONE_D, t: mix(BG, '#b98a55', 0.42) }, 0.35);
    if (cam.z > 0.4) {
      ctx.beginPath();
      for (let y = PIER_Y0 + 0.5; y < PIER_Y1; y += 0.5) {
        const a = P(pv - 1.2, y, 0.045);
        const b = P(pv + 1.2, y, 0.045);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.strokeStyle = 'rgba(5,8,15,.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (cam.z > 0.34) {
      DISTRICTS.forEach((name, r) => groundText(name, px0(r === 2 ? 2 : 0) + 0.7, Hr(r + 1) + 0.62, 0.72, ink(0.5)));
    }
  }
  function drawPlot(b: Plot): void {
    const { x0: x, y0: y } = b;
    face([P(x, y, 0.01), P(x + PW, y, 0.01), P(x + PW, y + PD, 0.01), P(x, y + PD, 0.01)], mix(BG, INK, 0.055), 0.24);
    fillP([P(x + 0.3, y + 0.3, 0.012), P(x + PW - 0.3, y + 0.3, 0.012), P(x + PW - 0.3, y + PD - 0.3, 0.012), P(x + 0.3, y + PD - 0.3, 0.012)], b.kind === 'civic' ? mix(BG, INK, 0.085) : mix(BG, '#1f8a55', 0.2));
    if (selected === b) {
      path([P(x - 0.1, y - 0.1, 0.02), P(x + PW + 0.1, y - 0.1, 0.02), P(x + PW + 0.1, y + PD + 0.1, 0.02), P(x - 0.1, y + PD + 0.1, 0.02)]);
      ctx.strokeStyle = alpha(SPOT, 0.6 + 0.35 * Math.sin(T * 3.3));
      ctx.lineWidth = Math.max(1.5, 0.09 * K());
      ctx.stroke();
    }
  }
  /** A room's pool as its read stands; a civic basin is still water and states no figure. */
  const readOf = (b: Plot): PoolRead => {
    if (b.kind === 'civic') return b.civic === 'lot' ? { state: 'dry' } : { state: 'still' };
    return data.pools.get(b.id) ?? { state: 'dry' };
  };
  function drawPool(pl: Pool, read: PoolRead): void {
    const k = K();
    const rim = pl.pts.map((p) => P(p[0], p[1], ZP));
    if (read.state === 'dry') {
      // not read: an outline in dashed line, never a guessed level
      ctx.setLineDash([0.35 * k, 0.3 * k]);
      path(rim);
      ctx.strokeStyle = ink(0.55);
      ctx.lineWidth = Math.max(1, 0.06 * k);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    const level = read.state === 'level' ? levelOf(read.usd) : 0.55;
    const wz = ZP - 0.12 - (1 - level) * 0.62;
    ctx.save();
    path(rim);
    ctx.fillStyle = mix(BG, INK, 0.1);
    ctx.fill();
    ctx.clip();
    const wp = pl.pts.map((p) => P(p[0], p[1], wz));
    const [cx, cy] = P(pl.cx, pl.cy, wz);
    const g = ctx.createRadialGradient(cx - 0.5 * k, cy - 0.35 * k, 0.1 * k, cx, cy, Math.max(pl.rw, pl.rd) * 0.9 * k);
    g.addColorStop(0, mix(pl.water, '#ffffff', 0.22));
    g.addColorStop(1, mix(pl.water, BG, 0.42));
    path(wp);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = ink(0.4);
    ctx.lineWidth = LW();
    ctx.stroke();
    ctx.save();
    path(wp);
    ctx.clip();
    if (cam.z > 0.38) {
      // the tank farm's hatch (components/dwg/tankFarm.ts): closer when the dollars were not read
      const gap = read.state === 'still' ? 0.16 : 0.3;
      ctx.beginPath();
      for (let yy = pl.cy - pl.rd / 2 + 0.22; yy < pl.cy + pl.rd / 2; yy += gap) {
        const a = P(pl.cx - pl.rw / 2, yy, wz);
        const b = P(pl.cx + pl.rw / 2, yy, wz);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
      ctx.strokeStyle = read.state === 'still' ? 'rgba(5,8,15,.4)' : 'rgba(5,8,15,.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (read.state === 'level') {
      ctx.lineWidth = Math.max(1, 0.05 * k);
      ctx.strokeStyle = 'rgba(255,255,255,.26)';
      for (let i = 0; i < 3; i++) {
        const yy = pl.cy - pl.rd / 2 + ((i / 3 + T * 0.05 + pl.seed) % 1) * pl.rd;
        ctx.beginPath();
        for (let j = 0; j <= 8; j++) {
          const p = P(pl.cx - pl.rw / 2 + (j / 8) * pl.rw, yy + Math.sin(j * 1.3 + T * 1.6 + i) * 0.06, wz);
          if (j) ctx.lineTo(p[0], p[1]);
          else ctx.moveTo(p[0], p[1]);
        }
        ctx.stroke();
      }
    }
    if (pl.lilies) {
      for (const [dx, dy, r] of [[-0.3, -1.1, 0.28], [0.25, 0.4, 0.22], [-0.2, 1.2, 0.25], [0.35, -0.3, 0.18]] as const) {
        const p = P(pl.cx + dx, pl.cy + dy, wz + 0.01);
        ctx.beginPath();
        ctx.ellipse(p[0], p[1], r * 1.2247 * k, r * 0.7071 * k, 0, 0.35, TAU - 0.1);
        ctx.lineTo(p[0], p[1]);
        ctx.closePath();
        ctx.fillStyle = mix(BG, '#22c55e', 0.5);
        ctx.fill();
        ctx.strokeStyle = ink(0.4);
        ctx.lineWidth = LW();
        ctx.stroke();
      }
    }
    if (pl.lanes) {
      const x0 = pl.cx - pl.rw / 2;
      const x1 = pl.cx + pl.rw / 2;
      const y0 = pl.cy - pl.rd / 2;
      ctx.setLineDash([0.18 * k, 0.14 * k]);
      ctx.lineWidth = Math.max(1, 0.06 * k);
      for (let i = 1; i < 6; i++) {
        const a = P(x0, y0 + (i * pl.rd) / 6, wz + 0.02);
        const b = P(x1, y0 + (i * pl.rd) / 6, wz + 0.02);
        ctx.strokeStyle = i % 2 ? alpha('#f0705a', 0.9) : ink(0.9);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.restore();
    path(rim);
    ctx.lineWidth = Math.max(1.6, 0.17 * k);
    ctx.strokeStyle = STONE_L;
    ctx.stroke();
    path(rim);
    ctx.lineWidth = LW();
    ctx.strokeStyle = ink(0.55);
    ctx.stroke();
    if (read.state === 'level') glow([cx, cy], Math.max(pl.rw, pl.rd) * 0.95, pl.water, 0.24);
  }
  /** Two loungers and a thatched parasol by a room's pool. */
  function patio(b: Plot): void {
    const x = b.x0 + 2.5;
    const y = b.y0 + 4.75;
    for (const dx of [-0.75, 0.55]) box(x + dx, y - 0.1, 0.34, 0.7, 0.1, ZP + 0.06, { l: WOOD, r: WOOD_D, t: mix(BG, waterOf(b), 0.62) }, 0.4);
    post(x, y, ZP, ZP + 0.95, 0.05, ink(0.75));
    thatchCone(x, y, 0.62, ZP + 0.8, 0.32, 2);
  }
  function lamp(l: { x: number; y: number }): void {
    const head = P(l.x, l.y, ZP + 1.3);
    seg(P(l.x, l.y, ZP), head, ink(0.5), Math.max(0.8, 0.04 * K()));
    dot(head, 0.075, GLOW);
    glow(P(l.x, l.y, ZP + 0.9), 1.9, GLOW, 0.2);
  }
  /** A person carrying a basket. The basket holds the wallet's pay, in the colour of the pool it came from. */
  function person(x: number, y: number, z: number, col: string, ph: number): void {
    // drawn a little over life size, more so when the island is far away, so a line of them still reads
    const k = K() * Math.max(1.3, Math.min(2.3, 17 / K()));
    const [sx, sy] = P(x, y, ZP + z);
    const body = mix(BG, col, 0.82);
    if (k < 6.5) {
      dot([sx, sy - 0.3 * k], 0.12, body);
      return;
    }
    const bob = Math.sin(ph + T * 9) * 0.02 * k;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath();
    ctx.ellipse(sx, sy, 0.14 * k, 0.07 * k, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(sx, sy - 0.26 * k + bob, 0.1 * k, 0.19 * k, 0, 0, TAU);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.strokeStyle = ink(0.6);
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy - 0.55 * k + bob, 0.085 * k, 0, TAU);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(sx, sy - 0.68 * k + bob, 0.125 * k, 0.06 * k, 0, 0, TAU);
    ctx.fillStyle = mix(BG, '#d8b56a', 0.85);
    ctx.fill();
    ctx.strokeStyle = 'rgba(5,8,15,.6)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy - 0.73 * k + bob, Math.max(1.2, 0.07 * k), Math.PI, 0);
    ctx.fillStyle = col;
    ctx.fill();
  }
  function drawLabels(): void {
    ctx.textBaseline = 'middle';
    ctx.font = `700 10px ${monoFont}`;
    for (const L of labels) {
      const tw = ctx.measureText(L.text).width + L.text.length * 0.9;
      const h = 18;
      const w = Math.ceil(tw + 22);
      const x = Math.round(L.x - w / 2);
      const y = Math.round(L.y - h);
      seg([L.x, y + h], [L.x, y + h + 6], ink(0.4), 1);
      ctx.fillStyle = L.sel ? INK : 'rgba(5,8,15,.9)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = L.sel ? INK : ink(0.42);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.fillStyle = L.dot;
      ctx.fillRect(x + 6, y + h / 2 - 3, 6, 6);
      ctx.fillStyle = L.sel ? BG : INK;
      let at = x + 16;
      for (const ch of L.text) {
        ctx.fillText(ch, at, y + h / 2 + 0.5);
        at += ctx.measureText(ch).width + 0.9;
      }
    }
  }
  function drawBuilding(b: Plot): void {
    pieces[b.piece](b);
    hits.push({
      plot: b,
      hull: convexHull([
        P(b.x0, b.y0, 0), P(b.x0 + PW, b.y0, 0), P(b.x0 + PW, b.y0 + PD, 0), P(b.x0, b.y0 + PD, 0),
        P(b.X, b.Y, b.top), P(b.X + 3.2, b.Y, b.top), P(b.X + 3.2, b.Y + 2.8, b.top), P(b.X, b.Y + 2.8, b.top),
      ]),
    });
    const p = P(b.cx, b.cy, b.top + 0.5);
    const sel = selected === b;
    labels.push({ x: p[0], y: p[1], text: sel && b.name.toUpperCase() !== b.tick ? `${b.tick} · ${b.name.toUpperCase()}` : b.tick, dot: b.pool?.water ?? b.acc, sel });
  }

  function render(): void {
    if (!W || !H) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    hits.length = 0;
    labels.length = 0;
    drawSea();
    drawIsland();
    for (const b of plan.plots) drawPlot(b);
    for (const b of plan.plots) if (b.garden && (b.kind === 'room' || data.walletLit)) stones(b.garden);
    for (const b of plan.plots) if (b.pool) drawPool(b.pool, readOf(b));
    const things: { depth: number; draw: () => void }[] = [];
    for (const b of plan.plots) {
      things.push({ depth: b.depth, draw: () => drawBuilding(b) });
      if (b.kind === 'room') things.push({ depth: b.x0 + 2.5 + b.y0 + 4.9, draw: () => patio(b) });
    }
    for (const t of plan.palms) things.push({ depth: t.x + t.y, draw: () => palm(t) });
    for (const l of plan.lamps) things.push({ depth: l.x + l.y, draw: () => lamp(l) });
    for (const w of walkers) {
      const at = walkAt(w.plot.walk!, w.d);
      if (at) things.push({ depth: at[0] + at[1], draw: () => person(at[0], at[1], at[2], waterOf(w.plot), w.ph) });
    }
    things.sort((a, b) => a.depth - b.depth);
    for (const t of things) t.draw();
    flushGlows();
    drawLabels();
    dirty = false;
  }

  /* ── people ── */
  function setData(next: SceneData): void {
    const was = new Set(data.paying.map((p) => p.roomId));
    data = next;
    const now = new Set(next.paying.map((p) => p.roomId));
    // a pool that stopped paying: its people leave the street
    for (let i = walkers.length - 1; i >= 0; i--) if (!now.has(walkers[i]!.plot.id)) walkers.splice(i, 1);
    for (const id of [...nextOut.keys()]) if (!now.has(id)) nextOut.delete(id);
    for (const id of now) {
      if (was.has(id)) continue;
      const plot = plan.byId.get(id);
      if (!plot?.walk) continue;
      // a pool that was already paying before the page opened: its people are part-way along
      const total = walkLength(plot.walk);
      let d = hashStep(id) * WALK_SPEED * WALK_EVERY;
      for (; d < total; d += WALK_SPEED * WALK_EVERY) walkers.push({ plot, d, ph: d * 1.7 });
      nextOut.set(id, WALK_EVERY);
    }
    dirty = true;
  }
  /** A steady offset per room, so two pools' people do not walk in step. */
  const hashStep = (id: string): number => {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return h / 997;
  };
  /** Move the clock and everyone on the street on by `dt` seconds. */
  function advance(dt: number): void {
    T += dt;
    doorPulse = Math.max(0, doorPulse - dt * 1.4);
    for (const [id, left] of nextOut) {
      const plot = plan.byId.get(id);
      if (!plot?.walk) continue;
      if (left - dt > 0) nextOut.set(id, left - dt);
      else {
        walkers.push({ plot, d: 0, ph: T * 3 });
        nextOut.set(id, WALK_EVERY);
      }
    }
    for (let i = walkers.length - 1; i >= 0; i--) {
      const w = walkers[i]!;
      w.d += WALK_SPEED * dt;
      if (walkAt(w.plot.walk!, w.d)) continue;
      walkers.splice(i, 1);
      walkedIn.set(w.plot.id, (walkedIn.get(w.plot.id) ?? 0) + 1);
      doorPulse = Math.min(1, doorPulse + 0.4);
    }
    dirty = true;
  }

  /* ── camera ── */
  const clampZ = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const centerOn = (x: number, y: number, z: number, zoom: number): Cam => {
    const k = UNIT * zoom;
    return { x: W / 2 - (x - y) * COS30 * k, y: H / 2 - ((x + y) * 0.5 - z) * k, z: zoom };
  };
  function clampCam(): void {
    const k = UNIT * cam.z;
    const hx = ((XMAX + YMAX + 30) * COS30 * k) / 2;
    const hy = ((XMAX + YMAX + 30) * 0.5 * k) / 2;
    const [cx, cy] = P(ISLAND_CX, ISLAND_CY, 0);
    if (cx < 70 - hx) cam.x += 70 - hx - cx;
    if (cx > W - 70 + hx) cam.x -= cx - (W - 70 + hx);
    if (cy < 70 - hy) cam.y += 70 - hy - cy;
    if (cy > H - 70 + hy) cam.y -= cy - (H - 70 + hy);
  }
  /** Show the whole island; on a narrow sheet, the middle of town at a size a thumb can press. */
  function fit(): void {
    fly = null;
    const spanX = 2 * ISLAND_REACH * 0.76 * COS30 * UNIT;
    const spanY = ((2 * ISLAND_REACH * 0.76) / 2 + 9) * UNIT;
    let z = Math.min((W - 16) / spanX, (H - 24) / spanY);
    const narrow = W < 700;
    if (narrow) z = Math.max(z, 0.5);
    const c = narrow ? centerOn(px0(1) + 2.5, py0(2) + 1.5, 1.5, clampZ(z)) : centerOn(ISLAND_CX, ISLAND_CY + 1.5, 2.6, clampZ(z));
    cam.x = c.x;
    cam.y = c.y;
    cam.z = c.z;
    dirty = true;
  }
  function resize(w: number, h: number, dpr: number): void {
    const first = W === 0;
    const dx = (w - W) / 2;
    const dy = (h - H) / 2;
    W = w;
    H = h;
    DPR = dpr;
    if (first) fit();
    else {
      cam.x += dx;
      cam.y += dy;
      clampCam();
    }
    dirty = true;
  }
  function zoomAt(sx: number, sy: number, zoom: number): void {
    fly = null;
    const nz = clampZ(zoom);
    cam.x = sx - ((sx - cam.x) * nz) / cam.z;
    cam.y = sy - ((sy - cam.y) * nz) / cam.z;
    cam.z = nz;
    clampCam();
    dirty = true;
  }
  function panBy(dx: number, dy: number): void {
    fly = null;
    cam.x += dx;
    cam.y += dy;
    clampCam();
    dirty = true;
  }
  /** Bring a plot to the middle of the sheet. `now` is a clock in milliseconds; `instant` for reduced motion. */
  function flyTo(b: Plot, now: number, instant: boolean): void {
    const to = centerOn(b.cx, b.cy, b.top * 0.5, Math.max(cam.z, W < 700 ? 0.8 : 0.95));
    fly = { from: { ...cam }, to, t0: now, dur: instant ? 1 : 650 };
    dirty = true;
  }
  /** Carry a flight on. True while one is under way. */
  function flyStep(now: number): boolean {
    if (!fly) return false;
    const t = Math.min(1, (now - fly.t0) / fly.dur);
    const e = 1 - Math.pow(1 - t, 3);
    cam.x = fly.from.x + (fly.to.x - fly.from.x) * e;
    cam.y = fly.from.y + (fly.to.y - fly.from.y) * e;
    cam.z = fly.from.z + (fly.to.z - fly.from.z) * e;
    if (t >= 1) fly = null;
    dirty = true;
    return true;
  }
  /** The plot under a point of the sheet, nearest the eye first. */
  function hit(x: number, y: number): Plot | null {
    return hits.slice().sort((a, b) => b.plot.depth - a.plot.depth).find((h) => inHull(h.hull, x, y))?.plot ?? null;
  }
  function select(b: Plot | null): void {
    selected = b;
    dirty = true;
  }

  return {
    cam, render, advance, setData, resize, fit, zoomAt, panBy, flyTo, flyStep, hit, select,
    /** Something changed since the last frame was drawn. */
    isDirty: () => dirty,
    markDirty: () => { dirty = true; },
    /** People are on the street, or a selection is pulsing: the sheet needs every frame. */
    isLive: () => walkers.length > 0 || nextOut.size > 0,
    size: () => ({ w: W, h: H }),
    /** Everyone on the street: which room's pay they carry, and how far along its walk they are. */
    people: (): { roomId: string; d: number }[] => walkers.map((w) => ({ roomId: w.plot.id, d: w.d })),
  };
}
