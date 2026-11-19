// The city, put together: the island's night render (made in Blender, lib/city/render.ts) laid
// under the live parts, drawn with the same projection so they land where they belong.
//
// NOTHING FLIES, AND NOTHING MOVES WITHOUT A READ (owner, 2026-11-18). A person on a pavement is
// staking pay walking from a pool that a read says is paying the connected wallet, to that
// wallet's front door. With no wallet, or no such read, the streets are empty: the island is a
// still picture with its plaques.
//
// The scene draws; it reads nothing. components/city/CityCanvas.tsx hands it what the page read.

import type { Pt } from '../iso';
import { BG, COS30, GLOW, INK, SPOT, TAU, UNIT, ZP, alpha, createKit, ink, mix, type Cam } from './kit';
import { DISTRICTS, Hr, ISLAND_CX, ISLAND_CY, ISLAND_REACH, PD, PW, VILLA_DECK, px0, py0, walkAt, walkLength, type Plan, type Plot } from './plan';
import { PIECE_TOP, RENDER, RENDER_CENTER } from './render';

/** A room whose pool a read says is paying the connected wallet. */
export interface Paying {
  roomId: string;
}
export interface SceneData {
  paying: readonly Paying[];
  /** A wallet is connected. */
  walletLit: boolean;
}
/** The island's picture, as loaded: the half-size one first, the full one once it is wanted and has come. */
export interface Backdrop {
  img: CanvasImageSource;
  /** Pixels to one world unit in that picture. */
  k: number;
  width: number;
  height: number;
}

interface Walker {
  plot: Plot;
  /** How far along the plot's walk. */
  d: number;
  ph: number;
}
/** How fast people walk, in world units a second, and how often one sets off from a paying pool. */
/** How much of the picture's width its border takes to fade into the night: less than the sea between the shore and the picture's edge (scene.test.ts). */
export const EDGE_FADE = 0.025;
const WALK_SPEED = 1.25;
const WALK_EVERY = 2.4;
const ZOOM_MIN = 0.2;
/** Past the full picture's own sharpness by a little, no further. */
const ZOOM_MAX = (RENDER.full.k * 1.3) / UNIT;

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

export function createScene(opts: { ctx: CanvasRenderingContext2D; plan: Plan; monoFont: string }) {
  const { ctx, plan, monoFont } = opts;
  const cam: Cam = { x: 0, y: 0, z: 1 };
  let W = 0;
  let H = 0;
  let DPR = 1;
  /** The scene's clock, in seconds. It stops when motion is reduced or the sheet is paused. */
  let T = 0;
  let data: SceneData = { paying: [], walletLit: false };
  let backdrop: Backdrop | null = null;
  let selected: Plot | null = null;
  let doorPulse = 0;
  let fly: { from: Cam; to: Cam; t0: number; dur: number } | null = null;
  let dirty = true;
  const walkers: Walker[] = [];
  /** Seconds until each paying room's next person sets off. */
  const nextOut = new Map<string, number>();
  const hits: { plot: Plot; hull: Pt[] }[] = [];

  const kit = createKit({ ctx, cam });
  const { K, P, path, seg, dot, glow, flushGlows } = kit;
  const waterOf = (plot: Plot): string => plot.pool?.water ?? plot.acc;
  const topOf = (plot: Plot): number => PIECE_TOP[plot.piece];

  /** Words painted flat on the road, reading along it, as a district's name is on Earn. */
  function groundText(txt: string, x: number, y: number, size: number, col: string, gap = 0.34): void {
    const k = K();
    const [ox, oy] = P(x, y, 0.02);
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
  function drawBackdrop(): void {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    if (!backdrop) return;
    const s = K() / backdrop.k;
    const [cx, cy] = P(RENDER_CENTER[0], RENDER_CENTER[1], RENDER_CENTER[2]);
    const w = backdrop.width * s;
    const h = backdrop.height * s;
    const x = cx - w / 2;
    const y = cy - h / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(backdrop.img, x, y, w, h);
    // The picture's edge never shows. The sea runs off its sides, so at any zoom it would stop at a
    // straight line; instead its border fades into the night (the render's own sky is the page's).
    // The band is narrower than the sea round the island, so no beach is dimmed.
    const band = EDGE_FADE * w;
    for (const [gx0, gy0, gx1, gy1, rx, ry, rw, rh] of [
      [x, 0, x + band, 0, x, y, band, h],
      [x + w, 0, x + w - band, 0, x + w - band, y, band, h],
      [0, y, 0, y + band, x, y, w, band],
      [0, y + h, 0, y + h - band, x, y + h - band, w, band],
    ] as const) {
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, BG);
      g.addColorStop(0.45, alpha(BG, 0.3));
      g.addColorStop(1, alpha(BG, 0));
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rw, rh);
    }
  }
  function drawSelection(b: Plot): void {
    const { x0: x, y0: y } = b;
    path([P(x - 0.1, y - 0.1, ZP + 0.02), P(x + PW + 0.1, y - 0.1, ZP + 0.02), P(x + PW + 0.1, y + PD + 0.1, ZP + 0.02), P(x - 0.1, y + PD + 0.1, ZP + 0.02)]);
    ctx.strokeStyle = alpha(SPOT, 0.6 + 0.35 * Math.sin(T * 3.3));
    ctx.lineWidth = Math.max(1.5, 0.09 * K());
    ctx.stroke();
  }
  /** A person carrying a basket. The basket holds the wallet's pay, in the colour of the pool it came from; they walk in a little of its light. */
  function person(x: number, y: number, z: number, col: string, ph: number): void {
    // drawn a little over life size, more so when the island is far away, so a line of them still reads
    const k = K() * Math.max(1.3, Math.min(2.3, 17 / K()));
    const [sx, sy] = P(x, y, ZP + z);
    glow([sx, sy - 0.3 * k], 0.9, col, 0.35);
    const body = mix(BG, col, 0.82);
    if (k < 6.5) {
      dot([sx, sy - 0.3 * k], 0.12, body);
      return;
    }
    const bob = Math.sin(ph + T * 9) * 0.02 * k;
    ctx.fillStyle = 'rgba(0,0,0,.4)';
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
  function drawPlaque(b: Plot, sel: boolean): void {
    const [lx, ly] = P(b.cx, b.cy, topOf(b) + 0.45);
    const text = sel && b.name.toUpperCase() !== b.tick ? `${b.tick} · ${b.name.toUpperCase()}` : b.tick;
    ctx.textBaseline = 'middle';
    ctx.font = `700 10px ${monoFont}`;
    const tw = ctx.measureText(text).width + text.length * 0.9;
    const h = 18;
    const w = Math.ceil(tw + 22);
    const x = Math.round(lx - w / 2);
    const y = Math.round(ly - h);
    seg([lx, y + h], [lx, y + h + 6], ink(0.4), 1);
    ctx.fillStyle = sel ? INK : 'rgba(5,8,15,.9)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = sel ? INK : ink(0.42);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = waterOf(b);
    ctx.fillRect(x + 6, y + h / 2 - 3, 6, 6);
    ctx.fillStyle = sel ? BG : INK;
    let at = x + 16;
    for (const ch of text) {
      ctx.fillText(ch, at, y + h / 2 + 0.5);
      at += ctx.measureText(ch).width + 0.9;
    }
  }

  function render(): void {
    if (!W || !H) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    hits.length = 0;
    drawBackdrop();
    if (cam.z > 0.34) DISTRICTS.forEach((name, r) => groundText(name, px0(r === 2 ? 2 : 0) + 0.7, Hr(r + 1) + 0.62, 0.72, ink(0.55)));
    if (selected) drawSelection(selected);
    // people, nearest the eye drawn last
    const people = walkers.flatMap((w) => {
      const at = walkAt(w.plot.walk!, w.d);
      return at ? [{ at, w }] : [];
    });
    people.sort((a, b) => a.at[0] + a.at[1] - (b.at[0] + b.at[1]));
    for (const { at, w } of people) person(at[0], at[1], at[2], waterOf(w.plot), w.ph);
    // the wallet's door lights up as each one walks in
    if (data.walletLit && doorPulse > 0) glow(P(plan.wallet.X + 1.6, plan.wallet.Y + 2.05, VILLA_DECK + 0.5), 1.6, GLOW, 0.5 * doorPulse);
    flushGlows();
    for (const b of plan.plots) {
      const top = topOf(b);
      hits.push({
        plot: b,
        hull: convexHull([
          P(b.x0, b.y0, 0), P(b.x0 + PW, b.y0, 0), P(b.x0 + PW, b.y0 + PD, 0), P(b.x0, b.y0 + PD, 0),
          P(b.X, b.Y, top), P(b.X + 3.2, b.Y, top), P(b.X + 3.2, b.Y + 2.8, top), P(b.X, b.Y + 2.8, top),
        ]),
      });
    }
    // plaques last, the picked one over the rest
    for (const b of plan.plots) if (b !== selected) drawPlaque(b, false);
    if (selected) drawPlaque(selected, true);
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
      for (let d = hashStep(id) * WALK_SPEED * WALK_EVERY; d < total; d += WALK_SPEED * WALK_EVERY) walkers.push({ plot, d, ph: d * 1.7 });
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
    const hx = (RENDER.full.width / RENDER.full.k) * k * 0.5;
    const hy = (RENDER.full.height / RENDER.full.k) * k * 0.5;
    const [cx, cy] = P(RENDER_CENTER[0], RENDER_CENTER[1], RENDER_CENTER[2]);
    // the picture's edge may come in no further than a quarter of the sheet
    if (cx + hx < W * 0.75) cam.x += W * 0.75 - (cx + hx);
    if (cx - hx > W * 0.25) cam.x -= cx - hx - W * 0.25;
    if (cy + hy < H * 0.75) cam.y += H * 0.75 - (cy + hy);
    if (cy - hy > H * 0.25) cam.y -= cy - hy - H * 0.25;
  }
  /** Show the town; on a narrow sheet, the middle of town at a size a thumb can press. */
  function fit(): void {
    fly = null;
    const spanX = 2 * ISLAND_REACH * 0.62 * COS30 * UNIT;
    const spanY = ((2 * ISLAND_REACH * 0.62) / 2 + 9) * UNIT;
    let z = Math.min((W - 16) / spanX, (H - 24) / spanY);
    const narrow = W < 700;
    if (narrow) z = Math.max(z, 0.55);
    const c = narrow ? centerOn(px0(1) + 2.5, py0(2) + 1.5, 1.5, clampZ(z)) : centerOn(ISLAND_CX, ISLAND_CY + 1.0, 2.6, clampZ(z));
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
    const to = centerOn(b.cx, b.cy, topOf(b) * 0.45, clampZ(Math.max(cam.z, W < 700 ? 0.9 : 1.1)));
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
  function setBackdrop(b: Backdrop): void {
    backdrop = b;
    dirty = true;
  }

  return {
    cam, render, advance, setData, setBackdrop, resize, fit, zoomAt, panBy, flyTo, flyStep, hit, select,
    /** Something changed since the last frame was drawn. */
    isDirty: () => dirty,
    markDirty: () => { dirty = true; },
    /** People are on the street: the sheet needs every frame. */
    isLive: () => walkers.length > 0 || nextOut.size > 0 || selected !== null,
    size: () => ({ w: W, h: H }),
    /** Pixels to one world unit at the present zoom: which picture is sharp enough. */
    pixelsPerUnit: () => UNIT * cam.z,
    /** Everyone on the street: which room's pay they carry, and how far along its walk they are. */
    people: (): { roomId: string; d: number }[] => walkers.map((w) => ({ roomId: w.plot.id, d: w.d })),
  };
}
