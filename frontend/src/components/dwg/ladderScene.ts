import { iso, wallMatrix, type Pt } from '../../lib/iso';
import { MAX_BOOST_BPS, MIN_BOOST_BPS } from '../../lib/constants';
import { DOOR, HOUSE_D, HOUSE_W, MURAL_H, OVER_GABLE, PLINTH, RAIL_TOP, RIDGE, RUNG_HIGH, U, railPoint } from '../../lib/isoBungalow';
import type { LadderRung } from '../../lib/ladderPick';

// S-01's figure (LadderHouse.tsx): the pool's own bungalow and its lock ladder, in the drawing's
// units (U px of lib/isoBungalow.ts), the house at the plan's origin. Pure: what the staircase
// published in, points out. Every rung stands as high as its weight, so 0.40x stands a tenth as
// high as 4.00x; before a staircase publishes, only the floor and ceiling the contract fixes.

const COS30 = Math.sqrt(3) / 2;
const SIN30 = 0.5;

/** The house's plot, on the plan. */
export const PLOT = { x0: -0.5, x1: HOUSE_W + 0.55, y0: -0.5, y1: HOUSE_D + 1.0 } as const;
/** How far left of the picked rung its measure stands. */
export const DIM_OFF = 9;
/** Room left of the measure for the pick's tag: the rail's figure is drawn smaller, so its tag needs more units. */
export const TAG_ROOM = { hero: 28, rail: 44 } as const;
/** The meter box on the gable wall, in that wall's plane. */
export const METER = { u: 27, v: MURAL_H - PLINTH * U - 21, w: 8.5, h: 12 } as const;
/** The wall's plinth line, in the gable's plane: where the meter's conduit ends. */
export const PLINTH_V = MURAL_H - PLINTH * U;

export type Seg = readonly [Pt, Pt];

export interface LadderScene {
  /** The figure's box: its viewBox. */
  box: { x: number; y: number; w: number; h: number };
  grid: Seg[];
  plot: Pt[];
  /** The path from the door's step to the plot's front edge. */
  path: Pt[];
  rails: Seg[];
  rungs: { a: Pt; b: Pt; on: boolean; climbed: boolean }[];
  /** The rails from the ground up to the pick, redrawn in the spot ink. */
  climbed: Seg[];
  /** Where each held position's weight meets the right rail. */
  held: Pt[];
  /** The picked rung, its left end, its height in drawing units, the rung's run across, and the tag's point. */
  pick: { rung: LadderRung; at: Pt; run: number; span: Pt; tag: Pt } | null;
  meter: { matrix: string; corners: Pt[] };
  leaders: Seg[];
  /** The two detail marks: the meter's (band 01) and the ladder's (band 02). */
  bubbles: readonly [Pt, Pt];
  /** The room's plate, on the plot's front edge. */
  plate: Pt;
}

/** A rung's height on the wall, to scale: the 4.00x rung is RUNG_HIGH, the rest in proportion to their weight. */
export function rungZ(bps: number): number {
  return (RUNG_HIGH * bps) / MAX_BOOST_BPS;
}

/** A rail's point on the sheet at height z: side 0 the left rail. */
export function railAt(side: 0 | 1, z: number): Pt {
  return iso(railPoint(0, 0, side, z), U);
}

/** A held position's mark: a small square just right of its point on the right rail. */
export function heldMark(q: Pt): { x: number; y: number; size: number } {
  return { x: q[0] + 1.2, y: q[1] - 1.5, size: 3 };
}

/** A point of the gable wall's own plane (u across from its front corner, v down from the ridge's height), on the sheet. */
function gableAt(u: number, v: number): Pt {
  const [ox, oy] = iso([HOUSE_W, HOUSE_D, RIDGE], U);
  return [ox + COS30 * u, oy - SIN30 * u + v];
}

const FIXED: readonly { bps: number }[] = [{ bps: MIN_BOOST_BPS }, { bps: MAX_BOOST_BPS }];

export function ladderScene({ rungs, picked, held, tagRoom }: {
  /** What the staircase offers, as it published them; null before it has. */
  rungs: readonly LadderRung[] | null;
  picked: number | null;
  /** The wallet's positions as weights; null with no wallet or none read. */
  held: readonly number[] | null;
  tagRoom: number;
}): LadderScene {
  const corner = (x: number, y: number) => iso([x, y, 0], U);
  const plot = [corner(PLOT.x0, PLOT.y0), corner(PLOT.x1, PLOT.y0), corner(PLOT.x1, PLOT.y1), corner(PLOT.x0, PLOT.y1)];
  // The site's grid: a line each unit along both ground axes (the figure fades it toward its edge).
  const grid: Seg[] = [];
  for (let gx = -3; gx <= 7; gx++) grid.push([corner(gx, -3), corner(gx, 6)]);
  for (let gy = -3; gy <= 6; gy++) grid.push([corner(-3, gy), corner(7, gy)]);
  const doorX = DOOR.u / U;
  const path = [corner(doorX - 0.04, HOUSE_D + 0.24), corner(doorX + 0.6, HOUSE_D + 0.24), corner(doorX + 0.6, PLOT.y1), corner(doorX - 0.04, PLOT.y1)];

  const list: readonly { bps: number }[] = rungs ?? FIXED;
  const at = rungs && picked !== null && picked >= 0 && picked < rungs.length ? picked : null;
  const rails: Seg[] = ([0, 1] as const).map((side) => [railAt(side, 0), railAt(side, RAIL_TOP)] as const);
  const lines = list.map((r, i) => ({ a: railAt(0, rungZ(r.bps)), b: railAt(1, rungZ(r.bps)), on: at === i, climbed: at !== null && i < at }));
  // The rung's run across: the same at every height.
  const foot0 = railAt(0, 0);
  const foot1 = railAt(1, 0);
  const span: Pt = [foot1[0] - foot0[0], foot1[1] - foot0[1]];

  let pick: LadderScene['pick'] = null;
  let climbed: Seg[] = [];
  if (rungs && at !== null) {
    const rung = rungs[at]!;
    const z = rungZ(rung.bps);
    const top = railAt(0, z);
    pick = { rung, at: top, run: z * U, span, tag: [top[0] - DIM_OFF - 2.4, top[1]] };
    climbed = ([0, 1] as const).map((side) => [railAt(side, 0), railAt(side, z)] as const);
  }

  const mMid = gableAt(METER.u + METER.w, METER.v + METER.h / 2);
  const bub1: Pt = [mMid[0] + 15, mMid[1] - 13];
  const railTop = railAt(0, RAIL_TOP);
  const bub2: Pt = [railTop[0] - 12, railTop[1] - 16];
  const leaders: Seg[] = [[mMid, bub1], [[railTop[0] + span[0] / 2, railTop[1] + span[1] / 2 - 1], bub2]];
  const meterCorners = [
    gableAt(METER.u, METER.v), gableAt(METER.u + METER.w, METER.v),
    gableAt(METER.u + METER.w, PLINTH_V), gableAt(METER.u, PLINTH_V),
  ];

  // The box: the plot, the house to its ridge, the tag's room left of the measure, the marks' room.
  const xs = [...plot.map((p) => p[0]), foot0[0] - DIM_OFF - tagRoom, bub1[0] + 7];
  const ys = [...plot.map((p) => p[1]), iso([-OVER_GABLE, HOUSE_D / 2, RIDGE], U)[1] - 6, bub2[1] - 7];
  const x = Math.floor(Math.min(...xs) - 2);
  const y = Math.floor(Math.min(...ys) - 2);
  return {
    box: { x, y, w: Math.ceil(Math.max(...xs) + 2) - x, h: Math.ceil(Math.max(...ys) + 3) - y },
    grid,
    plot,
    path,
    rails,
    rungs: lines,
    climbed,
    held: (held ?? []).map((bps) => railAt(1, rungZ(bps))),
    pick,
    meter: { matrix: wallMatrix([HOUSE_W, HOUSE_D, RIDGE], '-y', U), corners: meterCorners },
    leaders,
    bubbles: [bub1, bub2],
    plate: corner(PLOT.x1 - 0.5, PLOT.y1 - 0.22),
  };
}
