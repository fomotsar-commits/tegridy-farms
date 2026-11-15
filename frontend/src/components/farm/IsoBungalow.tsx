import type { CSSProperties } from 'react';
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK, HEADING_FONT, mixHex } from '../../lib/editorial';
import { groundMatrix, iso, pts, solid, wallMatrix, type P3, type Pt } from '../../lib/iso';
import {
  DOOR, EAVE, FRONT_BAND, HOUSE_D, HOUSE_W, LABEL_GAP_PX, LABEL_PX, LABEL_Z, MURAL_H, PLINTH, RAIL_TOP, RIDGE, RISE,
  ROOF_LIFT, ROOF_THICK, U, chimneyBox, chimneyOutlines, houseOutline, railPoint, roofCorners, rungHeights,
} from '../../lib/isoBungalow';

/**
 * One bungalow of Earn's site model (owner, 2026-11-14: "use art from said bungalows to wrap
 * around brick style bungalows", "much much further go next level"): a brick house on its plot,
 * drawn as an architect's axonometric, with its room's own picture painted round its walls as a
 * mural.
 *
 * ⚠️ EVERY BUNGALOW IS THE SAME BUNGALOW. Same footprint, walls, door, windows and roof
 * (lib/isoBungalow.ts); every roof is the same slate until its house is lit. The model reads no
 * chain (IsoIsland.tsx says why), so a bigger, taller or brighter house would be a comparison
 * nobody made. What differs is only what the registry holds: the room's picture on the walls,
 * the room's colour on the ridge and the chimney, and whether a ladder leans on the wall.
 *
 * THE LADDER IS THE LOCK LADDER. A pool whose terms include one has a ladder against its front
 * wall, its rungs set out to scale from the contract's two constants (rungHeights), its top rung
 * always clear of the eave. A pool with no ladder has none. The key in the drawing's corner gives
 * the two ends' figures.
 *
 * THE PICTURE WRAPS THE HOUSE. The room's picture covers both walls the eye sees, laid in each
 * wall's own plane (lib/iso.ts wallMatrix). The brick courses are drawn over it there, and the
 * tiles in the roof's plane: a mural on brick, not a photo on a box.
 *
 * THE PICTURE IS THE ROOM'S OWN CROP. Each room set its picture's crop for its door card in the
 * hall (VenueDoors.tsx); the front wall shows that same crop, its subject between the ladder and
 * the door (lib/isoBungalow.ts muralFrame). The gable shows the picture again, as tall as the
 * gable, at the same object-position (gableFrame). The picture is drawn only once its size is
 * read, and fades in, so it never jumps on its wall; until then, or if it fails to load, the
 * walls are brick in the room's colour. A picture brighter than the rest is dimmed at rest
 * (`dim`), the dimming laid on the picture alone, so no house outshines another until its turn.
 *
 * LIT (its turn on the tour, or pointed at): the roof takes the room's colour, the door and the
 * windows burn and the light pool before the door brightens. LIFTED (pointed at, here or at its
 * row): the roof also lifts off along dashed guides, as an architect lifts the roof off a model,
 * showing the walls cut and the house lit inside; the chimney smokes and the coin is named above.
 * Unlit, the windows still burn low: the island at night.
 */

const WP = HOUSE_W * U;
const DP = HOUSE_D * U;
const HP = EAVE * U;
const RP = RISE * U;
const TP = MURAL_H;
const PP = PLINTH * U;
const LIFT = ROOF_LIFT * U;

const GLOW = '#ffd98a';
const STONE = mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.24);
const SLATE = mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.2);
const SLATE_EDGE = mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.12);

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)';

/**
 * The shapes every bungalow shares, defined once: the two walls' outlines as clips (the walls
 * are the same on every house, so one pair serves them all), the brick and the roof tiles, and
 * the light. `id` keeps two models on one page apart.
 */
export function BungalowDefs({ id }: { id: string }) {
  return (
    <>
      <clipPath id={`${id}-front`}>
        <rect x="0" y={RP} width={WP} height={HP} />
      </clipPath>
      <clipPath id={`${id}-gable`}>
        <polygon points={`0,${RP} ${DP / 2},0 ${DP},${RP} ${DP},${TP} 0,${TP}`} />
      </clipPath>
      {/* Running bond: a course every five pixels, the joints of one course over the middles of
          the next. Light joints, so the picture carries the wall. */}
      <pattern id={`${id}-brick`} width="10" height="10" patternUnits="userSpaceOnUse">
        <path d="M0 0.5H10M0 5.5H10" stroke={EDITORIAL_BG} strokeOpacity="0.42" strokeWidth="1" />
        <path d="M0 1.5H10M0 6.5H10" stroke={EDITORIAL_INK} strokeOpacity="0.16" strokeWidth="1" />
        <path d="M2.5 0.5V5.5M7.5 5.5V10.5" stroke={EDITORIAL_BG} strokeOpacity="0.32" strokeWidth="1" />
      </pattern>
      {/* No two bricks fire alike: a few a shade darker, a few a shade paler. */}
      <pattern id={`${id}-tone`} width="30" height="20" patternUnits="userSpaceOnUse">
        <rect x="2.5" y="0.5" width="10" height="5" fill={EDITORIAL_BG} fillOpacity="0.12" />
        <rect x="17.5" y="5.5" width="10" height="5" fill="#ffffff" fillOpacity="0.06" />
        <rect x="22.5" y="10.5" width="10" height="5" fill={EDITORIAL_BG} fillOpacity="0.09" />
        <rect x="7.5" y="15.5" width="10" height="5" fill="#ffffff" fillOpacity="0.05" />
      </pattern>
      {/* Slate, laid in the roof's own plane: small lapped tiles, each course's joints over the
          middles of the one above, only in the part each course leaves showing. */}
      <pattern id={`${id}-tiles`} width="8" height="7" patternUnits="userSpaceOnUse">
        <rect x="0" y="2.6" width="8" height="0.9" fill={EDITORIAL_BG} fillOpacity="0.45" />
        <rect x="0" y="6.1" width="8" height="0.9" fill={EDITORIAL_BG} fillOpacity="0.45" />
        <path d="M0 0.4H8M0 3.9H8" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="0.8" />
        <path d="M0.5 0.6V2.6M4.5 4.1V6.1" stroke={EDITORIAL_BG} strokeOpacity="0.22" strokeWidth="0.8" />
      </pattern>
      {/* Light down the roof: catching the sky at the ridge, in shadow at the eave. */}
      <linearGradient id={`${id}-slope`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
        <stop offset="0.45" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.3" />
      </linearGradient>
      {/* Under the eave's edge, where the roof shades the wall. */}
      <linearGradient id={`${id}-eave`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#000000" stopOpacity="0.45" />
        <stop offset="1" stopColor="#000000" stopOpacity="0" />
      </linearGradient>
      {/* Where a wall meets the ground the light cannot reach. */}
      <linearGradient id={`${id}-foot`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#000000" stopOpacity="0" />
        <stop offset="1" stopColor="#000000" stopOpacity="0.45" />
      </linearGradient>
      {/* The room lit from within: warm at the floor, dimmer up the walls. */}
      <linearGradient id={`${id}-inside`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={GLOW} stopOpacity="0.45" />
        <stop offset="1" stopColor={GLOW} stopOpacity="1" />
      </linearGradient>
      <radialGradient id={`${id}-bloom`}>
        <stop offset="0" stopColor={GLOW} stopOpacity="0.55" />
        <stop offset="1" stopColor={GLOW} stopOpacity="0" />
      </radialGradient>
      {/* A pool of lamplight on the ground. */}
      <radialGradient id={`${id}-pool`}>
        <stop offset="0" stopColor={GLOW} stopOpacity="1" />
        <stop offset="0.45" stopColor={GLOW} stopOpacity="0.35" />
        <stop offset="1" stopColor={GLOW} stopOpacity="0" />
      </radialGradient>
      {/* A wisp of smoke that thins to nothing at its edge. */}
      <radialGradient id={`${id}-puff`}>
        <stop offset="0" stopColor="#cfd6e2" stopOpacity="0.5" />
        <stop offset="1" stopColor="#cfd6e2" stopOpacity="0" />
      </radialGradient>
    </>
  );
}

/** An affine matrix for an SVG `transform` from two axes and an origin, all on the sheet. */
function planeMatrix(origin: Pt, along: Pt, down: Pt): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `matrix(${r(along[0])} ${r(along[1])} ${r(down[0])} ${r(down[1])} ${r(origin[0])} ${r(origin[1])})`;
}

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt) => Math.hypot(v[0], v[1]);
const unit = (v: Pt): Pt => [v[0] / len(v), v[1] / len(v)];

/** A transition that waits `delay` ms while lighting, so the light walks through the house; none while going dark. */
const lightUp = (lit: boolean, delay: number): CSSProperties => ({
  transition: 'fill 0.45s ease, fill-opacity 0.45s ease, opacity 0.45s ease',
  transitionDelay: lit ? `${delay}ms` : '0ms',
});

/** A window in a wall's plane: a soft light about it, a frame, its pane alight, a cross of glazing bars and a stone sill. */
function Window({ defs, x, y, size, lit, delay }: { defs: string; x: number; y: number; size: number; lit: boolean; delay: number }) {
  const half = size / 2;
  return (
    <g>
      <ellipse cx={x + half} cy={y + half} rx={size * 1.3} ry={size * 1.3} fill={`url(#${defs}-bloom)`} opacity={lit ? 1 : 0.3} style={lightUp(lit, delay)} />
      <rect x={x} y={y} width={size} height={size} fill={GLOW} fillOpacity={lit ? 1 : 0.42}
        stroke={EDITORIAL_INK} strokeOpacity="0.85" strokeWidth="1" style={lightUp(lit, delay)} />
      <path d={`M${x + half} ${y}V${y + size}M${x} ${y + half}H${x + size}`} stroke={EDITORIAL_BG} strokeOpacity="0.9" strokeWidth="0.9" />
      <rect x={x - 1.5} y={y + size} width={size + 3} height="1.8" fill={STONE} />
    </g>
  );
}

export interface MuralFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function IsoBungalow({ defs, x, y, art, frames, dim = 0, accent, lit, lifted, ladder, symbol }: {
  /** The id BungalowDefs was given. */
  defs: string;
  /** The plot's near corner on the plan. */
  x: number;
  y: number;
  /** The room's picture, on both walls. Without one the walls are brick in the room's colour. */
  art?: string;
  /**
   * Where the picture lies on each wall, in the wall's own plane (lib/isoBungalow.ts muralFrame
   * and gableFrame). Until its size is read there are none, and the walls are brick.
   */
  frames?: { front: MuralFrame; gable: MuralFrame } | null;
  /** How far a bright picture is dimmed at rest, 0 to 1 (IsoIsland.tsx restDim); lit, it shows at full strength. */
  dim?: number;
  /** The room's colour, `#rrggbb`: the ridge, the chimney, the brick under the picture, and the roof while lit. */
  accent: string;
  lit: boolean;
  /** Pointed at, here or at its row: the roof lifts off. */
  lifted: boolean;
  /** The pool's terms include the lock ladder. */
  ladder: boolean;
  /** Named over the lifted roof. */
  symbol: string;
}) {
  const p = (px: number, py: number, pz: number): Pt => iso([px, py, pz], U);
  const at = (c: P3) => iso(c, U);
  const edge = lit ? '#ffffff' : EDITORIAL_INK;
  const line = { stroke: edge, strokeOpacity: lit ? 0.9 : 0.5, strokeWidth: 1, strokeLinejoin: 'round' as const };
  const ease = { transition: 'opacity 0.5s ease, fill 0.5s ease, fill-opacity 0.5s ease' };
  const brickBase = mixHex(EDITORIAL_BG, accent, 0.42);
  // The picture on a wall, and its dimming at rest laid on the picture alone: one group, so the
  // two fade in together and the brick never darkens ahead of the picture.
  const mural = (frame: MuralFrame) => (
    <g className="iso-mural" data-mural="">
      <image href={art} {...frame} preserveAspectRatio="none" />
      {dim > 0 && <rect {...frame} fill={EDITORIAL_BG} fillOpacity={lit ? 0 : dim} style={ease} data-dim={dim.toFixed(2)} />}
    </g>
  );

  // The roof: its near slope from the ridge down past the eave (the far slope is turned away),
  // the verge down the gable end, and the eave's edge.
  const r = roofCorners(x, y);
  const drop = (c: P3): P3 => [c[0], c[1], c[2] - ROOF_THICK];
  const roofFill = lit ? mixHex(EDITORIAL_BG, accent, 0.92) : SLATE;
  const roofEdge = lit ? mixHex(EDITORIAL_BG, accent, 0.55) : SLATE_EDGE;
  // The near slope as a plane of its own, so its tiles are laid in it: one axis along the
  // ridge, the other down the slope, each a pixel long on the sheet.
  const [r0, r1, e0] = [at(r.ridgeL), at(r.ridgeR), at(r.eaveL)];
  const slopeW = len(sub(r1, r0));
  const slopeH = len(sub(e0, r0));
  const slope = planeMatrix(r0, unit(sub(r1, r0)), unit(sub(e0, r0)));

  // The chimney: brick in the room's colour, standing on both slopes, with a stone cap and a flue.
  const c = chimneyBox(x, y);
  const stackH = c.top - c.base;
  const cap = solid(c.cx - c.capOver, c.cy - c.capOver, c.size + 2 * c.capOver, c.size + 2 * c.capOver, c.cap, c.cap, U, c.top);
  const flue = solid(c.cx + 0.12, c.cy + 0.12, c.size - 0.24, c.size - 0.24, 0, 0, U, c.top + c.cap);
  const smokeAt = p(c.cx + c.size / 2, c.cy + c.size / 2, c.top + c.cap);
  const csz = c.size * U;
  // The stack's side in its own plane: across from its front edge, down from its top. Its front
  // half stops on the near slope, rising to the ridge; behind the ridge the near slope hides
  // everything below the ridge line, so its back half stops on that line.
  const ridgeDown = (c.top - RIDGE) * U;
  const stackSide: Pt[] = [[0, 0], [csz, 0], [csz, ridgeDown + csz / 2], [csz / 2, ridgeDown], [0, stackH * U]];
  const stackEdge: Pt[] = [[0, stackH * U], [0, 0], [csz, 0], [csz, ridgeDown + csz / 2]];

  // The door and the step before it; the light pools on the ground.
  const doorX = x + DOOR.u / U;
  const step = solid(doorX - 0.06, y + HOUSE_D, (DOOR.w + 2.4) / U, 0.24, 0.07, 0.07, U);

  const rungs = rungHeights();
  const rail = (side: 0 | 1, z: number) => at(railPoint(x, y, side, z));

  // Inside, seen through the open top while the roof is lifted: the floor, the back wall's
  // inner face and the far gable's. Always drawn: at rest the walls and the roof cover them, so
  // a roof coming back down never shows the house hollow.
  const inside = {
    floor: [p(x, y, 0), p(x + HOUSE_W, y, 0), p(x + HOUSE_W, y + HOUSE_D, 0), p(x, y + HOUSE_D, 0)],
    back: [p(x, y, EAVE), p(x + HOUSE_W, y, EAVE), p(x + HOUSE_W, y, 0), p(x, y, 0)],
    gable: [p(x, y, EAVE), p(x, y + HOUSE_D / 2, RIDGE), p(x, y + HOUSE_D, EAVE), p(x, y + HOUSE_D, 0), p(x, y, 0)],
  };
  // The walls' tops, cut, as a model shows them with its roof off.
  const cut = [
    [p(x, y + HOUSE_D, EAVE), p(x + HOUSE_W, y + HOUSE_D, EAVE), p(x + HOUSE_W, y + HOUSE_D / 2, RIDGE), p(x + HOUSE_W, y, EAVE), p(x, y, EAVE), p(x, y + HOUSE_D / 2, RIDGE), p(x, y + HOUSE_D, EAVE)],
  ];
  const glowAt = p(x + HOUSE_W / 2, y + HOUSE_D / 2, EAVE);
  // The roof's corners, for the guides it lifts along.
  const guides = [at(r.eaveL), at(r.eaveR), at(r.ridgeR), at(r.backR)];

  const [labelX, labelY] = p(x + HOUSE_W / 2, y + HOUSE_D / 2, RIDGE + ROOF_LIFT + LABEL_Z);
  const liftedRidgeY = p(x + HOUSE_W / 2, y + HOUSE_D / 2, RIDGE + ROOF_LIFT)[1];
  const roofMove = { transform: `translateY(${lifted ? -LIFT : 0}px)`, transition: `transform 0.65s ${lifted ? SPRING : EASE_OUT}` };

  return (
    <>
      <g pointerEvents="none">
        {/* Lamplight on the ground: before the door, and under the gable's window. */}
        <ellipse cx="0" cy="0" rx={1.5 * U} ry={0.6 * U} transform={groundMatrix([doorX + DOOR.w / U / 2, y + HOUSE_D + 0.5, 0], U)}
          fill={`url(#${defs}-pool)`} opacity={lit ? 0.6 : 0.22} style={lightUp(lit, 300)} data-pool-light="" />
        <ellipse cx="0" cy="0" rx={0.75 * U} ry={0.5 * U} transform={groundMatrix([x + HOUSE_W + 0.45, y + HOUSE_D - 0.55, 0], U)}
          fill={`url(#${defs}-pool)`} opacity={lit ? 0.32 : 0.12} style={lightUp(lit, 200)} />

        <g data-inside="">
          <polygon points={pts(inside.floor)} fill={mixHex(EDITORIAL_BG, GLOW, 0.55)} />
          <polygon points={pts(inside.back)} fill={EDITORIAL_BG} />
          <polygon points={pts(inside.back)} fill={`url(#${defs}-inside)`} />
          <polygon points={pts(inside.gable)} fill={EDITORIAL_BG} />
          <polygon points={pts(inside.gable)} fill={`url(#${defs}-inside)`} fillOpacity="0.8" />
        </g>
        {/* The roof's underside, seen at its open gable end while it is lifted. It rides with the
            roof, and is drawn before the walls, so the gable's peak and the cut stand in front of it. */}
        <polygon points={pts([at(r.ridgeR), at(drop(r.eaveR)), at(drop(r.backR))])} fill={mixHex(EDITORIAL_BG, accent, 0.22)} style={roofMove} data-underside="" />

        {/* The gable wall: the picture again, as tall as the gable, in shade, with a window by
            the corner and an oculus. */}
        <g transform={wallMatrix([x + HOUSE_W, y + HOUSE_D, RIDGE], '-y', U)} data-wall="gable">
          <g clipPath={`url(#${defs}-gable)`}>
            <rect x="0" y="0" width={DP} height={TP} fill={brickBase} />
            {art && frames && mural(frames.gable)}
            <rect x="0" y="0" width={DP} height={TP} fill={`url(#${defs}-tone)`} className="max-md:hidden" />
            <rect x="0" y="0" width={DP} height={TP} fill={`url(#${defs}-brick)`} className="max-md:hidden" />
            <rect x="0" y="0" width={DP} height={TP} fill={EDITORIAL_BG} fillOpacity={lit ? 0.12 : 0.24} style={ease} />
            <polyline points={`0,${RP} ${DP / 2},0 ${DP},${RP}`} fill="none" stroke="#000000" strokeOpacity="0.35" strokeWidth="12"
              opacity={lifted ? 0 : 1} style={ease} />
            <rect x="0" y={TP - PP - 9} width={DP} height="9" fill={`url(#${defs}-foot)`} />
            <rect x="0" y={TP - PP} width={DP} height={PP} fill={STONE} />
            <Window defs={defs} x={5} y={TP - DOOR.h} size={11} lit={lit} delay={120} />
            <circle cx={DP / 2} cy={RP - 7} r="3.3" fill={GLOW} fillOpacity={lit ? 0.95 : 0.35}
              stroke={EDITORIAL_INK} strokeOpacity="0.8" strokeWidth="1" style={lightUp(lit, 220)} />
          </g>
          <polygon points={`0,${RP} ${DP / 2},0 ${DP},${RP} ${DP},${TP} 0,${TP}`} fill="none" {...line} />
        </g>

        {/* The front wall: the picture at its door card's crop, and the door under its lintel by the corner. */}
        <g transform={wallMatrix([x, y + HOUSE_D, RIDGE], 'x', U)} data-wall="front">
          <g clipPath={`url(#${defs}-front)`}>
            <rect x="0" y={RP} width={WP} height={HP} fill={brickBase} />
            {art && frames && mural(frames.front)}
            <rect x="0" y={RP} width={WP} height={HP} fill={`url(#${defs}-tone)`} className="max-md:hidden" />
            <rect x="0" y={RP} width={WP} height={HP} fill={`url(#${defs}-brick)`} className="max-md:hidden" />
            <rect x="0" y={FRONT_BAND.top} width={WP} height="8" fill={`url(#${defs}-eave)`} opacity={lifted ? 0 : 1} style={ease} />
            <rect x="0" y={TP - PP - 9} width={WP} height="9" fill={`url(#${defs}-foot)`} />
            <rect x="0" y={TP - PP} width={WP} height={PP} fill={STONE} />
            <rect x={DOOR.u - 1.5} y={TP - DOOR.h - 3} width={DOOR.w + 3} height="2.4" fill={STONE} />
            <rect x={DOOR.u} y={TP - DOOR.h} width={DOOR.w} height={DOOR.h} fill={lit ? GLOW : EDITORIAL_BG} fillOpacity={lit ? 1 : 0.9}
              stroke={EDITORIAL_INK} strokeOpacity="0.8" strokeWidth="1" style={lightUp(lit, 0)} />
            {!lit && <circle cx={DOOR.u + DOOR.w - 2.5} cy={TP - DOOR.h / 2} r="0.9" fill={EDITORIAL_INK} fillOpacity="0.85" />}
          </g>
          <rect x="0" y={RP} width={WP} height={HP} fill="none" {...line} />
        </g>

        {/* The step before the door. */}
        <polygon points={pts(step.right)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.14)} {...line} strokeOpacity={0.35} />
        <polygon points={pts(step.left)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.2)} {...line} strokeOpacity={0.35} />
        <polygon points={pts(step.top)} fill={lit ? mixHex(STONE, GLOW, 0.5) : STONE} {...line} strokeOpacity={0.35} style={ease} />

        {ladder && (
          <g data-ladder="" stroke={EDITORIAL_INK} strokeOpacity={lit ? 1 : 0.85} strokeLinecap="round">
            {([0, 1] as const).map((side) => {
              const foot = rail(side, 0);
              const head = rail(side, RAIL_TOP);
              return <line key={side} x1={foot[0]} y1={foot[1]} x2={head[0]} y2={head[1]} strokeWidth="1.4" />;
            })}
            {rungs.map((z) => {
              const a = rail(0, z);
              const b = rail(1, z);
              return <line key={z} data-rung={z.toFixed(4)} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} strokeWidth="1.1" />;
            })}
          </g>
        )}

        {/* With the roof off: the walls' tops cut, the light spilling out of the gap, and the
            guides the roof lifts along at its corners. */}
        {lifted && (
          <g data-cut="">
            {cut.map((ring, i) => (
              <polyline key={i} points={pts(ring)} fill="none" stroke={EDITORIAL_INK} strokeOpacity="0.9" strokeWidth="2.4" strokeLinejoin="miter" strokeLinecap="square" />
            ))}
            <ellipse cx={glowAt[0]} cy={glowAt[1] - LIFT / 2} rx={WP * 0.95} ry={LIFT * 1.5} fill={`url(#${defs}-bloom)`} style={{ mixBlendMode: 'screen' }} />
            <g stroke={EDITORIAL_INK} strokeOpacity="0.6" strokeWidth="1" strokeDasharray="2 3" className="iso-label">
              {guides.map(([gx, gy]) => <line key={`${gx}:${gy}`} x1={gx} y1={gy} x2={gx} y2={gy - LIFT} />)}
            </g>
          </g>
        )}

        {/* The roof and the chimney on it, lifted off while pointed at. */}
        <g data-roof="" style={roofMove}>
          <polygon points={pts([at(r.backR), at(r.ridgeR), at(r.eaveR), at(drop(r.eaveR)), at(drop(r.ridgeR)), at(drop(r.backR))])} fill={roofEdge} {...line} style={ease} />
          <polygon points={pts([at(r.eaveL), at(r.eaveR), at(drop(r.eaveR)), at(drop(r.eaveL))])} fill={roofEdge} {...line} style={ease} />
          <g transform={slope}>
            <rect x="0" y="0" width={slopeW} height={slopeH} fill={roofFill} style={ease} data-slope="" />
            <rect x="0" y="0" width={slopeW} height={slopeH} fill={`url(#${defs}-tiles)`} className="max-md:hidden" />
            <rect x="0" y="0" width={slopeW} height={slopeH} fill={`url(#${defs}-slope)`} />
            <rect x="0" y="0" width={slopeW} height={slopeH} fill="none" {...line} />
          </g>
          <line x1={r0[0]} y1={r0[1]} x2={r1[0]} y2={r1[1]} stroke={mixHex(accent, '#ffffff', 0.2)} strokeWidth="3" strokeLinecap="round" data-ridge="" />

          {/* The stack's front face, then its side, whose foot follows the two slopes up to the ridge and down again. */}
          <g transform={wallMatrix([c.cx, c.cy + c.size, c.top], 'x', U)}>
            <rect x="0" y="0" width={csz} height={stackH * U} fill={mixHex(EDITORIAL_BG, accent, 0.46)} />
            <rect x="0" y="0" width={csz} height={stackH * U} fill={`url(#${defs}-brick)`} className="max-md:hidden" />
            <rect x="0" y="0" width={csz} height={stackH * U} fill="none" {...line} />
          </g>
          <g transform={wallMatrix([c.cx + c.size, c.cy + c.size, c.top], '-y', U)}>
            <polygon points={pts(stackSide)} fill={mixHex(EDITORIAL_BG, accent, 0.3)} />
            <polygon points={pts(stackSide)} fill={`url(#${defs}-brick)`} className="max-md:hidden" />
            <polyline points={pts(stackEdge)} fill="none" {...line} />
          </g>
          <polygon points={pts(cap.right)} fill={mixHex(STONE, EDITORIAL_BG, 0.4)} {...line} strokeOpacity={0.4} />
          <polygon points={pts(cap.left)} fill={mixHex(STONE, EDITORIAL_BG, 0.25)} {...line} strokeOpacity={0.4} />
          <polygon points={pts(cap.top)} fill={mixHex(STONE, EDITORIAL_INK, 0.2)} {...line} strokeOpacity={0.4} />
          <polygon points={pts(flue.top)} fill={EDITORIAL_BG} />
          {lifted && (
            <g data-smoke="">
              {[0, 1, 2, 3].map((i) => (
                <circle key={i} className="iso-smoke" cx={smokeAt[0]} cy={smokeAt[1]} r={3 + i * 0.9} fill={`url(#${defs}-puff)`} style={{ animationDelay: `${i * 0.5}s` }} />
              ))}
            </g>
          )}
        </g>

        {lifted && (
          <g className="iso-label max-md:hidden" data-label="">
            <line x1={labelX} y1={liftedRidgeY - 4} x2={labelX} y2={labelY - 2} stroke={EDITORIAL_GREEN} strokeWidth="1" />
            <text x={labelX} y={labelY - LABEL_GAP_PX} textAnchor="middle" fontSize={LABEL_PX} fontWeight="900" letterSpacing="-0.03em" fill="#ffffff" style={HEADING_FONT} className="max-md:hidden"
              stroke={EDITORIAL_BG} strokeOpacity="0.9" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke">
              {symbol}
            </text>
          </g>
        )}
      </g>
      {/* The shapes that take the pointer: the house, and its chimney's stack and cap, as they
          stand with the roof on, so they never move under the pointer. */}
      <polygon points={pts(houseOutline(x, y))} fill="none" pointerEvents="all" data-hit="" />
      {chimneyOutlines(x, y).map((poly, i) => (
        <polygon key={i} points={pts(poly)} fill="none" pointerEvents="all" data-hit={i === 0 ? 'chimney' : 'cap'} />
      ))}
    </>
  );
}

