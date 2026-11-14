// An axonometric drawing, as an architect sets one out: every length keeps its scale on all
// three axes, so a height can be compared with another by eye. Earn's two figures are drawn
// with it: the island's pools as a site model (components/farm/IsoIsland.tsx) and a harvest as
// a stack of plates (components/farm/HarvestStack.tsx).
//
// Pure: points in, points out. The world's x runs down-screen to the right, its y down-screen
// to the left, and z is up. One unit is `u` pixels along either ground axis.

export type Pt = readonly [number, number];
export type P3 = readonly [number, number, number];

const COS30 = Math.sqrt(3) / 2;
const SIN30 = 0.5;

/** A point of the world on the sheet. */
export function iso([x, y, z]: P3, u = 1): Pt {
  return [(x - y) * COS30 * u, ((x + y) * SIN30 - z) * u];
}

/** Points as an SVG `points` attribute, rounded so the markup stays short and stable. */
export function pts(points: readonly Pt[]): string {
  return points.map(([x, y]) => `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`).join(' ');
}

export interface Solid {
  /** The face you look down on. */
  top: Pt[];
  /** The face toward the lower left: for a ramp, its profile. */
  left: Pt[];
  /** The face toward the lower right. */
  right: Pt[];
}

/**
 * A block standing on the ground at (x, y), `w` along x and `d` along y. Its top is `zLo` high
 * along its near-x edge and `zHi` along its far-x edge: equal for a slab, unequal for a ramp
 * that rises along x. `z0` lifts the whole block off the ground (a plate in a stack).
 */
export function solid(x: number, y: number, w: number, d: number, zLo: number, zHi: number, u = 1, z0 = 0): Solid {
  const p = (px: number, py: number, pz: number) => iso([px, py, pz], u);
  return {
    top: [p(x, y, z0 + zLo), p(x + w, y, z0 + zHi), p(x + w, y + d, z0 + zHi), p(x, y + d, z0 + zLo)],
    left: [p(x, y + d, z0 + zLo), p(x + w, y + d, z0 + zHi), p(x + w, y + d, z0), p(x, y + d, z0)],
    right: [p(x + w, y, z0 + zHi), p(x + w, y + d, z0 + zHi), p(x + w, y + d, z0), p(x + w, y, z0)],
  };
}

/** The smallest box around some points, as [minX, minY, width, height]. */
export function bounds(points: readonly Pt[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return [0, 0, 0, 0];
  return [minX, minY, maxX - minX, maxY - minY];
}

/**
 * The matrix that lays flat artwork on the ground plane, for an SVG `transform`: a letter drawn
 * upright in the plane reads along the world's x axis, as a street name does on a site plan.
 */
export function groundMatrix([x, y, z]: P3, u = 1): string {
  const [ox, oy] = iso([x, y, z], u);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `matrix(${r(COS30)} ${r(SIN30)} ${r(-COS30)} ${r(SIN30)} ${r(ox)} ${r(oy)})`;
}
