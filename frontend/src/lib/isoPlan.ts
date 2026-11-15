// Earn's site model laid out: one street per chain, a road in front of each with the chain's name
// painted on it, and the drawing's bounds (components/farm/IsoIsland.tsx draws it).
//
// Pure, so its promises can be measured (isoPlan.test.ts): at rest and on the tour, every rung
// of every ladder stays in view, and every street's name lies on its own road. A house pointed at
// lifts its roof and shows its name, and for as long as it is pointed at those may stand over
// the ladder of the house behind it: one house at a time, by the visitor's own hand.
import { CHAIN_LABEL, hasLadder, type VenuePoolRow } from './venuePools';
import { bounds, iso, type Pt } from './iso';
import { HOUSE_D, HOUSE_W, RAIL_TOP, U, bungalowBox } from './isoBungalow';

/** Between two houses on a street: detached, with room for the light between them. */
export const GAP_X = 0.85;
/**
 * Between streets: the ladders' feet, the road, and the kerb of the next street's plots. Deep
 * enough that at rest no house in front stands between the eye and a ladder behind it
 * (isoPlan.test.ts).
 */
export const GAP_Y = 3.1;
export const PAD = 0.3;
/** The road in front of each street, measured from the front walls. */
export const ROAD_FROM = 0.95;
export const ROAD_TO = 2.25;
/** How far the site's grid runs past the streets. */
export const EDGE = 0.7;
/** A street's name, painted on its road: about this many units a letter, in the mono face at 11.5 px. */
export const LETTER = 0.44;
export const NAME_PX = 11.5;
/** The turning circle at a road's end. */
export const TURN = 0.9;

export interface Plot {
  row: VenuePoolRow;
  ladder: boolean;
  x: number;
  y: number;
}

export interface Street {
  chain: string;
  name: string;
  y: number;
  length: number;
  plots: Plot[];
  /** Where along the road its name starts: past the end of every street standing in front of it. */
  nameAt: number;
  nameTo: number;
  /** The road's far end, where its turning circle stands. */
  roadEnd: number;
}

/** The plan: one street per chain, the longest at the back, so each street's name has open road to lie on. */
export function planStreets(rows: readonly VenuePoolRow[]): Street[] {
  const byChain = new Map<string, VenuePoolRow[]>();
  for (const row of rows) byChain.set(row.chain, [...(byChain.get(row.chain) ?? []), row]);
  const ordered = [...byChain.entries()].sort((a, b) => b[1].length - a[1].length);
  const lengthOf = (list: VenuePoolRow[]) => list.length * HOUSE_W + (list.length - 1) * GAP_X;
  return ordered.map(([chain, list], i) => {
    const y = i * (HOUSE_D + GAP_Y);
    // A house stands between the eye and the road behind it, so a street's name starts where
    // the streets in front of it end.
    const nameAt = Math.max(-PAD, ...ordered.slice(i + 1).map(([, front]) => lengthOf(front) + 0.8));
    const name = CHAIN_LABEL[chain] ?? chain;
    const nameTo = nameAt + name.length * LETTER;
    const length = lengthOf(list);
    return {
      chain,
      name,
      y,
      length,
      plots: list.map((row, j) => ({ row, ladder: hasLadder(row.terms), x: j * (HOUSE_W + GAP_X), y })),
      nameAt,
      nameTo,
      roadEnd: Math.max(length, nameTo) + 0.6 + TURN,
    };
  });
}

/** A street's road on the plan: its two edges and its middle, across. */
export function roadOf(s: Street) {
  const y0 = s.y + HOUSE_D + ROAD_FROM;
  const y1 = s.y + HOUSE_D + ROAD_TO;
  return { y0, y1, mid: (y0 + y1) / 2 };
}

/** The ground the plan stands on: every plot and road, and EDGE round them. */
export function groundOf(streets: readonly Street[]) {
  const far = Math.max(0, ...streets.map((s) => s.roadEnd + TURN));
  const deep = streets.length ? roadOf(streets[streets.length - 1]!).y1 : HOUSE_D;
  return { x0: -EDGE, y0: -EDGE, x1: far + EDGE, y1: deep + EDGE };
}

/** The drawing's width over its height, for a page that sizes it by the screen's height. */
export function planAspect(rows: readonly VenuePoolRow[]): number {
  const { box } = planBox(planStreets(rows));
  return box.w / box.h;
}

/**
 * The key's size on the sheet: a caption, then a small ladder with its two figures to its left.
 * Where the drawing is drawn small its words are drawn up to `scaleMax` times their size, so
 * they read at about the same size on the screen (IsoIsland.tsx); the ladder is always to the
 * houses' scale.
 */
export const KEY = { width: 104, captionPx: 10, figurePx: 11, gapPx: 10, ladderPx: RAIL_TOP * U, scaleMax: 1.5 } as const;

/** Where the key's ladder stands, under its caption, with its words `k` times their size. */
export function keyFoot(top: number, k: number): number {
  return top + KEY.captionPx * k + KEY.gapPx + KEY.ladderPx;
}

/** The ground the key takes on the sheet, with its words `k` times their size: [x0, y0, x1, y1]. */
export function keyBox(key: { right: number; top: number }, k: number): readonly [number, number, number, number] {
  return [key.right - KEY.width * k, key.top, key.right, keyFoot(key.top, k) + 3 * k];
}

/**
 * The drawing's bounds on the sheet, with room in its top right corner for the key: that corner
 * is open ground, since the back street runs down and away to the right from its top left.
 */
export function planBox(streets: readonly Street[]) {
  const g = groundOf(streets);
  const ground: Pt[] = [iso([g.x0, g.y0, 0], U), iso([g.x1, g.y0, 0], U), iso([g.x1, g.y1, 0], U), iso([g.x0, g.y1, 0], U)];
  const houses = streets.flatMap((s) => s.plots.flatMap((p) => bungalowBox(p.x, p.y)));
  const [bx, by, bw, bh] = bounds([...ground, ...houses]);
  const box = { x: Math.floor(bx - 4), y: Math.floor(by - 6), w: Math.ceil(bw + 8), h: Math.ceil(bh + 10) };
  // The key's top right corner. It draws its words larger where the drawing is drawn small, up
  // to KEY.scaleMax; isoPlan.test.ts checks the corner holds it at that size (keyBox).
  const key = { right: box.x + box.w - 8, top: box.y + 8 };
  return { box, key };
}
