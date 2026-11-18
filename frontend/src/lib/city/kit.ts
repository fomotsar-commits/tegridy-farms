// The city's drawing kit: an architect's axonometric (lib/iso.ts) drawn on a 2D canvas, in the
// drawing set's ink (styles/dwg.css). Earn draws its houses in SVG; the city has a few hundred
// moving parts in view at once, so it draws on one canvas instead, and on its own page only.
//
// Everything here is a way of putting ink on the sheet. It knows nothing about pools, coins or
// wallets: lib/city/plan.ts sets the island out, lib/city/pieces.ts draws each building, and
// lib/city/scene.ts puts them together.

import type { P3, Pt } from '../iso';

export const COS30 = Math.sqrt(3) / 2;
export const TAU = Math.PI * 2;
/** Pixels to one world unit at zoom 1. */
export const UNIT = 18;
/** The height of a plot's paving above the road. */
export const ZP = 0.06;

/* The drawing set's inks. BG, INK and GREEN are the sheet's own (--dwg-bg, --dwg-ink, --dwg-green). */
export const BG = '#05080f';
export const INK = '#f5e4b8';
export const GREEN = '#22c55e';
export const GLOW = '#ffd98a';
export const HOT = '#fff4cf';
export const GLASS = '#0e1826';
export const SPOT = '#ff6fa3';
export const AQUA = '#5ad1e6';
export const BRASS = '#e3b341';
export const VIOLET = '#b49cff';
export const RED = '#f0705a';
const STRAW = '#d8b56a';
const TIMBER = '#b98a55';

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mixCache = new Map<string, string>();
/** `t` of the way from one hex colour to another. */
export function mix(from: string, to: string, t: number): string {
  const key = from + to + t;
  const hit = mixCache.get(key);
  if (hit) return hit;
  const a = rgbOf(from);
  const b = rgbOf(to);
  const out = `#${a.map((c, i) => Math.round(c + (b[i]! - c) * t).toString(16).padStart(2, '0')).join('')}`;
  mixCache.set(key, out);
  return out;
}
/** A hex colour at an opacity. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** The sheet's cream ink at an opacity. */
export const ink = (a: number): string => `rgba(245,228,184,${a})`;
/** A repeatable number in [0, 1) from three integers: which windows are lit, where a palm leans. */
export function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a + 11, 374761393) ^ Math.imul(b + 7, 668265263) ^ Math.imul(c + 3, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const STONE = mix(BG, INK, 0.24);
export const STONE_D = mix(BG, INK, 0.15);
export const STONE_L = mix(BG, INK, 0.42);
export const SLATE = mix(BG, INK, 0.2);
export const SLATE_E = mix(BG, INK, 0.12);
export const ROAD = mix(BG, INK, 0.075);
export const THATCH = mix(BG, STRAW, 0.38);
export const THATCH_E = mix(BG, STRAW, 0.23);
export const WOOD = mix(BG, TIMBER, 0.44);
export const WOOD_D = mix(BG, TIMBER, 0.27);
export const WOOD_L = mix(BG, TIMBER, 0.62);
export const BAMBOO = mix(BG, '#d6d48a', 0.72);
export const SOFFIT = mix(BG, GLOW, 0.26);
/** A wall in a room's colour, lit side and shaded side: Earn's brick, at the same strengths. */
export const wallL = (acc: string): string => mix(BG, acc, 0.42);
export const wallR = (acc: string): string => mix(BG, acc, 0.26);

/** Where the sheet sits under the eye: an offset in pixels and a zoom. */
export interface Cam {
  x: number;
  y: number;
  z: number;
}
/** One upright wall, as a frame to draw on: `u` runs along it, `v` up it. */
export interface Wall {
  o: P3;
  a: Pt;
  h: number;
  len: number;
}
export interface BoxFaces {
  /** The wall toward the lower left. */
  L: Wall;
  /** The wall toward the lower right, read from the front corner back. */
  R: Wall;
}
interface BoxInk {
  l: string;
  r: string;
  t: string;
}
/** A roofing material: lit and shaded fills, the colour of its courses, and how they run. */
export interface Roofing {
  a: string;
  b: string;
  line: string;
  n?: number;
  ribs?: boolean;
  fringe?: boolean;
}
export const SLATES: Roofing = { a: SLATE, b: SLATE_E, line: 'rgba(255,255,255,.085)', n: 6 };
export const THATCHED: Roofing = { a: THATCH, b: THATCH_E, line: 'rgba(5,8,15,.3)', n: 5, fringe: true };
export const TIN: Roofing = { a: mix(BG, '#a9c0cf', 0.3), b: mix(BG, '#a9c0cf', 0.17), line: 'rgba(5,8,15,.3)', ribs: true };
/** A thin shell cast in a room's colour. */
export const shellOf = (acc: string): Roofing => ({ a: mix(BG, acc, 0.62), b: mix(BG, acc, 0.3), line: 'rgba(5,8,15,.28)' });

interface Glow {
  x: number;
  y: number;
  r: number;
  col: string;
  a: number;
}
/** A lighthouse's beam, swept round by the scene's clock. */
export interface Beam {
  cx: number;
  cy: number;
  z: number;
}
/** A picture ready to be laid on a wall. `null` until it has loaded, or if it never does. */
export type Mural = (id: string) => HTMLImageElement | null;

export interface KitEnv {
  ctx: CanvasRenderingContext2D;
  cam: Cam;
  /** Seconds on the scene's clock. Held still when motion is reduced or the sheet is paused. */
  time: () => number;
  mural: Mural;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** A point of a four-cornered shell, `u` and `v` each from 0 to 1. */
export function bil(C: readonly [P3, P3, P3, P3], u: number, v: number): P3 {
  const at = (i: 0 | 1 | 2): number =>
    C[0][i] * (1 - u) * (1 - v) + C[1][i] * u * (1 - v) + C[2][i] * u * v + C[3][i] * (1 - u) * v;
  return [at(0), at(1), at(2)];
}

export type Kit = ReturnType<typeof createKit>;

export function createKit({ ctx, cam, time, mural }: KitEnv) {
  const glows: Glow[] = [];
  const beams: Beam[] = [];

  /** Pixels to one world unit, at the present zoom. */
  const K = (): number => UNIT * cam.z;
  /** A hairline that thins as the sheet is held further away. */
  const LW = (): number => (cam.z > 0.75 ? 1 : cam.z > 0.42 ? 0.8 : 0.6);
  /** A point of the world on the sheet: lib/iso.ts, moved and scaled by the camera. */
  function P(x: number, y: number, z = 0): Pt {
    const k = UNIT * cam.z;
    return [(x - y) * COS30 * k + cam.x, ((x + y) * 0.5 - z) * k + cam.y];
  }
  const P3of = (p: P3): Pt => P(p[0], p[1], p[2]);

  function path(pts: readonly Pt[]): void {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
  }
  function fillP(pts: readonly Pt[], fill: string): void {
    path(pts);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  /** A filled face with the sheet's ink round it. `edge` 0 leaves it unlined. */
  function face(pts: readonly Pt[], fill: string | CanvasGradient, edge = 0.5): void {
    path(pts);
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge) {
      ctx.strokeStyle = ink(edge);
      ctx.lineWidth = LW();
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }
  function seg(a: Pt, b: Pt, col: string, w: number): void {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.stroke();
  }
  /** An open line through world points. */
  function line(pts: readonly P3[], col: string, w: number): void {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = P3of(p);
      if (i) ctx.lineTo(s[0], s[1]);
      else ctx.moveTo(s[0], s[1]);
    });
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.stroke();
  }
  function dot(p: Pt, rU: number, col: string): void {
    ctx.beginPath();
    ctx.arc(p[0], p[1], Math.max(1.3, rU * K()), 0, TAU);
    ctx.fillStyle = col;
    ctx.fill();
  }
  /** Lamplight, laid over everything once the frame's solids are down (`flushGlows`). */
  function glow(p: Pt, rU: number, col: string, a: number): void {
    glows.push({ x: p[0], y: p[1], r: rU * K(), col, a });
  }

  /* walls */
  const fp = (f: Wall, u: number, v: number): Pt => P(f.o[0] + f.a[0] * u, f.o[1] + f.a[1] * u, f.o[2] + f.h * v);
  const fq = (f: Wall, u0: number, v0: number, u1: number, v1: number): Pt[] => [fp(f, u0, v0), fp(f, u1, v0), fp(f, u1, v1), fp(f, u0, v1)];
  function quad(f: Wall, u0: number, v0: number, u1: number, v1: number, fill: string, edge = 0): void {
    face(fq(f, u0, v0, u1, v1), fill, edge);
  }
  function outline(f: Wall, a = 0.5): void {
    path(fq(f, 0, 0, 1, 1));
    ctx.strokeStyle = ink(a);
    ctx.lineWidth = LW();
    ctx.stroke();
  }
  /** A block: its left wall, its right wall, its top. Returns the two walls as frames to draw on. */
  function box(x: number, y: number, w: number, d: number, h: number, z0: number, c: BoxInk, edge = 0.5): BoxFaces {
    const z1 = z0 + h;
    face([P(x, y + d, z0), P(x + w, y + d, z0), P(x + w, y + d, z1), P(x, y + d, z1)], c.l, edge);
    face([P(x + w, y, z0), P(x + w, y + d, z0), P(x + w, y + d, z1), P(x + w, y, z1)], c.r, edge);
    face([P(x, y, z1), P(x + w, y, z1), P(x + w, y + d, z1), P(x, y + d, z1)], c.t, edge);
    return {
      L: { o: [x, y + d + 0.004, z0], a: [w, 0], h, len: w },
      R: { o: [x + w + 0.004, y + d, z0], a: [0, -d], h, len: d },
    };
  }
  const stoneBox = (x: number, y: number, w: number, d: number, h: number, z0: number, edge?: number): BoxFaces =>
    box(x, y, w, d, h, z0, { l: STONE, r: STONE_D, t: STONE_L }, edge);
  /** Boards on a wall: laid flat, or stood on end. */
  function boards(f: Wall, upright = false): void {
    if (cam.z < 0.34) return;
    ctx.beginPath();
    if (upright) {
      const m = Math.max(1, Math.round(f.len / 0.24));
      for (let i = 1; i < m; i++) {
        const a = fp(f, i / m, 0);
        const b = fp(f, i / m, 1);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
    } else {
      const n = Math.max(1, Math.round(f.h / 0.2));
      for (let j = 1; j < n; j++) {
        const a = fp(f, 0, j / n);
        const b = fp(f, 1, j / n);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
    }
    ctx.strokeStyle = 'rgba(5,8,15,.38)';
    ctx.lineWidth = LW();
    ctx.stroke();
  }
  /**
   * A room's own picture on one wall: the slice from `s0` to `s1` of its width, sheared onto the
   * wall and never squeezed, then dimmed. Earn's houses wear the same picture the same way
   * (components/farm/IsoBungalow.tsx): one picture wrapped round the two near walls.
   */
  function muralOn(f: Wall, id: string, s0: number, s1: number, dim: number): void {
    const img = mural(id);
    if (!img) return;
    const TL = fp(f, 0, 1);
    const TR = fp(f, 1, 1);
    const BL = fp(f, 0, 0);
    const BR = fp(f, 1, 0);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const sw = (s1 - s0) * iw;
    let sh = sw * (f.h / f.len);
    let sy = 0;
    if (sh > ih) sh = ih;
    else sy = (ih - sh) * 0.3;
    ctx.save();
    path([TL, TR, BR, BL]);
    ctx.clip();
    ctx.transform((TR[0] - TL[0]) / sw, (TR[1] - TL[1]) / sw, (BL[0] - TL[0]) / sh, (BL[1] - TL[1]) / sh, TL[0], TL[1]);
    ctx.drawImage(img, s0 * iw, sy, sw, sh, 0, 0, sw, sh);
    ctx.restore();
    fillP([TL, TR, BR, BL], `rgba(5,8,15,${dim})`);
  }
  interface HutOpts {
    /** Where the picture turns the corner, as a part of its width. */
    split?: number;
    /** The roof slab's colour. */
    t?: string;
    upright?: boolean;
  }
  /** A boarded block in a room's colour. `muralId` wraps that room's picture round its two near walls. */
  function hutBox(x: number, y: number, w: number, d: number, h: number, z0: number, acc: string, muralId?: string | null, o: HutOpts = {}): BoxFaces {
    const f = box(x, y, w, d, h, z0, { l: wallL(acc), r: wallR(acc), t: o.t ?? WOOD_D });
    if (muralId) {
      const sp = o.split ?? 0.6;
      muralOn(f.L, muralId, 0, sp, 0.3);
      muralOn(f.R, muralId, sp, 1, 0.52);
    }
    boards(f.L, o.upright);
    boards(f.R, o.upright);
    outline(f.L);
    outline(f.R);
    return f;
  }
  /** A straight-sided block turned to any angle. Returns its two near walls, the left one first. */
  function rbox(cx: number, cy: number, w: number, d: number, ang: number, z0: number, h: number, acc: string, muralId?: string | null): Wall[] {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const corners: Pt[] = ([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]] as const).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
    const walls: (Wall & { depth: number; across: number; lit: number })[] = [];
    for (let i = 0; i < 4; i++) {
      let p = corners[i]!;
      let q = corners[(i + 1) % 4]!;
      const mx = (p[0] + q[0]) / 2 - cx;
      const my = (p[1] + q[1]) / 2 - cy;
      if (mx + my <= 1e-6) continue; // faces away from the eye
      if (q[0] - q[1] < p[0] - p[1]) [p, q] = [q, p];
      walls.push({
        o: [p[0], p[1], z0],
        a: [q[0] - p[0], q[1] - p[1]],
        h,
        len: Math.hypot(q[0] - p[0], q[1] - p[1]),
        depth: p[0] + p[1] + q[0] + q[1],
        across: p[0] - p[1] + q[0] - q[1],
        lit: my / (Math.abs(mx) + Math.abs(my)),
      });
    }
    walls.sort((a, b) => a.depth - b.depth);
    for (const f of walls) face(fq(f, 0, 0, 1, 1), mix(wallR(acc), wallL(acc), Math.round(Math.max(0, f.lit) * 4) / 4), 0);
    face(corners.map((p) => P(p[0], p[1], z0 + h)), WOOD_D, 0.5);
    walls.sort((a, b) => a.across - b.across);
    if (muralId && walls.length === 2) {
      muralOn(walls[0]!, muralId, 0, 0.6, 0.3);
      muralOn(walls[1]!, muralId, 0.6, 1, 0.52);
    }
    for (const f of walls) {
      boards(f);
      outline(f);
    }
    return walls;
  }
  /** A window, lamplit or dark. */
  function win(f: Wall, u0: number, v0: number, u1: number, v1: number, lit = true, cross = true): void {
    const q = fq(f, u0, v0, u1, v1);
    face(q, lit ? GLOW : GLASS, 0.85);
    if (cross && cam.z > 0.5) {
      seg(lerp(q[0]!, q[1]!, 0.5), lerp(q[3]!, q[2]!, 0.5), 'rgba(5,8,15,.9)', 0.9);
      seg(lerp(q[0]!, q[3]!, 0.5), lerp(q[1]!, q[2]!, 0.5), 'rgba(5,8,15,.9)', 0.9);
    }
    if (lit) glow(lerp(q[0]!, q[2]!, 0.5), 0.7, GLOW, 0.3);
  }
  /** A window with louvred shutters either side. */
  function shut(f: Wall, u0: number, v0: number, u1: number, v1: number, acc: string, lit = true): void {
    const s = (u1 - u0) * 0.45;
    const c = mix(BG, acc, 0.72);
    win(f, u0, v0, u1, v1, lit, false);
    for (const [a0, a1] of [[u0 - s, u0], [u1, u1 + s]] as const) {
      quad(f, a0, v0, a1, v1, c, 0.55);
      if (cam.z > 0.8) for (let i = 1; i < 4; i++) seg(fp(f, a0, v0 + ((v1 - v0) * i) / 4), fp(f, a1, v0 + ((v1 - v0) * i) / 4), 'rgba(5,8,15,.5)', 1);
    }
  }
  interface PaneOpts {
    mx?: number;
    my?: number;
    fw?: number;
    fh?: number;
  }
  /** A grid of panes, `lit` of them lamplit, the same ones every frame. */
  function panes(f: Wall, cols: number, rows: number, seed: number, lit = 0.6, o: PaneOpts = {}): void {
    const mx = o.mx ?? 0.08;
    const my = o.my ?? 0.12;
    const fw = o.fw ?? 0.6;
    const fh = o.fh ?? 0.55;
    const cw = (1 - 2 * mx) / cols;
    const rh = (1 - 2 * my) / rows;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const u0 = mx + cw * i + (cw * (1 - fw)) / 2;
        const v0 = my + rh * j + (rh * (1 - fh)) / 2;
        const on = hash(seed * 131 + i * 17 + j, 3, 9) < lit;
        face(fq(f, u0, v0, u0 + cw * fw, v0 + rh * fh), on ? GLOW : GLASS, cam.z > 0.6 ? 0.35 : 0);
      }
    }
  }
  function door(f: Wall, u0: number, u1: number, v1: number, lit = false): void {
    face(fq(f, u0, 0, u1, v1), lit ? GLOW : BG, 0.8);
    glow(fp(f, (u0 + u1) / 2, 0), 1.5, GLOW, 0.3);
  }
  /** The lock ladder, leaning on a wall: the mark of a pool you can lock in, as on Earn. */
  function ladder(x: number, wallY: number, top: number, z0 = ZP): void {
    const out = top / 4;
    const k = K();
    for (const s of [0, 0.3]) seg(P(x + s, wallY + out + 0.03, z0), P(x + s, wallY + 0.03, z0 + top), ink(0.9), Math.max(1, 0.07 * k));
    for (let i = 1; i <= 6; i++) {
      const t = i / 7;
      const o2 = out * (1 - t) + 0.03;
      seg(P(x, wallY + o2, z0 + top * t), P(x + 0.3, wallY + o2, z0 + top * t), ink(0.9), Math.max(0.8, 0.055 * k));
    }
  }

  /* roofs */
  /** Thatch hanging off an eave. */
  function fringe(b0: Pt, b1: Pt): void {
    if (cam.z < 0.55) return;
    const k = K();
    const n = Math.max(3, Math.round(Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) / (0.1 * k)));
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const p = lerp(b0, b1, i / n);
      ctx.moveTo(p[0], p[1]);
      ctx.lineTo(p[0], p[1] + (0.05 + 0.03 * ((i * 7) % 3)) * k);
    }
    ctx.strokeStyle = alpha(STRAW, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  /** One roof plane. `a0` to `a1` is its ridge (the same point twice for a hip's triangle), `b0` to `b1` its eave. */
  function roofP(a0: Pt, a1: Pt, b1: Pt, b0: Pt, m: Roofing, shaded: boolean, fringed: boolean): void {
    face(a0 === a1 ? [a0, b1, b0] : [a0, a1, b1, b0], shaded ? m.b : m.a, 0.4);
    if (cam.z <= 0.4) return;
    ctx.beginPath();
    if (m.ribs) {
      const n = Math.max(3, Math.round(Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) / (0.2 * K())));
      for (let i = 1; i < n; i++) {
        const p = lerp(a0, a1, i / n);
        const q = lerp(b0, b1, i / n);
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
    } else {
      const n = m.n ?? 5;
      for (let i = 1; i < n; i++) {
        const p = lerp(a0, b0, i / n);
        const q = lerp(a1, b1, i / n);
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
    }
    ctx.strokeStyle = m.line;
    ctx.lineWidth = LW();
    ctx.stroke();
    if (m.fringe && fringed) fringe(b0, b1);
  }
  /** A hipped roof coming to a point. */
  function hip(x: number, y: number, w: number, d: number, e: number, rise: number, over: number, m: Roofing = SLATES): void {
    const top = P(x + w / 2, y + d / 2, e + rise);
    const c1 = P(x - over, y - over, e);
    const c2 = P(x + w + over, y - over, e);
    const c3 = P(x + w + over, y + d + over, e);
    const c4 = P(x - over, y + d + over, e);
    roofP(top, top, c2, c1, m, true, false);
    roofP(top, top, c1, c4, m, false, false);
    roofP(top, top, c3, c2, m, true, true);
    roofP(top, top, c3, c4, m, false, true);
  }
  /** A butterfly roof: two wings falling to a valley that runs front to back, over a V of lit glass. */
  function butterfly(x: number, y: number, w: number, d: number, e: number, r: number, over: number, m: Roofing, acc: string, lit = true): void {
    const xm = x + w / 2;
    const zv = e + 0.06;
    const zt = e + r + 0.04;
    const v0 = P(xm, y - over, zv);
    const v1 = P(xm, y + d + over, zv);
    face([P(x, y + d, e), P(x + w, y + d, e), P(x + w, y + d, e + r), P(xm, y + d, zv), P(x, y + d, e + r)], lit ? mix(BG, GLOW, 0.72) : GLASS, 0.6);
    face([P(x + w, y, e), P(x + w, y + d, e), P(x + w, y + d, e + r), P(x + w, y, e + r)], lit ? mix(BG, GLOW, 0.4) : mix(GLASS, BG, 0.4), 0.6);
    if (lit) glow(P(xm, y + d, e + r * 0.4), 1.5, GLOW, 0.3);
    roofP(v0, v1, P(x - over, y + d + over, zt), P(x - over, y - over, zt), m, false, false);
    roofP(v0, v1, P(x + w + over, y + d + over, zt), P(x + w + over, y - over, zt), m, true, false);
    seg(v0, v1, mix(acc, '#ffffff', 0.2), Math.max(1.4, 0.1 * K()));
    seg(P(x - over, y + d + over, zt), v1, ink(0.75), LW() * 1.4);
    seg(v1, P(x + w + over, y + d + over, zt), ink(0.75), LW() * 1.4);
  }

  /* round things */
  interface CylOpts {
    edge?: number;
    rings?: boolean;
    noTop?: boolean;
    top?: string;
  }
  function cyl(cx: number, cy: number, r: number, z0: number, h: number, cA: string, cB: string, o: CylOpts = {}): void {
    const [ax, ay] = P(cx, cy, z0);
    const [bx, by] = P(cx, cy, z0 + h);
    const k = K();
    const rx = r * 1.2247 * k;
    const ry = r * 0.7071 * k;
    const g = ctx.createLinearGradient(ax - rx, 0, ax + rx, 0);
    g.addColorStop(0, cA);
    g.addColorStop(1, cB);
    ctx.beginPath();
    ctx.moveTo(ax - rx, ay);
    ctx.ellipse(ax, ay, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(bx + rx, by);
    ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI, true);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = ink(o.edge ?? 0.5);
    ctx.lineWidth = LW();
    ctx.stroke();
    if (o.rings && cam.z > 0.4) {
      ctx.strokeStyle = 'rgba(5,8,15,.4)';
      const n = Math.round(h / 0.26);
      for (let i = 1; i < n; i++) {
        const [x, y] = P(cx, cy, z0 + (h * i) / n);
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI);
        ctx.stroke();
      }
      ctx.strokeStyle = ink(o.edge ?? 0.5);
    }
    if (!o.noTop) {
      ctx.beginPath();
      ctx.ellipse(bx, by, rx, ry, 0, 0, TAU);
      ctx.fillStyle = o.top ?? SLATE;
      ctx.fill();
      ctx.stroke();
    }
  }
  /** A round wall in a room's colour, with its courses. */
  const drum = (cx: number, cy: number, r: number, z0: number, h: number, acc: string, o: CylOpts = {}): void =>
    cyl(cx, cy, r, z0, h, mix(BG, acc, 0.46), mix(BG, acc, 0.2), { rings: true, ...o });
  function cone(cx: number, cy: number, r: number, z0: number, h: number, cA: string, cB: string): void {
    const [ax, ay] = P(cx, cy, z0);
    const [tx, ty] = P(cx, cy, z0 + h);
    const k = K();
    const rx = r * 1.2247 * k;
    const ry = r * 0.7071 * k;
    const g = ctx.createLinearGradient(ax - rx, 0, ax + rx, 0);
    g.addColorStop(0, cA);
    g.addColorStop(1, cB);
    ctx.beginPath();
    ctx.moveTo(ax - rx, ay);
    ctx.ellipse(ax, ay, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(tx, ty);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = ink(0.45);
    ctx.lineWidth = LW();
    ctx.stroke();
  }
  /** A circle lying on the ground, or at any height. */
  function ellipseG(cx: number, cy: number, r: number, z: number, fill: string | null, stroke: string | null, lw?: number): void {
    const [x, y] = P(cx, cy, z);
    const k = K();
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.2247 * k, r * 0.7071 * k, 0, 0, TAU);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw ?? LW();
      ctx.stroke();
    }
  }
  function rimFringe(ax: number, ay: number, r: number): void {
    if (cam.z < 0.55) return;
    const k = K();
    const m = Math.max(8, Math.round(r * 16));
    ctx.beginPath();
    for (let i = 0; i <= m; i++) {
      const a = Math.PI * (i / m);
      const x = ax + Math.cos(a) * r * 1.2247 * k;
      const y = ay + Math.sin(a) * r * 0.7071 * k;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (0.05 + 0.03 * ((i * 7) % 3)) * k);
    }
    ctx.strokeStyle = alpha(STRAW, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  function thatchCone(cx: number, cy: number, r: number, z0: number, h: number, courses = 3): void {
    cone(cx, cy, r, z0, h, THATCH, THATCH_E);
    if (cam.z <= 0.45) return;
    const k = K();
    const [ax, ay] = P(cx, cy, z0);
    const [tx, ty] = P(cx, cy, z0 + h);
    ctx.strokeStyle = 'rgba(5,8,15,.3)';
    ctx.lineWidth = LW();
    for (let i = 1; i < courses; i++) {
      const f = i / courses;
      ctx.beginPath();
      ctx.ellipse(ax + (tx - ax) * f, ay + (ty - ay) * f, r * (1 - f) * 1.2247 * k, r * (1 - f) * 0.7071 * k, 0, 0, Math.PI);
      ctx.stroke();
    }
    rimFringe(ax, ay, r);
  }
  /** A thatched cone whose point is off-centre: a hat worn askew. */
  function tiltCone(cx: number, cy: number, r: number, z0: number, tip: P3): void {
    const [bx, by] = P(cx, cy, z0);
    const tp = P3of(tip);
    const k = K();
    const rx = r * 1.2247 * k;
    const ry = r * 0.7071 * k;
    const g = ctx.createLinearGradient(bx - rx, 0, bx + rx, 0);
    g.addColorStop(0, THATCH);
    g.addColorStop(1, THATCH_E);
    ctx.beginPath();
    ctx.moveTo(bx - rx, by);
    ctx.ellipse(bx, by, rx, ry, 0, Math.PI, 0, true);
    ctx.lineTo(tp[0], tp[1]);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = ink(0.45);
    ctx.lineWidth = LW();
    ctx.stroke();
    if (cam.z > 0.5) for (let i = 1; i < 6; i++) seg([bx + Math.cos((Math.PI * i) / 6) * rx, by + Math.sin((Math.PI * i) / 6) * ry], tp, 'rgba(5,8,15,.22)', 1);
    rimFringe(bx, by, r);
  }

  /* carpentry */
  function post(x: number, y: number, z0: number, z1: number, w = 0.05, col: string = WOOD_L): void {
    seg(P(x, y, z0), P(x, y, z1), col, Math.max(1, w * K()));
  }
  function deck(x: number, y: number, w: number, d: number, z: number, thick = 0.1): void {
    box(x, y, w, d, thick, z - thick, { l: WOOD, r: WOOD_D, t: WOOD_L }, 0.45);
    if (cam.z <= 0.6) return;
    const n = Math.max(2, Math.round(d / 0.22));
    ctx.beginPath();
    for (let i = 1; i < n; i++) {
      const a = P(x, y + (d * i) / n, z);
      const b = P(x + w, y + (d * i) / n, z);
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.strokeStyle = 'rgba(5,8,15,.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  function stilts(x: number, y: number, w: number, d: number, z: number, nx: number, ny: number): void {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        post(x + 0.08 + ((w - 0.16) * i) / Math.max(1, nx - 1), y + 0.08 + ((d - 0.16) * j) / Math.max(1, ny - 1), ZP, z, 0.06, mix(BG, TIMBER, 0.7));
      }
    }
  }
  function rail(ax: number, ay: number, bx: number, by: number, z: number, h = 0.3): void {
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 0.28));
    if (cam.z > 0.5) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const x = ax + ((bx - ax) * i) / n;
        const y = ay + ((by - ay) * i) / n;
        const p = P(x, y, z);
        const q = P(x, y, z + h);
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
      ctx.strokeStyle = ink(0.45);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    seg(P(ax, ay, z + h), P(bx, by, z + h), ink(0.8), Math.max(1, 0.045 * K()));
  }
  /** Timber steps coming down toward the street from a deck at height `z`. */
  function steps(x: number, y: number, w: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) box(x, y + i * 0.17, w, 0.17, (z - ZP) * (1 - (i + 1) / (n + 1)), ZP, { l: WOOD, r: WOOD_D, t: WOOD_L }, 0.4);
  }
  /** A torch: a flame on a pole. */
  function torch(x: number, y: number, h = 0.95): void {
    const top = P(x, y, ZP + h);
    const fl = 0.07 + 0.02 * Math.sin(time() * 11 + x * 3);
    seg(P(x, y, ZP), top, WOOD_L, Math.max(1, 0.05 * K()));
    dot([top[0], top[1] - fl * K()], fl, '#ffb347');
    glow(top, 1.1, '#ff9a3c', 0.42);
  }
  function flag(x: number, y: number, z0: number, z1: number, col: string): void {
    post(x, y, z0, z1, 0.035, ink(0.8));
    face([P(x, y, z1), P(x + 0.5, y - 0.12, z1 - 0.14), P(x, y, z1 - 0.3)], col, 0.5);
  }
  /** Stepping stones along a garden path. */
  function stones(pts: readonly (readonly [number, number, number?])[]): void {
    if (cam.z < 0.45) return;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.42));
      for (let j = i ? 1 : 0; j <= n; j++) ellipseG(a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n, 0.13, 0.014, mix(BG, INK, 0.22), ink(0.28));
    }
  }
  /** A palm. `z` stands it on a roof. */
  function palm(t: { x: number; y: number; h: number; lean: number; r: number; ph: number; z?: number }): void {
    const k = K();
    const zb = ZP + (t.z ?? 0);
    const base = P(t.x, t.y, zb);
    const mid = P(t.x + t.lean * 0.35, t.y, zb + t.h * 0.55);
    const top = P(t.x + t.lean, t.y, zb + t.h);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(base[0], base[1]);
    ctx.quadraticCurveTo(mid[0], mid[1], top[0], top[1]);
    ctx.strokeStyle = mix(BG, INK, 0.5);
    ctx.lineWidth = Math.max(1, 0.085 * k);
    ctx.stroke();
    const R = t.r * k;
    ctx.lineWidth = Math.max(1, 0.07 * k);
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.6 + Math.sin(time() * 1.1 + t.ph + i) * 0.045;
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      ctx.quadraticCurveTo(top[0] + Math.cos(a) * R * 0.6, top[1] + Math.sin(a) * R * 0.62 - R * 0.16, top[0] + Math.cos(a) * R, top[1] + Math.sin(a) * R * 0.5 + R * 0.4);
      ctx.strokeStyle = i % 2 ? mix(BG, GREEN, 0.7) : mix(BG, GREEN, 0.46);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    if (cam.z > 0.6) dot(top, 0.05, mix(BG, INK, 0.62));
  }

  /* shells and lattices */
  /**
   * A saddle shell between four corners given in order round its edge. Its straight ruling lines
   * are its drawing; where the eye is under it, it is lamplit.
   */
  function hypar(C: readonly [P3, P3, P3, P3], n: number, m: Roofing, o: { noFringe?: boolean; under?: string } = {}): void {
    const cells: { q: P3[]; depth: number; under: boolean; t: number }[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const q0 = bil(C, i / n, j / n);
        const q1 = bil(C, (i + 1) / n, j / n);
        const q2 = bil(C, (i + 1) / n, (j + 1) / n);
        const q3 = bil(C, i / n, (j + 1) / n);
        const ux = q1[0] - q0[0];
        const uy = q1[1] - q0[1];
        const uz = q1[2] - q0[2];
        const vx = q3[0] - q0[0];
        const vy = q3[1] - q0[1];
        const vz = q3[2] - q0[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        if (nz < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        const lit = Math.max(0, Math.min(1, 0.5 + ((ny - nx * 0.4) / len) * 0.9));
        cells.push({ q: [q0, q1, q2, q3], depth: q0[0] + q0[1] + q2[0] + q2[1], under: nx + ny + nz < 0, t: Math.round(lit * 5) / 5 });
      }
    }
    cells.sort((a, b) => a.depth - b.depth);
    for (const c of cells) {
      path(c.q.map(P3of));
      ctx.fillStyle = c.under ? (o.under ?? SOFFIT) : mix(m.b, m.a, c.t);
      ctx.fill();
      if (cam.z > 0.4) {
        ctx.strokeStyle = m.line;
        ctx.lineWidth = LW();
        ctx.stroke();
      }
    }
    const E = C.map(P3of);
    path(E);
    ctx.strokeStyle = ink(0.62);
    ctx.lineWidth = LW() * 1.3;
    ctx.stroke();
    if (m.fringe && !o.noFringe) {
      fringe(E[1]!, E[2]!);
      fringe(E[3]!, E[2]!);
    }
  }
  /** One of Candela's umbrellas: a square shell on a single column, low in the middle and lifting to its edges. */
  function umbrella(cx: number, cy: number, half: number, zc: number, zt: number, m: Roofing): void {
    const quarter = (sx: number, sy: number): void =>
      hypar([[cx, cy, zc], [cx + sx * half, cy, zt], [cx + sx * half, cy + sy * half, zt], [cx, cy + sy * half, zt]], 3, m, { noFringe: true, under: mix(BG, GLOW, 0.34) });
    quarter(-1, -1);
    quarter(1, -1);
    quarter(-1, 1);
    post(cx, cy, ZP, zc, 0.09, STONE_L);
    glow(P(cx, cy, zc - 0.4), 1.3, GLOW, 0.26);
    quarter(1, 1);
  }
  /** A roof swept front to back from a profile of [x, z] points. */
  function sweepX(profile: readonly Pt[], y0: number, y1: number, m: Roofing): void {
    for (let i = 0; i < profile.length - 1; i++) {
      const [xa, za] = profile[i]!;
      const [xb, zb] = profile[i + 1]!;
      const slope = (zb - za) / (xb - xa);
      path([P(xa, y0, za), P(xa, y1, za), P(xb, y1, zb), P(xb, y0, zb)]);
      ctx.fillStyle = slope > 1 ? SOFFIT : mix(m.b, m.a, Math.round(Math.max(0, Math.min(1, 0.55 - slope * 0.5)) * 5) / 5);
      ctx.fill();
      if (cam.z > 0.4 && i % 2 === 0) {
        ctx.strokeStyle = m.line;
        ctx.lineWidth = LW();
        ctx.stroke();
      }
    }
    line(profile.map(([x, z]): P3 => [x, y1, z]), ink(0.8), LW() * 1.5);
    const end = profile[profile.length - 1]!;
    seg(P(end[0], y0, end[1]), P(end[0], y1, end[1]), ink(0.6), LW() * 1.3);
  }
  /** A bamboo gridshell dome. You see through it to its far side. */
  function gridDome(cx: number, cy: number, r: number, z: number, s: number, col: string, members = 13): void {
    const [ax, ay] = P(cx, cy, z);
    const k = K();
    const rx = r * 1.2247 * k;
    const ry = r * 0.7071 * k;
    const hy = r * s * k;
    const g = ctx.createRadialGradient(ax, ay - hy * 0.25, 0, ax, ay - hy * 0.25, rx);
    g.addColorStop(0, alpha(GLOW, 0.3));
    g.addColorStop(1, 'rgba(5,8,15,.5)');
    const silhouette = (): void => {
      ctx.beginPath();
      ctx.moveTo(ax - rx, ay);
      ctx.ellipse(ax, ay, rx, hy, 0, Math.PI, 0, false);
    };
    silhouette();
    ctx.ellipse(ax, ay, rx, ry, 0, 0, Math.PI, false);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    if (cam.z > 0.3) {
      for (const near of [false, true]) {
        for (const turn of [1, -1]) {
          for (let j = 0; j < members; j++) {
            let prev: Pt | null = null;
            let prevSeen = false;
            for (let i = 0; i <= 12; i++) {
              const ph = (i / 12) * (Math.PI / 2) * 0.9;
              const th = (j / members) * TAU + turn * ph * 1.2;
              const cp = Math.cos(ph);
              const sp = Math.sin(ph);
              const p = P(cx + r * cp * Math.cos(th), cy + r * cp * Math.sin(th), z + r * s * sp);
              const seen = cp * (Math.cos(th) + Math.sin(th)) + sp / s > 0;
              if (prev && (seen && prevSeen) === near) seg(prev, p, alpha(col, near ? 0.9 : 0.22), near ? LW() * 1.25 : LW());
              prev = p;
              prevSeen = seen;
            }
          }
        }
      }
    }
    silhouette();
    ctx.strokeStyle = ink(0.4);
    ctx.lineWidth = LW();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(ax, ay, rx, ry, 0, 0, Math.PI);
    ctx.strokeStyle = alpha(col, 0.9);
    ctx.lineWidth = LW() * 1.5;
    ctx.stroke();
  }
  /** A lattice hyperboloid: every member is straight, yet it curves. Call once for its far side, once for its near. */
  function hyperboloid(cx: number, cy: number, r: number, z0: number, z1: number, members: number, twist: number, col: string, near: boolean): void {
    for (const turn of [1, -1]) {
      for (let i = 0; i < members; i++) {
        const a0 = (i / members) * TAU;
        const a1 = a0 + turn * twist;
        const am = a0 + (turn * twist) / 2;
        if (Math.cos(am) + Math.sin(am) > 0 !== near) continue;
        seg(P(cx + r * Math.cos(a0), cy + r * Math.sin(a0), z0), P(cx + r * Math.cos(a1), cy + r * Math.sin(a1), z1), alpha(col, near ? 0.92 : 0.24), near ? LW() * 1.25 : LW());
      }
    }
  }
  /** A line wound round a tower; only its near side is drawn. */
  function helixOn(cx: number, cy: number, rAt: (z: number) => number, z0: number, z1: number, turns: number, a0: number, col: string, w: number): void {
    let prev: Pt | null = null;
    let prevSeen = false;
    const n = Math.round(turns * 44);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const z = z0 + (z1 - z0) * t;
      const an = a0 + t * turns * TAU;
      const r = rAt(z);
      const p = P(cx + r * Math.cos(an), cy + r * Math.sin(an), z);
      const seen = Math.cos(an) + Math.sin(an) > -0.2;
      if (prev && seen && prevSeen) seg(prev, p, col, w);
      prev = p;
      prevSeen = seen;
    }
  }
  /** One petal of a shell that opens upward. */
  function petal(cx: number, cy: number, an: number, r0: number, r1: number, wd: number, z0: number, z1: number, fill: string): void {
    const at = (r: number, a2: number, z: number): Pt => P(cx + r * Math.cos(a2), cy + r * Math.sin(a2), z);
    const rm = r0 + (r1 - r0) * 0.62;
    const zm = z0 + (z1 - z0) * 0.5;
    const B1 = at(r0, an - wd, z0);
    const B2 = at(r0, an + wd, z0);
    const tip = at(r1, an, z1);
    const C1 = at(rm, an - wd * 1.9, zm);
    const C2 = at(rm, an + wd * 1.9, zm);
    ctx.beginPath();
    ctx.moveTo(B1[0], B1[1]);
    ctx.quadraticCurveTo(C1[0], C1[1], tip[0], tip[1]);
    ctx.quadraticCurveTo(C2[0], C2[1], B2[0], B2[1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = ink(0.6);
    ctx.lineWidth = LW();
    ctx.stroke();
    const mid = lerp(B1, B2, 0.5);
    seg(mid, tip, ink(0.3), LW());
    if (cam.z > 0.6) {
      for (const t of [0.3, 0.5, 0.7]) {
        const c = lerp(mid, tip, t);
        seg(c, lerp(lerp(B1, C1, t), lerp(C1, tip, t), t), ink(0.14), 1);
        seg(c, lerp(lerp(B2, C2, t), lerp(C2, tip, t), t), ink(0.14), 1);
      }
    }
  }

  /** Lay the frame's lamplight and beams over its solids, and forget them. */
  function flushGlows(): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const bm of beams) {
      const a = time() * 0.8;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const far = 16;
      const o = P(bm.cx, bm.cy, bm.z);
      const p1 = P(bm.cx + dx * far - dy * 2.6, bm.cy + dy * far + dx * 2.6, bm.z - 2);
      const p2 = P(bm.cx + dx * far + dy * 2.6, bm.cy + dy * far - dx * 2.6, bm.z - 2);
      const gr = ctx.createLinearGradient(o[0], o[1], (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2);
      gr.addColorStop(0, alpha(GLOW, 0.34));
      gr.addColorStop(1, alpha(GLOW, 0));
      ctx.fillStyle = gr;
      path([o, p1, p2]);
      ctx.fill();
    }
    for (const g of glows) {
      if (g.r < 1) continue;
      const gr = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, g.r);
      gr.addColorStop(0, alpha(g.col, g.a));
      gr.addColorStop(1, alpha(g.col, 0));
      ctx.fillStyle = gr;
      ctx.fillRect(g.x - g.r, g.y - g.r, g.r * 2, g.r * 2);
    }
    ctx.restore();
    glows.length = 0;
    beams.length = 0;
  }

  return {
    ctx, cam, time, K, LW, P, P3of, lerp,
    path, fillP, face, seg, line, dot, glow, beams, flushGlows,
    fp, fq, quad, outline, box, stoneBox, hutBox, rbox, win, shut, panes, door, ladder,
    fringe, roofP, hip, butterfly,
    cyl, drum, cone, ellipseG, thatchCone, tiltCone,
    post, deck, stilts, rail, steps, torch, flag, stones, palm,
    hypar, umbrella, sweepX, gridDome, hyperboloid, helixOn, petal,
  };
}
