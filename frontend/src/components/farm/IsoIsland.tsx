import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { MAX_BOOST_BPS, MAX_LOCK_DURATION, MIN_BOOST_BPS, MIN_LOCK_DURATION } from '../../lib/constants';
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK, HEADING_FONT, mixHex } from '../../lib/editorial';
import { bounds, groundMatrix, iso, pts, solid, type Pt } from '../../lib/iso';
import { CHAIN_LABEL, hasLadder, type VenuePoolRow } from '../../lib/venuePools';

/**
 * Earn's site model (owner, 2026-11-14: "avantegarde edition 5d architect vibes"): every pool on
 * the island as a block on a site plan, drawn as an architect's axonometric, one street per chain.
 *
 * ⚠️ IT DRAWS ONLY WHAT THE REGISTRY KNOWS, TO SCALE. The list beside it reads no chain
 * (VenuePoolIndex.tsx says why), so neither does this: a block's shape is its pool's program, never
 * a rate, a balance or a size. A pool with the lock ladder is a ramp whose section is the ladder
 * itself: its run is the lock, seven days to four years, and its rise is the share that lock earns,
 * from the floor to the ceiling, both from the contract's constants (as lib/poolShape.ts words
 * them). A pool with no ladder is a flat slab one share high. Nothing here can be read as "this
 * pool pays more": every ramp is the same ramp.
 *
 * A picture, not a control: it is hidden from assistive tech, and every pool it shows is a row
 * with a real link in the schedule under it. Pointing at a block lights its row there and the
 * other way round (`active`); a press on a block opens its pool for a pointer's convenience.
 * Left alone it lights each pool in turn, and holds still under reduced motion or off screen.
 */

/** Pixels per unit on the sheet. */
const U = 20;
/** A block's footprint along its street (x) and across it (y). */
const W = 2.1;
const D = 1.7;
const GAP_X = 0.55;
/** Between streets: room for the chain's name on the ground, clear of the street in front. */
const GAP_Y = 2.1;
/** Units of height per 1.00× of share. */
const RISE = 0.8;
const PAD = 0.3;
/** How far the site's grid runs past the streets. */
const EDGE = 0.9;

const LADDER_LO = (MIN_BOOST_BPS / 10_000) * RISE;
const LADDER_HI = (MAX_BOOST_BPS / 10_000) * RISE;
const SLAB = 1 * RISE;

const FLOOR_LABEL = `${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`;
const CEILING_LABEL = `${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`;
const SHORT_LOCK = `${Math.round(MIN_LOCK_DURATION / 86_400)}d`;
const LONG_LOCK = `${Math.round(MAX_LOCK_DURATION / (365 * 86_400))}y`;

const MONO = { fontFamily: 'var(--font-family-mono)' } as const;

interface Block {
  row: VenuePoolRow;
  ladder: boolean;
  x: number;
  y: number;
}

interface Street {
  chain: string;
  y: number;
  length: number;
  blocks: Block[];
  /** Where along the street its name starts: past the end of any ramps standing in front of it. */
  nameAt: number;
}

/**
 * The plan: one street per chain, the tallest at the back so no street hides another, and the
 * longer of two equals behind the shorter.
 */
function planStreets(rows: readonly VenuePoolRow[]): Street[] {
  const byChain = new Map<string, VenuePoolRow[]>();
  for (const row of rows) byChain.set(row.chain, [...(byChain.get(row.chain) ?? []), row]);
  const height = (list: VenuePoolRow[]) => (list.some((r) => hasLadder(r.terms)) ? LADDER_HI : SLAB);
  const ordered = [...byChain.entries()].sort((a, b) => height(b[1]) - height(a[1]) || b[1].length - a[1].length);
  const lengthOf = (list: VenuePoolRow[]) => list.length * W + (list.length - 1) * GAP_X;
  return ordered.map(([chain, list], i) => {
    const y = i * (D + GAP_Y);
    // A ramp is tall enough to stand between the eye and the ground behind it, so a street's name
    // starts where the ramps in front of it end. A slab is too low to hide it.
    const hidden = Math.max(-PAD, ...ordered.slice(i + 1).filter(([, front]) => front.some((r) => hasLadder(r.terms))).map(([, front]) => lengthOf(front) + 0.8));
    return {
      chain,
      y,
      length: lengthOf(list),
      blocks: list.map((row, j) => ({ row, ladder: hasLadder(row.terms), x: j * (W + GAP_X), y })),
      nameAt: hidden,
    };
  });
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Each pool in turn while nobody points at one: still under reduced motion, off screen, or in a hidden tab. */
function useTour(ids: readonly string[], on: boolean, host: RefObject<SVGSVGElement | null>): string | null {
  const [at, setAt] = useState<number | null>(null);
  const count = ids.length;
  useEffect(() => {
    if (!on || count === 0 || prefersReducedMotion()) return;
    let seen = typeof IntersectionObserver !== 'function';
    const watch = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => { seen = entries.some((e) => e.isIntersecting); })
      : null;
    if (host.current) watch?.observe(host.current);
    const t = setInterval(() => {
      if (!seen || document.hidden) return;
      setAt((i) => ((i ?? -1) + 1) % count);
    }, 2400);
    return () => {
      clearInterval(t);
      watch?.disconnect();
    };
  }, [on, count, host]);
  return on && at !== null ? ids[at] ?? null : null;
}

export function IsoIsland({ rows, active, onActive, onOpen, className = '' }: {
  rows: readonly VenuePoolRow[];
  /** The pool a row is pointed at, by id; it lights here. */
  active?: string | null;
  onActive?: (id: string | null) => void;
  onOpen?: (id: string) => void;
  className?: string;
}) {
  // Letters and digits only: the id is used inside `url(#…)`, where React's own marks are not safe everywhere.
  const fade = `iso${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const host = useRef<SVGSVGElement>(null);
  const streets = planStreets(rows);
  const blocks = streets.flatMap((s) => s.blocks);
  const toured = useTour(blocks.map((b) => b.row.id), !active, host);
  const lit = active ?? toured;

  const shape = (b: Block) => (b.ladder ? solid(b.x, b.y, W, D, LADDER_LO, LADDER_HI, U) : solid(b.x, b.y, W, D, SLAB, SLAB, U));
  const shapes = blocks.map((b) => ({ b, s: shape(b) }));

  // The ladder that carries the measures: the back street's last ramp, whose tall end nothing stands beside.
  const measured = streets.find((s) => s.blocks.some((b) => b.ladder))?.blocks.filter((b) => b.ladder).at(-1) ?? null;

  const maxX = Math.max(0, ...streets.map((s) => s.length));
  const maxY = streets.length ? streets[streets.length - 1]!.y + D : D;
  const ground: Pt[] = [
    iso([-EDGE, -EDGE, 0], U), iso([maxX + EDGE, -EDGE, 0], U),
    iso([maxX + EDGE, maxY + EDGE + 0.9, 0], U), iso([-EDGE, maxY + EDGE + 0.9, 0], U),
  ];
  const [bx, by, bw, bh] = bounds([...ground, ...shapes.flatMap(({ s }) => [...s.top, ...s.left, ...s.right])]);
  // Room for a lit block's name above it and the measures to its right.
  const box = { x: Math.floor(bx - 6), y: Math.floor(by - 34), w: Math.ceil(bw + 62), h: Math.ceil(bh + 44) };

  // The site's grid: a line each unit along both ground axes, fading toward the sheet's edge.
  const grid: [Pt, Pt][] = [];
  for (let gx = Math.ceil(-EDGE); gx <= maxX + EDGE; gx++) grid.push([iso([gx, -EDGE, 0], U), iso([gx, maxY + EDGE + 0.9, 0], U)]);
  for (let gy = Math.ceil(-EDGE); gy <= maxY + EDGE + 0.9; gy++) grid.push([iso([-EDGE, gy, 0], U), iso([maxX + EDGE, gy, 0], U)]);

  return (
    <svg
      ref={host}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      aria-hidden="true"
      data-testid="earn-site-model"
      className={`block w-full h-auto select-none ${className}`}
      onMouseLeave={() => onActive?.(null)}
    >
      <defs>
        <radialGradient id={`${fade}-g`} cx="50%" cy="55%" r="55%">
          <stop offset="55%" stopColor="#fff" stopOpacity="1" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={`${fade}-m`} maskUnits="userSpaceOnUse" x={box.x} y={box.y} width={box.w} height={box.h}>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${fade}-g)`} />
        </mask>
      </defs>

      <g mask={`url(#${fade}-m)`} stroke={EDITORIAL_INK} strokeOpacity="0.09" strokeWidth="1" vectorEffect="non-scaling-stroke">
        {grid.map(([a, b], i) => <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} vectorEffect="non-scaling-stroke" />)}
      </g>

      {streets.map((s) => {
        const plot: Pt[] = [
          iso([-PAD, s.y - PAD, 0], U), iso([s.length + PAD, s.y - PAD, 0], U),
          iso([s.length + PAD, s.y + D + PAD, 0], U), iso([-PAD, s.y + D + PAD, 0], U),
        ];
        return (
          <g key={s.chain}>
            <polygon points={pts(plot)} fill={EDITORIAL_BG} fillOpacity="0.55" stroke={EDITORIAL_INK} strokeOpacity="0.28" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {/* The street's name, lying on the ground along it, as a site plan letters a road. */}
            <text transform={groundMatrix([s.nameAt, s.y + D + PAD + 0.66, 0], U)} fontSize="11.5" letterSpacing="0.16em"
              fill={EDITORIAL_INK} fillOpacity="0.6" style={{ ...MONO, textTransform: 'uppercase' }} className="max-md:hidden">
              {CHAIN_LABEL[s.chain] ?? s.chain}
            </text>
          </g>
        );
      })}

      {shapes.map(({ b, s }) => {
        const on = lit === b.row.id;
        const accent = b.row.accent ?? EDITORIAL_GREEN;
        const edge = on ? '#ffffff' : EDITORIAL_INK;
        const face = { stroke: edge, strokeOpacity: on ? 0.95 : 0.5, strokeWidth: 1, strokeLinejoin: 'round' as const, vectorEffect: 'non-scaling-stroke' as const, style: { transition: 'fill 0.45s ease, stroke-opacity 0.45s ease' } };
        const [tx, ty, tw] = bounds(s.top);
        return (
          <g key={b.row.id} data-pool={b.row.id} data-lit={on ? '' : undefined}
            onMouseEnter={() => onActive?.(b.row.id)} onClick={() => onOpen?.(b.row.id)}
            style={{ cursor: onOpen ? 'pointer' : undefined, transform: on ? 'translateY(-7px)' : 'translateY(0px)', transition: 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)' }}>
            <polygon points={pts(s.right)} fill={mixHex(EDITORIAL_BG, accent, on ? 0.38 : 0.1)} {...face} />
            <polygon points={pts(s.left)} fill={mixHex(EDITORIAL_BG, accent, on ? 0.6 : 0.2)} {...face} />
            <polygon points={pts(s.top)} fill={mixHex(EDITORIAL_BG, accent, on ? 0.95 : 0.36)} {...face} />
            {on && (
              <g className="iso-label max-md:hidden" pointerEvents="none">
                <line x1={tx + tw / 2} y1={ty - 4} x2={tx + tw / 2} y2={ty - 20} stroke={EDITORIAL_GREEN} strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <text x={tx + tw / 2} y={ty - 26} textAnchor="middle" fontSize="16" fontWeight="900" letterSpacing="-0.03em" fill="#ffffff" style={HEADING_FONT}>
                  {b.row.symbol}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {measured && <Measures block={measured} />}
    </svg>
  );
}

/**
 * The ladder's own figures on one ramp, set out as a dimension: the lock along its run and the
 * share up its tall end, from the same constants the rows' terms are worded from.
 */
function Measures({ block }: { block: Block }) {
  const lowFoot = iso([block.x, block.y + D, 0], U);
  const highFoot = iso([block.x + W, block.y + D, 0], U);
  const post = iso([block.x + W, block.y, 0], U);
  const x = post[0] + 12;
  const top = post[1] - LADDER_HI * U;
  const floor = post[1] - LADDER_LO * U;
  const line = { stroke: EDITORIAL_INK, strokeOpacity: 0.7, strokeWidth: 1, vectorEffect: 'non-scaling-stroke' as const };
  const label = { fontSize: 11.5, fill: EDITORIAL_INK, fillOpacity: 0.8, style: MONO };
  return (
    <g className="max-md:hidden" pointerEvents="none">
      <line x1={x} y1={post[1]} x2={x} y2={top} {...line} />
      {[post[1], floor, top].map((y) => <line key={y} x1={x - 4} y1={y} x2={x + 4} y2={y} {...line} />)}
      <text x={x + 9} y={top + 4} {...label}>{CEILING_LABEL}</text>
      <text x={x + 9} y={floor + 1} {...label}>{FLOOR_LABEL}</text>
      <text x={lowFoot[0] - 2} y={lowFoot[1] + 15} textAnchor="middle" {...label}>{SHORT_LOCK}</text>
      <text x={highFoot[0] + 2} y={highFoot[1] + 15} textAnchor="middle" {...label}>{LONG_LOCK}</text>
    </g>
  );
}
