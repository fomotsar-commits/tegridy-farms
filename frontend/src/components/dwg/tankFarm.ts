import { iso, pts, type P3, type Pt } from '../../lib/iso';
import type { FieldPool } from '../../lib/solana/lp/fieldStore';

// P-01's figure: the venue's pools as an isometric tank farm (lib/iso.ts). Pure: pools in,
// points out. One tank per pool, every tank the same size, rows of four, the first pool
// nearest the eye. Water stands on the gauge only in a tank whose dollars were read; a tank
// that holds coins whose dollars were not read shows still water at one height, off the gauge.

export type { FieldPool };

/** The world's units: a tank's width, depth, height and wall, and the gaps between tanks. */
export const TANK = { U: 34, W: 2.5, D: 1.85, H: 1, T: 0.16, GX: 0.7, GY: 1.55, COLS: 4 } as const;

/** Every drawing of the farm has this shape (width over height); dwg-pools.css sizes the hero by it. */
export const FIELD_ASPECT = 1.6;

/** The staff gauge's ends: $10 at the tank's floor, $10K at its brim, on a log scale. */
export const GAUGE_LOW_USD = 10;
export const GAUGE_HIGH_USD = 10_000;

/** Where the water stands, 0 to 1 of the tank, or null when the dollars were not read (the tank stays dry). */
export function waterLevel(usd: number | null | undefined): number | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return null;
  if (usd <= GAUGE_LOW_USD) return 0;
  const span = Math.log10(GAUGE_HIGH_USD) - Math.log10(GAUGE_LOW_USD);
  return Math.min(1, (Math.log10(usd) - Math.log10(GAUGE_LOW_USD)) / span);
}

export type Seg = readonly [number, number, number, number];

/** `wet`: dollars read, water at its level. `still`: holds coins, dollars not read. `dry`: nothing read. */
export type TankState = 'wet' | 'still' | 'dry';

/** Where still water is drawn, 0 to 1 of the tank: the same in every such tank, so it compares nothing. */
export const STILL_LEVEL = 0.42;

export interface TankDrawing {
  readonly i: number;
  readonly pool: FieldPool;
  readonly state: TankState;
  readonly level: number | null;
  readonly left: string;
  readonly right: string;
  readonly top: string;
  readonly hole: string;
  readonly wallA: string;
  readonly wallB: string;
  readonly water: string;
  readonly ripples: readonly Seg[];
  /** The front wall's top corner nearest the eye's left: where the name is laid on the wall. */
  readonly label: Pt;
  /** The name's size in the drawing's units, smaller for a long name so it stays on its wall. */
  readonly labelSize: number;
}

export interface FarmDrawing {
  readonly viewBox: readonly [number, number, number, number];
  /** Far tanks first, so a nearer one is drawn over them. */
  readonly tanks: readonly TankDrawing[];
  readonly grid: readonly Seg[];
  readonly mains: readonly { line: Seg; hole: Pt }[];
}

const FLOOR_Z = 0.08;
const BRIM = 0.16;
const PAD = 12;

/** The farm for these pools, in a box of `aspect` (padded on the left or top and bottom to fit it). */
export function tankFarm(pools: readonly FieldPool[], aspect = FIELD_ASPECT): FarmDrawing | null {
  if (pools.length === 0) return null;
  const { U, W, D, H, T, GX, GY, COLS } = TANK;
  const q = (p: P3): Pt => iso(p, U);
  const rows = Math.ceil(pools.length / COLS);
  const placed = pools.map((pool, i) => {
    const r = rows - 1 - Math.floor(i / COLS);
    const c = COLS - 1 - (i % COLS);
    return { pool, i, x: c * (W + GX), y: r * (D + GY) };
  });
  const maxX = COLS * (W + GX) + 0.2;
  const maxY = rows * (D + GY) + 0.2;
  const seen: Pt[] = [];

  const tanks = placed
    .slice()
    .sort((a, b) => a.x + a.y - (b.x + b.y))
    .map(({ pool, i, x, y }): TankDrawing => {
      const level = waterLevel(pool.usd);
      const state: TankState = level !== null ? 'wet' : pool.stocked ? 'still' : 'dry';
      const stands = level ?? (state === 'still' ? STILL_LEVEL : null);
      const wz = stands === null ? FLOOR_Z : FLOOR_Z + (H - BRIM - FLOOR_Z) * stands;
      const top = [q([x, y, H]), q([x + W, y, H]), q([x + W, y + D, H]), q([x, y + D, H])];
      const left = [q([x, y + D, H]), q([x + W, y + D, H]), q([x + W, y + D, 0]), q([x, y + D, 0])];
      const right = [q([x + W, y, H]), q([x + W, y + D, H]), q([x + W, y + D, 0]), q([x + W, y, 0])];
      const hole = [q([x + T, y + T, H]), q([x + W - T, y + T, H]), q([x + W - T, y + D - T, H]), q([x + T, y + D - T, H])];
      const wallA = [q([x + T, y + T, H]), q([x + W - T, y + T, H]), q([x + W - T, y + T, wz]), q([x + T, y + T, wz])];
      const wallB = [q([x + T, y + T, H]), q([x + T, y + D - T, H]), q([x + T, y + D - T, wz]), q([x + T, y + T, wz])];
      const water = [q([x + T, y + T, wz]), q([x + W - T, y + T, wz]), q([x + W - T, y + D - T, wz]), q([x + T, y + D - T, wz])];
      const ripples: Seg[] = [];
      if (level !== null) {
        for (let k = 1; k <= 3; k++) {
          const yy = y + T + ((D - 2 * T) * k) / 4;
          const a = q([x + T + 0.12, yy, wz]);
          const b = q([x + W - T - 0.12, yy, wz]);
          ripples.push([a[0], a[1], b[0], b[1]]);
        }
      }
      seen.push(...top, ...left, ...right);
      const room = W * U - 14;
      return {
        i,
        pool,
        state,
        level,
        top: pts(top),
        left: pts(left),
        right: pts(right),
        hole: pts(hole),
        wallA: pts(wallA),
        wallB: pts(wallB),
        water: pts(water),
        ripples,
        label: q([x, y + D, H]),
        labelSize: Math.min(10, room / (0.72 * Math.max(1, pool.name.length))),
      };
    });

  const mains = Array.from({ length: rows }, (_, r) => {
    const yy = r * (D + GY) + D + 1.08;
    const a = q([-0.5, yy, 0]);
    const b = q([maxX + 0.1, yy, 0]);
    const hole = q([maxX + 0.62, yy, 0]);
    seen.push(a, b, [hole[0] + 12, hole[1] + 7], [hole[0] - 12, hole[1] - 7]);
    return { line: [a[0], a[1], b[0], b[1]] as Seg, hole };
  });

  const grid: Seg[] = [];
  for (let gx = -0.8; gx <= maxX + 0.8; gx += 1.1) {
    const a = q([gx, -0.8, 0]);
    const b = q([gx, maxY + 0.4, 0]);
    grid.push([a[0], a[1], b[0], b[1]]);
  }
  for (let gy = -0.8; gy <= maxY + 0.4; gy += 1.1) {
    const a = q([-0.8, gy, 0]);
    const b = q([maxX + 0.8, gy, 0]);
    grid.push([a[0], a[1], b[0], b[1]]);
  }

  return { viewBox: fitAspect(seen, aspect), tanks, grid, mains };
}

/** The box round `points`, padded to `aspect`: extra width goes on the left (the farm keeps to the right), extra height evenly. */
export function fitAspect(points: readonly Pt[], aspect: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  let x = minX - PAD;
  let y = minY - PAD;
  let w = maxX - minX + 2 * PAD;
  let h = maxY - minY + 2 * PAD;
  if (w / h > aspect) {
    const grown = w / aspect;
    y -= (grown - h) / 2;
    h = grown;
  } else {
    const grown = h * aspect;
    x -= grown - w;
    w = grown;
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return [r(x), r(y), r(w), r(h)];
}
