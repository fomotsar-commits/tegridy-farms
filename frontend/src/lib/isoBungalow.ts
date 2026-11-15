// A bungalow of Earn's site model, in numbers: the one house every pool is drawn as
// (components/farm/IsoBungalow.tsx draws it; lib/isoPlan.ts sets the houses out in streets).
//
// Pure, and apart from the components, so the drawing and its tests read the same geometry:
// the ladder's rungs, the outline that takes the pointer, the frame a room's picture lies in.
//
// ⚠️ ONE HOUSE. There is one footprint, one eave and one roof here, on purpose: the model reads
// no chain, so a house may not be bigger than its neighbour. The only thing drawn to scale is
// the lock ladder against its wall, from the contract's two constants.
import { MAX_BOOST_BPS, MIN_BOOST_BPS } from './constants';
import { iso, type P3, type Pt } from './iso';

/** Pixels per unit on the sheet. */
export const U = 20;
/** The footprint along its street (x) and across it (y). */
export const HOUSE_W = 3.0;
export const HOUSE_D = 2.2;
/** The walls' height: tall enough that the room's picture reads on the front wall. */
export const EAVE = 2.4;
/** The roof's rise from eave to ridge: at least half the depth, so its far slope is turned away from the eye and is not drawn. */
export const RISE = 1.15;
export const RIDGE = EAVE + RISE;
/** How far the roof stands out past the walls: over the eave, and over the gable. */
export const OVER_EAVE = 0.14;
export const OVER_GABLE = 0.16;
export const ROOF_THICK = 0.1;
/** The roof's fall per unit across: its rise over half the depth. */
export const FALL = RISE / (HOUSE_D / 2);
/** The eave's top edge, out over the front wall. */
export const EAVE_Z = EAVE - OVER_EAVE * FALL;
/** The stone course the brick stands on. */
export const PLINTH = 0.16;
/** How far the roof lifts off a bungalow pointed at, as an architect lifts the roof off a model to show inside. */
export const ROOF_LIFT = 1.0;

/** The front wall's openings, in its own plane (pixels across from its left end, and up from the ground): the door, near the gable. */
export const DOOR = { u: 38, w: 10, h: 20 } as const;

/**
 * THE LADDER. It stands near the front wall's left end: there no house in the street in front
 * stands between it and the eye (isoPlan.test.ts sweeps every rung against every house drawn
 * after it). Its rails stop under the soffit and lean out a quarter of their height, the
 * four-to-one rule.
 */
export const LADDER_AT = HOUSE_W * 0.12;
export const RAIL_GAP = 0.3;
export const RAIL_TOP = EAVE - ROOF_THICK - 0.04;
export const LADDER_OUT = RAIL_TOP / 4;

/** How far in front of the wall the ladder stands at height `z`. */
export function ladderOut(z: number): number {
  return 0.02 + LADDER_OUT * (1 - z / RAIL_TOP);
}

/** The plan point of a rail (`side` 0 the left, 1 the right) at height `z`, for the bungalow at (x, y). */
export function railPoint(x: number, y: number, side: 0 | 1, z: number): P3 {
  return [x + LADDER_AT + side * RAIL_GAP, y + HOUSE_D + ladderOut(z), z];
}

/** How far under the eave's lower edge the top rung stands on the sheet, at least. */
const RUNG_CLEAR_PX = 3;

/**
 * The ladder's rungs, to scale. The top rung stands for the ladder's ceiling (the share of the
 * longest lock) and the first for its floor (the share of the shortest), so the first is as far
 * up as the floor is of the ceiling; the rest are spaced evenly between, as the share grows
 * evenly with the lock.
 *
 * The top rung is as high as it can be and still show under the eave. A point `d` in front of
 * the wall at height `z` lands on the sheet where the wall's own point at `z - d` does; the
 * eave's lower edge stands OVER_EAVE out at EAVE_Z - ROOF_THICK. So a rung at `z`, ladderOut(z)
 * out, shows under it while z - ladderOut(z) stays below EAVE_Z - ROOF_THICK - OVER_EAVE, here
 * with RUNG_CLEAR_PX to spare.
 */
export const RUNG_HIGH =
  (EAVE_Z - ROOF_THICK - OVER_EAVE + 0.02 + LADDER_OUT - RUNG_CLEAR_PX / U) / (1 + LADDER_OUT / RAIL_TOP);
export const RUNG_LOW = RUNG_HIGH * (MIN_BOOST_BPS / MAX_BOOST_BPS);
export function rungHeights(count = 6): number[] {
  return Array.from({ length: count }, (_, i) => RUNG_LOW + ((RUNG_HIGH - RUNG_LOW) * i) / (count - 1));
}

/** The roof's corners for the bungalow at (x, y), with its roof on. */
export function roofCorners(x: number, y: number) {
  return {
    ridgeL: [x - OVER_GABLE, y + HOUSE_D / 2, RIDGE] as P3,
    ridgeR: [x + HOUSE_W + OVER_GABLE, y + HOUSE_D / 2, RIDGE] as P3,
    eaveR: [x + HOUSE_W + OVER_GABLE, y + HOUSE_D + OVER_EAVE, EAVE_Z] as P3,
    eaveL: [x - OVER_GABLE, y + HOUSE_D + OVER_EAVE, EAVE_Z] as P3,
    backR: [x + HOUSE_W + OVER_GABLE, y - OVER_EAVE, EAVE_Z] as P3,
  };
}

/** The near slope and the eave's edge under it, on the sheet: what stands between the eye and the top of the front wall. */
export function roofOutline(x: number, y: number): Pt[] {
  const r = roofCorners(x, y);
  const drop = (c: P3): P3 => [c[0], c[1], c[2] - ROOF_THICK];
  return [r.ridgeL, r.ridgeR, r.eaveR, drop(r.eaveR), drop(r.eaveL), r.eaveL].map((c) => iso(c, U));
}

/** The chimney: a box on the ridge, its base where the two slopes meet its faces, and a stone cap. */
export function chimneyBox(x: number, y: number) {
  const size = 0.44;
  const cx = x + HOUSE_W * 0.66;
  const cy = y + HOUSE_D / 2 - size / 2;
  return { cx, cy, size, base: RIDGE - (size / 2) * FALL, top: RIDGE + 0.47, cap: 0.07, capOver: 0.05 };
}

/** Points in convex order: the smallest convex outline round them. */
export function convexHull(points: readonly Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  const upper: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The bungalow as it stands with its roof on, on the sheet: the one shape that takes the
 * pointer, so a roof lifting from under it never hands the pointer to the house behind. It
 * follows the eave's edge and then the front wall's left edge down to the ground, so it never
 * takes the pointer over the neighbour's gable to its left.
 */
export function houseOutline(x: number, y: number): Pt[] {
  const r = roofCorners(x, y);
  const at = (c: P3) => iso(c, U);
  return [
    at([x, y + HOUSE_D, 0]), at([x + HOUSE_W, y + HOUSE_D, 0]), at([x + HOUSE_W, y, 0]),
    at(r.backR), at(r.ridgeR), at(r.ridgeL), at(r.eaveL),
    at([r.eaveL[0], r.eaveL[1], EAVE_Z - ROOF_THICK]),
    // Where the eave's lower edge crosses the wall's left edge on the sheet.
    at([x, y + HOUSE_D, EAVE_Z - ROOF_THICK - OVER_EAVE]),
  ];
}

/**
 * The chimney on the sheet, roof on: the stack and its cap, each its own shape, so the narrow
 * gap under the cap's overhang beside the stack does not take the pointer from the house behind.
 */
export function chimneyOutlines(x: number, y: number): Pt[][] {
  const c = chimneyBox(x, y);
  const box = (x0: number, y0: number, size: number, z0: number, z1: number) =>
    convexHull(([
      [x0, y0, z0], [x0 + size, y0, z0], [x0 + size, y0 + size, z0], [x0, y0 + size, z0],
      [x0, y0, z1], [x0 + size, y0, z1], [x0 + size, y0 + size, z1], [x0, y0 + size, z1],
    ] as P3[]).map((p) => iso(p, U)));
  return [
    box(c.cx, c.cy, c.size, c.base, c.top),
    box(c.cx - c.capOver, c.cy - c.capOver, c.size + 2 * c.capOver, c.top, c.top + c.cap),
  ];
}

/** The name over a bungalow pointed at: its baseline this high over the lifted ridge, its glyphs this tall. */
export const LABEL_Z = 0.8;
export const LABEL_PX = 16;
/** The baseline sits this far over the leader line's top. */
export const LABEL_GAP_PX = 8;
/** The smoke rises this far over the chimney's cap, puffs and all. */
export const SMOKE_PX = 40;

/**
 * Every outer point of a bungalow on the sheet, for the model's bounds: its light pool, its
 * ladder's feet, and over the ridge room for the lifted roof, its smoke and its name. Every
 * bungalow is measured as if lifted, so the drawing never changes size as the light moves.
 */
export function bungalowBox(x: number, y: number): Pt[] {
  const at = (c: P3) => iso(c, U);
  const label = at([x + HOUSE_W / 2, y + HOUSE_D / 2, RIDGE + ROOF_LIFT + LABEL_Z]);
  const c = chimneyBox(x, y);
  const smoke = at([c.cx + c.size / 2, c.cy + c.size / 2, c.top + c.cap + ROOF_LIFT]);
  return [
    at([x - OVER_GABLE, y - OVER_EAVE, 0]),
    at([x + HOUSE_W + OVER_GABLE + 1, y - OVER_EAVE, 0]),
    at([x + HOUSE_W + OVER_GABLE + 1, y + HOUSE_D + 1.2, 0]),
    at([x - OVER_GABLE - 0.4, y + HOUSE_D + 1.2, 0]),
    [label[0], label[1] - LABEL_GAP_PX - LABEL_PX],
    [smoke[0] + 12, smoke[1] - SMOKE_PX],
  ];
}

/* ─────────────── the room's picture on the walls ─────────────── */

/**
 * The room's picture covers both walls the eye sees. The front wall shows the crop the room
 * chose for its door card (muralFrame); the gable shows the picture again, as tall as the gable,
 * at the room's own object-position (gableFrame). Each wall is the picture's frame in its own
 * plane: across from its left end, down from the ridge's height.
 */
export const MURAL_H = RIDGE * U;
/** The front wall, in its own plane: what its picture must always cover. */
export const FRONT_WALL = { right: HOUSE_W * U, top: RISE * U, bottom: MURAL_H } as const;
/** The gable wall, in its own plane: as wide as the house is deep, from the peak to the ground. */
export const GABLE_WALL = { right: HOUSE_D * U, bottom: MURAL_H } as const;
/**
 * The band of the front wall the eye sees, in its own plane: from where the eave's lower edge
 * lands on the wall (a point OVER_EAVE out at EAVE_Z - ROOF_THICK lands on the wall's own point
 * at that height less OVER_EAVE) down to the plinth.
 */
export const FRONT_BAND = {
  top: (RIDGE - (EAVE_Z - ROOF_THICK - OVER_EAVE)) * U,
  bottom: MURAL_H - PLINTH * U,
} as const;
/** Where a picture's subject is set: the middle of the clear wall between the ladder and the door. */
export const MURAL_TARGET = {
  u: ((LADDER_AT + RAIL_GAP) * U + 2 + DOOR.u) / 2,
  v: (FRONT_BAND.top + FRONT_BAND.bottom) / 2,
} as const;

/**
 * The hall's door card, whose crop each room set (VenueDoors.tsx draws it about 271 by 128 on a
 * desktop, object-fit cover at the room's object-position): a wide band, like the front wall's
 * seen band. Its img says 300 by 128, but that is the slot it is sized for, not the card a
 * visitor sees.
 */
export const DOOR_CARD_ASPECT = 271 / 128;
/**
 * How wide a picture lies on the front wall, in the drawing's units: the door card's crop
 * spread across the seen band. The same for every picture no wider than about 1.6 to 1 (the
 * island's door pictures run 0.70 to 1.51); a wider one lies wider, to cover the wall.
 */
export const MURAL_ACROSS = (FRONT_BAND.bottom - FRONT_BAND.top) * DOOR_CARD_ASPECT;

/** A CSS object-position read as fractions across and down; a part not given or not read is CSS's own 50%. */
function positionOf(objectPosition?: string): [number, number] {
  const [px, py] = (objectPosition ?? '').trim().split(/\s+/).map((v) => Number.parseFloat(v));
  const frac = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? 0.5 : Math.max(0, Math.min(100, n)) / 100);
  return [frac(px), frac(py)];
}

/**
 * What a door card shows of a picture: the middle of its crop, as fractions across and down,
 * and how much of the picture the crop holds each way. CSS object-position read as CSS reads
 * it: in a crop that shows a fraction k of the picture, a position p puts the crop's middle at
 * p (1 - k) + k / 2. Unread, CSS's own default, 50% 50%.
 */
export function cardCrop(natural: { w: number; h: number }, objectPosition?: string) {
  const [px, py] = positionOf(objectPosition);
  const aspect = natural.w / natural.h;
  const kx = aspect > DOOR_CARD_ASPECT ? DOOR_CARD_ASPECT / aspect : 1;
  const ky = aspect > DOOR_CARD_ASPECT ? 1 : aspect / DOOR_CARD_ASPECT;
  return { fx: px * (1 - kx) + kx / 2, fy: py * (1 - ky) + ky / 2, kx, ky };
}

/**
 * Where a room's picture lies on its front wall: the crop its door card shows, spread across
 * the wall's seen band and centred on MURAL_TARGET, so the wall shows what the room chose to
 * show. Never smaller than covering the front wall from its top to the ground (a picture wider
 * than about 1.6 to 1 is laid at that, so the wall shows a little less of it than the card
 * does), and moved only as far as keeps the wall covered. `natural` is the picture's own size.
 */
export function muralFrame(natural: { w: number; h: number }, objectPosition?: string) {
  const crop = cardCrop(natural, objectPosition);
  const cover = Math.max(FRONT_WALL.right / natural.w, (FRONT_WALL.bottom - FRONT_WALL.top) / natural.h);
  const band = FRONT_BAND.bottom - FRONT_BAND.top;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const s = Math.max(band / (crop.ky * natural.h), cover);
  const width = natural.w * s;
  const height = natural.h * s;
  return {
    x: clamp(MURAL_TARGET.u - crop.fx * width, FRONT_WALL.right - width, 0),
    y: clamp(MURAL_TARGET.v - crop.fy * height, FRONT_WALL.bottom - height, FRONT_WALL.top),
    width,
    height,
  };
}

/**
 * Where a room's picture lies on its gable: the whole gable, peak to ground, covered as CSS's
 * object-fit: cover lays a picture in a box the gable's size, at the room's own
 * object-position. A tall picture shows nearly whole there; a wide one, the part about its
 * subject.
 */
export function gableFrame(natural: { w: number; h: number }, objectPosition?: string) {
  const [px, py] = positionOf(objectPosition);
  const s = Math.max(GABLE_WALL.right / natural.w, GABLE_WALL.bottom / natural.h);
  const width = natural.w * s;
  const height = natural.h * s;
  return { x: (GABLE_WALL.right - width) * px, y: (GABLE_WALL.bottom - height) * py, width, height };
}
