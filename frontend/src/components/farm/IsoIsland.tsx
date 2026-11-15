import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { BUNGALOWS } from '../../lib/bungalows';
import { MAX_BOOST_BPS, MAX_LOCK_DURATION, MIN_BOOST_BPS, MIN_LOCK_DURATION } from '../../lib/constants';
import { doorArt } from '../../lib/doorArt';
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK, mixHex } from '../../lib/editorial';
import { groundMatrix, iso, pts, type Pt } from '../../lib/iso';
import { HOUSE_D, MURAL_ACROSS, RAIL_GAP, RAIL_TOP, U, gableFrame, muralFrame, rungHeights } from '../../lib/isoBungalow';
import { muralSrc, muralWidth, pictureFacts, restDim, usePictures, type PictureFacts } from '../../lib/isoMural';
import { KEY, NAME_PX, PAD, TURN, groundOf, keyFoot, planBox, planStreets, roadOf } from '../../lib/isoPlan';
import type { VenuePoolRow } from '../../lib/venuePools';
import { BungalowDefs, IsoBungalow } from './IsoBungalow';

/**
 * Earn's site model (owner, 2026-11-14: "avantegarde edition 5d architect vibes", then "use art
 * from said bungalows to wrap around brick style bungalows ... much much further go next level"):
 * every pool on the island as a brick bungalow on a site plan, drawn as an architect's
 * axonometric, one street per chain, each house wearing its own room's picture on both its
 * walls (IsoBungalow.tsx; the plan is lib/isoPlan.ts).
 *
 * ⚠️ IT DRAWS ONLY WHAT THE REGISTRY KNOWS. The list beside it reads no chain (VenuePoolIndex.tsx
 * says why), so neither does this: a house says which room it is (its picture, its colour), which
 * chain it is on (its street) and whether its pool has the lock ladder (a ladder on its wall),
 * never a rate, a balance or a size. Every house is the same house, so nothing here can be read
 * as "this pool pays more". One thing is to scale: the ladder's rungs, from the floor of its
 * share to the ceiling; the key in the top right corner gives those two figures, from the
 * contract's constants (as lib/poolShape.ts words them), beside a ladder drawn to the same scale.
 *
 * A picture, not a control: it is hidden from assistive tech, and every pool it shows is a row
 * with a real link in the schedule under it. Pointing at a house lights its row there and the
 * other way round (`active`), and lifts its roof; a press on a house opens its pool for a
 * pointer's convenience. Left alone it lights each house in turn without lifting a roof, and
 * holds still under reduced motion or off screen.
 */

const FLOOR_LABEL = `${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`;
const CEILING_LABEL = `${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`;
const SHORT_LOCK = `${Math.round(MIN_LOCK_DURATION / 86_400)}d`;
const LONG_LOCK = `${Math.round(MAX_LOCK_DURATION / (365 * 86_400))}y`;

const MONO = { fontFamily: 'var(--font-family-mono)' } as const;

/** The room's picture and its own crop, at a given copy's width (lib/isoMural.ts). */
function muralOf(roomId: string, want: 128 | 480): { src: string; position?: string } | null {
  const room = BUNGALOWS.find((b) => b.id === roomId);
  if (!room) return null;
  const door = doorArt(room);
  if (!door?.src) return null;
  return { src: muralSrc(door.src, want, import.meta.env.PROD), position: door.objectPosition };
}

/**
 * How wide the drawing is drawn on the screen: `now` in CSS pixels, and `first` in device pixels
 * at its first measure (0 until then). The key's words are sized by `now`; the copy of each
 * picture the walls take, by `first`, so it is chosen once per page view. Measured once as it
 * mounts, since a browser that is not drawing frames (a hidden pane, a tab still in the
 * background) reads a size but never reports a resize, and again on every resize after.
 */
function useDrawnWidth(host: RefObject<SVGSVGElement | null>): { now: number; first: number } {
  const [drawn, setDrawn] = useState({ now: 0, first: 0 });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const px = el.getBoundingClientRect().width;
      if (px > 0) {
        setDrawn((d) => (d.now === px ? d : { now: px, first: d.first || px * (window.devicePixelRatio || 1) }));
      }
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [host]);
  return drawn;
}

/**
 * The copy of each picture the walls take first (lib/isoMural.ts muralWidth), from the device
 * pixels a picture spans on the front wall at the drawing's first measure. Null until then, so
 * no picture is fetched at a guessed size; where the drawing cannot be measured, the 480.
 */
function pictureCopy(firstDevicePx: number, unitsWide: number): 128 | 480 | null {
  if (firstDevicePx > 0) return muralWidth((MURAL_ACROSS * firstDevicePx) / unitsWide);
  return typeof ResizeObserver === 'function' ? null : 480;
}

/** A picture's size and lightness where read; null while it loads, where it failed, or where none was asked for. */
function readFacts(src: string | undefined): PictureFacts | null {
  const facts = src ? pictureFacts(src) : undefined;
  return facts && facts !== 'failed' ? facts : null;
}

/**
 * The picture on a house's walls: the copy chosen for the front wall and, where that is the 128
 * and the picture's widest wall turns out to need more (the gable lays a wide picture wider than
 * the front does), the 480 too, shown once it is read. `perUnit` is device pixels per unit of
 * the drawing at its first measure. Every copy it may show is in `srcs`, for the store to read.
 */
function wallPicture(roomId: string, want: 128 | 480 | null, perUnit: number) {
  const first = want ? muralOf(roomId, want) : null;
  if (!first) return { srcs: [] as string[], position: undefined, shown: null };
  const firstFacts = readFacts(first.src);
  const widest = firstFacts
    ? Math.max(muralFrame(firstFacts, first.position).width, gableFrame(firstFacts, first.position).width)
    : 0;
  const larger = want === 128 && widest > 0 && muralWidth(widest * perUnit) === 480 ? muralOf(roomId, 480) : null;
  const largerFacts = readFacts(larger?.src);
  const shown = larger && largerFacts ? { src: larger.src, facts: largerFacts } : firstFacts ? { src: first.src, facts: firstFacts } : null;
  return { srcs: larger ? [first.src, larger.src] : [first.src], position: first.position, shown };
}

/**
 * How many of the drawing's units one CSS pixel is, so the key's words keep their size when the
 * drawing is drawn small (an upright iPad, a short laptop screen). Never below one: on a large
 * screen the words grow with the drawing like everything else. Never above KEY.scaleMax, the
 * size its corner is measured to hold (lib/isoPlan.ts keyBox).
 */
function wordScale(drawnPx: number, unitsWide: number): number {
  if (drawnPx <= 0) return 1;
  return Math.min(KEY.scaleMax, Math.max(1, Math.round((unitsWide / drawnPx) * 100) / 100));
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
  /** The pool pointed at, here or at its row, by id: it lights, and its roof lifts. */
  active?: string | null;
  onActive?: (id: string | null) => void;
  onOpen?: (id: string) => void;
  className?: string;
}) {
  // Letters and digits only: the id is used inside `url(#…)`, where React's own marks are not safe everywhere.
  const fade = `iso${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const host = useRef<SVGSVGElement>(null);
  const streets = planStreets(rows);
  const plots = streets.flatMap((s) => s.plots);
  const g = groundOf(streets);
  const { box, key } = planBox(streets);
  const drawn = useDrawnWidth(host);
  const k = wordScale(drawn.now, box.w);
  const want = pictureCopy(drawn.first, box.w);
  const walls = new Map(plots.map((b) => [b.row.id, wallPicture(b.row.id, want, drawn.first / box.w)]));
  usePictures(plots.flatMap((b) => walls.get(b.row.id)?.srcs ?? []));
  const toured = useTour(plots.map((b) => b.row.id), !active, host);
  const lit = active ?? toured;

  // The site's grid: a line each unit along both ground axes, fading toward the sheet's edge.
  const grid: [Pt, Pt][] = [];
  for (let gx = Math.ceil(g.x0); gx <= g.x1; gx++) grid.push([iso([gx, g.y0, 0], U), iso([gx, g.y1, 0], U)]);
  for (let gy = Math.ceil(g.y0); gy <= g.y1; gy++) grid.push([iso([g.x0, gy, 0], U), iso([g.x1, gy, 0], U)]);

  const anyLadder = plots.some((b) => b.ladder);

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
        <BungalowDefs id={fade} />
      </defs>

      <g mask={`url(#${fade}-m)`} stroke={EDITORIAL_INK} strokeOpacity="0.09" strokeWidth="1" vectorEffect="non-scaling-stroke">
        {grid.map(([a, b], i) => <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} vectorEffect="non-scaling-stroke" />)}
      </g>

      {/* Back to front: a street's plots, its road, then the houses on it, so a house in front
          stands over the street behind. */}
      {streets.map((s) => {
        const plot: Pt[] = [
          iso([-PAD, s.y - PAD, 0], U), iso([s.length + PAD, s.y - PAD, 0], U),
          iso([s.length + PAD, s.y + HOUSE_D + PAD, 0], U), iso([-PAD, s.y + HOUSE_D + PAD, 0], U),
        ];
        const r = roadOf(s);
        const road: Pt[] = [iso([g.x0, r.y0, 0], U), iso([s.roadEnd, r.y0, 0], U), iso([s.roadEnd, r.y1, 0], U), iso([g.x0, r.y1, 0], U)];
        // The centre line, broken where the name is painted, and stopping short of the turning circle.
        const dashes: [Pt, Pt][] = [
          [iso([g.x0 + 0.3, r.mid, 0], U), iso([s.nameAt - 0.35, r.mid, 0], U)],
          [iso([s.nameTo + 0.35, r.mid, 0], U), iso([s.roadEnd - TURN - 0.2, r.mid, 0], U)],
        ];
        const kerb = { stroke: EDITORIAL_INK, strokeOpacity: 0.2, strokeWidth: 1, vectorEffect: 'non-scaling-stroke' as const };
        const roadFill = mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.06);
        return (
          <g key={s.chain}>
            <polygon points={pts(plot)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.05)} fillOpacity="0.9" stroke={EDITORIAL_INK} strokeOpacity="0.22" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <g data-road={s.chain}>
              <ellipse cx="0" cy="0" rx={TURN * U} ry={TURN * U} transform={groundMatrix([s.roadEnd, r.mid, 0], U)} fill={roadFill} fillOpacity="0.9" {...kerb} />
              <polygon points={pts(road)} fill={roadFill} fillOpacity="0.9" />
              <line x1={road[0]![0]} y1={road[0]![1]} x2={road[1]![0]} y2={road[1]![1]} {...kerb} />
              <line x1={road[3]![0]} y1={road[3]![1]} x2={road[2]![0]} y2={road[2]![1]} {...kerb} />
              {dashes.filter(([a, b]) => b[0] - a[0] > 8).map(([a, b], i) => (
                <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={EDITORIAL_INK} strokeOpacity="0.3" strokeWidth="1" strokeDasharray="5 6" vectorEffect="non-scaling-stroke" />
              ))}
              {/* The street's name, painted on its road, as a site plan letters a road. */}
              <text transform={groundMatrix([s.nameAt, r.mid + 0.25, 0], U)} fontSize={NAME_PX} letterSpacing="0.16em"
                fill={EDITORIAL_INK} fillOpacity="0.7" style={{ ...MONO, textTransform: 'uppercase' }} className="max-md:hidden">
                {s.name}
              </text>
            </g>
            {s.plots.map((b) => {
              const on = lit === b.row.id;
              const up = active === b.row.id;
              const wall = walls.get(b.row.id);
              const shown = wall?.shown ?? null;
              return (
                <g key={b.row.id} data-pool={b.row.id} data-lit={on ? '' : undefined} data-lifted={up ? '' : undefined}
                  onMouseEnter={() => onActive?.(b.row.id)} onClick={() => onOpen?.(b.row.id)}
                  style={{ cursor: onOpen ? 'pointer' : undefined }}>
                  <IsoBungalow defs={fade} x={b.x} y={b.y} art={shown?.src}
                    frames={shown ? { front: muralFrame(shown.facts, wall?.position), gable: gableFrame(shown.facts, wall?.position) } : null}
                    dim={restDim(shown?.facts.luma)}
                    accent={b.row.accent ?? EDITORIAL_GREEN} lit={on} lifted={up} ladder={b.ladder} symbol={b.row.symbol} />
                </g>
              );
            })}
          </g>
        );
      })}

      {anyLadder && <LadderKey right={key.right} top={key.top} k={k} />}
    </svg>
  );
}

/**
 * The drawing's key, in its top right corner: a lock ladder drawn to the same scale as the
 * ladders on the houses, its first rung marked with the shortest lock and the floor of the share,
 * its top rung with the longest lock and the ceiling, from the contract's constants. Its words
 * are `k` times their size, so they read at the same size however small the drawing is drawn;
 * the ladder itself never scales.
 */
function LadderKey({ right, top, k }: { right: number; top: number; k: number }) {
  const px = (n: number) => Math.round(n * 100) / 100;
  const caption = px(KEY.captionPx * k);
  const foot = keyFoot(top, k);
  const rails = [right - 6 - RAIL_GAP * U, right - 6] as const;
  const rungs = rungHeights();
  const yOf = (z: number) => foot - z * U;
  const line = { stroke: EDITORIAL_INK, strokeOpacity: 0.85, strokeLinecap: 'round' as const };
  const label = { fontSize: px(KEY.figurePx * k), fill: EDITORIAL_INK, fillOpacity: 0.85, textAnchor: 'end' as const, style: MONO };
  const marks = [
    { z: rungs[rungs.length - 1]!, lock: LONG_LOCK, share: CEILING_LABEL },
    { z: rungs[0]!, lock: SHORT_LOCK, share: FLOOR_LABEL },
  ];
  return (
    <g className="max-md:hidden" pointerEvents="none" data-key="">
      {/* Each text hides itself too: a browser's innerText still counts text inside a hidden group. */}
      <text x={right} y={top + caption} fontSize={caption} letterSpacing="0.16em" textAnchor="end"
        fill={EDITORIAL_INK} fillOpacity="0.6" style={{ ...MONO, textTransform: 'uppercase' }} className="max-md:hidden">
        Lock ladder
      </text>
      <line x1={right - 22} y1={foot} x2={right} y2={foot} stroke={EDITORIAL_INK} strokeOpacity="0.4" />
      {rails.map((x) => <line key={x} x1={x} y1={foot} x2={x} y2={yOf(RAIL_TOP)} strokeWidth="1.4" {...line} />)}
      {rungs.map((z) => <line key={z} data-key-rung={z.toFixed(4)} x1={rails[0]} y1={yOf(z)} x2={rails[1]} y2={yOf(z)} strokeWidth="1.1" {...line} />)}
      {marks.map((m) => (
        <g key={m.lock}>
          <line x1={rails[0] - 7} y1={yOf(m.z)} x2={rails[0] - 2} y2={yOf(m.z)} stroke={EDITORIAL_GREEN} strokeWidth="1" />
          <text x={rails[0] - 10} y={yOf(m.z) + px(4 * k)} {...label} className="max-md:hidden">
            <tspan fill={EDITORIAL_GREEN} fillOpacity="1">{m.lock}</tspan> <tspan>{m.share}</tspan>
          </text>
        </g>
      ))}
    </g>
  );
}
