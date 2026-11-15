// Plane geometry for tests of the drawings (lib/isoBungalow.test.ts, lib/isoPlan.test.ts).
import type { Pt } from '../lib/iso';

/** Is a point inside a polygon (even-odd)? */
export function inside([px, py]: Pt, poly: readonly Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** How far a point stands outside a polygon, in sheet pixels; negative when it is inside. */
export function clearance(pt: Pt, poly: readonly Pt[]): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j]!;
    const [bx, by] = poly[i]!;
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((pt[0] - ax) * vx + (pt[1] - ay) * vy) / (vx * vx + vy * vy || 1)));
    d = Math.min(d, Math.hypot(pt[0] - (ax + t * vx), pt[1] - (ay + t * vy)));
  }
  return inside(pt, poly) ? -d : d;
}

/** Do two axis-aligned boxes [x0, y0, x1, y1] overlap? */
export function boxesMeet(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}
