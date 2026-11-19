// The city's ink: the site's axonometric (lib/iso.ts) on a 2D canvas, for the live parts drawn
// over the island's render (lib/city/render.ts): people, plaques, the picked plot's outline.
// The island itself is a picture made in Blender (scripts/city-render/), never drawn here.

import type { P3, Pt } from '../iso';

export const COS30 = Math.sqrt(3) / 2;
export const TAU = Math.PI * 2;
/** Pixels to one world unit at zoom 1. */
export const UNIT = 18;
/** The height of a plot's paving above the road. */
export const ZP = 0.06;

/* The drawing set's inks (styles/dwg.css). */
export const BG = '#05080f';
export const INK = '#f5e4b8';
export const GLOW = '#ffd98a';
export const SPOT = '#ff6fa3';
export const AQUA = '#5ad1e6';

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
/** A repeatable number in [0, 1) from three integers: where a palm leans. */
export function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a + 11, 374761393) ^ Math.imul(b + 7, 668265263) ^ Math.imul(c + 3, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Where the sheet sits under the eye: an offset in pixels and a zoom. */
export interface Cam {
  x: number;
  y: number;
  z: number;
}

interface Glow {
  x: number;
  y: number;
  r: number;
  col: string;
  a: number;
}

export type Kit = ReturnType<typeof createKit>;

export function createKit({ ctx, cam }: { ctx: CanvasRenderingContext2D; cam: Cam }) {
  const glows: Glow[] = [];
  /** Pixels to one world unit, at the present zoom. */
  const K = (): number => UNIT * cam.z;
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
  function seg(a: Pt, b: Pt, col: string, w: number): void {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
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
  /** Light, laid over the frame once everything else is down (`flushGlows`). */
  function glow(p: Pt, rU: number, col: string, a: number): void {
    glows.push({ x: p[0], y: p[1], r: rU * K(), col, a });
  }
  function flushGlows(): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
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
  }
  return { ctx, cam, K, P, P3of, path, seg, dot, glow, flushGlows };
}
