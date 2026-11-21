import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useDrawnWidth } from '../../hooks/useDrawnWidth';
import { mixHex, pad2 } from '../../lib/editorial';
import { groundMatrix, iso, pts, solid, wallMatrix, type P3, type Pt } from '../../lib/iso';
import { FALL, OVER_EAVE, OVER_GABLE, ROOF_THICK, convexHull } from '../../lib/isoBungalow';
import { muralOf, muralWidth, readFacts, restDim, usePictures } from '../../lib/isoMural';
import { HARVEST_CHAIN_LABEL } from '../../lib/harvest/types';
import {
  ALLEY, AMBER, BAND_PX, BG, BOARD, CLOUD_PAD, CLOUD_STEP, CORNICE, D, FASCIA_PX, FASCIA_STONE, FLAG_H, FLOOR_PX, FOOT, GHOST_PAINT,
  GLASS, GLASS_TINT, GLOW, GREEN, H, HOT, INK, LIFT, M, NET_COLOUR, PLATE, RISE, SIDE_PX, SKY, SLATE, SLATE_EDGE, STONE, STOREY_PX, U,
  UNSURE, W, WALL_PX, WT, W_GLASS, W_HEAD, W_POD, W_POD_OVER, W_ROOF_OVER, W_ROOF_T, cityBoard, cityPlan, cloudPath, granaryBox,
  granaryLayout, isGhost, laneHalf, lanePaint, laneRoute, letteringFor, lotCorners, muralDimmed, networksOf, storeyMuralFrame,
  storeyPaint, walletLabel, walletNameSize,
  type CityPlan, type GranaryBox, type GranaryMode, type GranaryStorey, type Lane, type Lot, type PlacedStorey, type RoofMode, type Tower,
} from '../../lib/harvest/granary';
import { BungalowDefs } from './IsoBungalow';

export type { GranaryStorey } from '../../lib/harvest/granary';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)';
/** Lowered and set down. */
const SET = 'cubic-bezier(0.65, 0, 0.35, 1)';
const MONO = { fontFamily: 'var(--font-family-mono)' } as const;
/** From the 25th storey on, a storey is brick in its room's colour: one picture each, at most 24. */
const MURAL_CAP = 24;

const px = (n: number) => Math.round(n * 100) / 100;
const P = (x: number, y: number, z: number): Pt => iso([x, y, z], U);
/** A part drawn at height 0, placed at height `z` by one transform, so every move is one transition. */
const raise = (z: number) => `translateY(${px(-z * U)}px)`;
/** How a storey's fascia is lettered: its plaque, or (drawn small) a number tile. */
type Cut = 'l' | 'm';
/** A window's glazing cross and sill, dark and lit. */
const CROSS = mixHex(BG, INK, 0.5);
const CROSS_LIT = mixHex(BG, '#7a4a12', 0.5);
const SILL_LIT = mixHex(STONE, GLOW, 0.45);
/** How far past its footing the shade where a footing meets the board reaches. */
const CONTACT = 0.16;

interface Mural {
  href: string;
  frame: { x: number; y: number; width: number; height: number };
  dim: number;
}

interface GranaryProps {
  /** Every claim this harvest sends, in run order (the run's rows once there is a run); never a held or unread pool. */
  storeys: readonly GranaryStorey[];
  /** The pools are being read: with no storeys, the bare footing and the scan line. */
  reading?: boolean;
  /** A pool was not read: with no storeys, no footing at all, since the bare one says nothing to claim. */
  unread?: boolean;
  /** The claim pointed at, here or at its row, by key. */
  active?: string | null;
  onActive?: (key: string | null) => void;
}

const matches = (query: string) => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

function prefersReducedMotion(): boolean {
  return matches('(prefers-reduced-motion: reduce)');
}

/** False until its first frame is on screen, then true (true at once under reduced motion). */
function useRisen(): boolean {
  const [risen, setRisen] = useState(prefersReducedMotion);
  useEffect(() => {
    if (risen) return;
    let next = 0;
    const first = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => setRisen(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(next);
    };
  }, [risen]);
  return risen;
}

/** How long the sheet draws itself before the kit rises, in ms. index.css `.granary { --ink }` is the same number. */
const INK_MS = 460;

/**
 * The drawing's first sight: `armed` (hidden, the kit stacked on its footing), `play` (drawing itself, then
 * as built), `still` (let go unseen: drawn finished at once), or null (it never waits: finished, as built).
 */
type Intro = 'armed' | 'play' | 'still' | null;

/** It waits to be looked at only where something can say it is seen, on a screen, with motion allowed. */
const mayWait = () => typeof IntersectionObserver === 'function' && !matches('print') && !prefersReducedMotion();
/** What the float moves (index.css): a storey ready or waiting, or a roof still hung over the kit. */
const HANGS = "[data-plate][data-state='ready'], [data-plate][data-state='waiting'], [data-roof='kit']";

/**
 * The drawing's life on screen, none of it under reduced motion. The turn (fine pointers, on screen): once the
 * pointer rests 80 ms the model eases round to face it, 2 deg at most, a skewY on the element round the svg,
 * never the svg's own (a pointer move under a turned svg lays its text out again). The beat (fine pointers, on
 * screen, 8 storeys at most, a part hung): `--beat` up by one every 0.4 s on each hung part. The intro: armed
 * from the first frame, played at nine tenths in view or 0.9 s after the first pixel; off screen at mount, let go.
 */
function useFigureLife(host: RefObject<SVGSVGElement | null>, has: boolean): Intro {
  const [intro, setIntro] = useState<Intro>(() => (has && mayWait() ? 'armed' : null));
  useEffect(() => {
    const svg = host.current;
    if (!svg || !has || prefersReducedMotion()) return;
    const fine = matches('(hover: hover) and (pointer: fine)');
    const undo: (() => void)[] = [];
    let turning = 0; // a frame is asked for while the model turns, or waits to

    const turner = svg.parentElement;
    const card = svg.closest('.hv')?.parentElement ?? null;
    // The pointer is listened to while the drawing is on screen (from the observer below; always, with none).
    let listen = (_on: boolean) => {};
    if (fine && card && turner?.classList.contains('hv-turn')) {
      let goal = 0;
      let now = 0;
      let last = 0;
      let moved = 0;
      let inside = false;
      let listening = false;
      let mid = 0;
      let span = 1;
      const measure = () => {
        const r = svg.getBoundingClientRect();
        mid = r.left + r.width / 2;
        span = card.clientWidth * 0.6 || 1;
      };
      const step = (t: number) => {
        if (t - moved >= 80) {
          // A heavy turntable, the same pace at 60 and 120 frames a second.
          now += (goal - now) * (1 - Math.exp(-Math.min(64, t - last) / 200));
          if (Math.abs(goal - now) < 0.004) now = goal;
          turner.style.transform = now ? `skewY(${(now * -2).toFixed(3)}deg)` : '';
        }
        last = t;
        turning = now === goal ? 0 : requestAnimationFrame(step);
        if (!turning && !goal) turner.style.willChange = '';
      };
      const move = (e: PointerEvent) => {
        const over = e.target instanceof Node && card.contains(e.target);
        if (over && !inside) measure();
        inside = over;
        moved = performance.now();
        goal = over ? Math.max(-1, Math.min(1, (e.clientX - mid) / span)) : 0;
        if (turning || goal === now) return;
        // Its own layer while it turns: a new angle is a new matrix, never a repaint.
        turner.style.willChange = 'transform';
        last = moved;
        turning = requestAnimationFrame(step);
      };
      // When the page scrolls under a pointer resting on the card, the card is measured again.
      const scrolled = () => {
        if (inside) measure();
      };
      listen = (on) => {
        if (on === listening) return;
        listening = on;
        if (on) {
          document.addEventListener('pointermove', move, { passive: true });
          document.addEventListener('scroll', scrolled, { passive: true, capture: true });
          return;
        }
        // Off screen it lets go, and stands straight.
        document.removeEventListener('pointermove', move);
        document.removeEventListener('scroll', scrolled, { capture: true });
        cancelAnimationFrame(turning);
        turning = 0;
        inside = false;
        goal = now = 0;
        turner.style.transform = '';
        turner.style.willChange = '';
      };
      undo.push(() => listen(false));
    }

    let spent = !mayWait(); // it plays at most once a mount
    let live = true; // an observer can still report after its figure is gone (twice-run effects in development)
    let phase: Intro = spent ? null : 'armed';
    let first = true;
    let timer = 0;
    let pulse = 0;
    let beat = 0;
    let raf = 0;
    const go = (to: Intro) => {
      phase = to;
      setIntro(to);
    };
    const play = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          spent = true;
          go('play');
        });
      });
    };
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([e]) => {
        if (!e || !live) return;
        listen(e.isIntersecting);
        clearInterval(pulse);
        if (e.isIntersecting && fine) {
          pulse = window.setInterval(() => {
            if (turning || svg.querySelectorAll('[data-plate]').length > 8 || !svg.querySelector(HANGS)) return;
            beat = (beat + 1) % 48;
            // On each part, never the svg: --beat does not inherit (index.css), so only these are restyled.
            for (const part of svg.querySelectorAll<SVGElement>('[data-plate], [data-roof], [data-guides] line')) part.style.setProperty('--beat', String(beat));
          }, 400);
        }
        if (spent) return;
        clearTimeout(timer);
        if (e.isIntersecting) {
          if (phase !== 'armed') go('armed');
          if (e.intersectionRatio >= 0.9) play();
          else timer = window.setTimeout(play, 900);
        } else if (first) {
          go('still');
        }
        first = false;
      }, { threshold: [0, 0.9] });
      io.observe(svg);
      undo.push(() => io.disconnect());
    } else {
      listen(true);
    }
    // Laid out for print it stands finished, for good; flushSync, as the print layout follows this handler.
    const print = () => {
      spent = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      if (phase !== null) flushSync(() => go(null));
    };
    window.addEventListener('beforeprint', print);
    undo.push(() => {
      live = false;
      window.removeEventListener('beforeprint', print);
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      clearInterval(pulse);
    });
    return () => undo.forEach((f) => f());
  }, [host, has]);
  return intro;
}

/**
 * Harvest's figure: one street, each room with a claim a building of storeys in its brick and door
 * picture, and one lane a claim to YOUR WALLET; every storey, lane and plate the same size whatever it
 * pays (lib/harvest/granary.ts). A paid storey comes down, its lane runs green and a plate is set down
 * in the wallet; one that did not land hangs dashed. Hidden from assistive tech: the ledger says it all.
 */
export function HarvestGranary(props: GranaryProps) {
  // The kit explodes whenever storeys first appear, so the drawing with claims is its own mount.
  return <Granary key={props.storeys.length ? 'claims' : 'bare'} {...props} />;
}

function Granary({ storeys, reading = false, unread = false, active = null, onActive }: GranaryProps) {
  // Letters and digits only: the id is used inside `url(#…)`.
  const id = `gr${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const host = useRef<SVGSVGElement>(null);
  const intro = useFigureLife(host, storeys.length > 0);
  // Stacked on its footing while armed, at its place otherwise; moving as built unless armed or let go unseen.
  const placed = intro !== 'armed';
  const moving = intro === 'play' || intro === null;
  const networks = networksOf(storeys);
  const mode: GranaryMode = storeys.length ? 'claims' : reading ? 'reading' : unread ? 'unread' : 'nothing';
  const box = granaryBox(networks, mode);
  const towers = granaryLayout(networks);
  const kit = granaryLayout(networks.map((n) => ({ ...n, storeys: n.storeys.map((s) => ({ ...s, state: 'sending' as const })) })));

  // Each room's door picture, at the copy its front wall spans as drawn (the height cap can shrink
  // the drawing inside its box: `meet` takes the smaller scale); null until measured. Asked for only
  // for the storeys that wear one.
  const drawn = useDrawnWidth(host);
  const perUnit = drawn.first > 0 && drawn.firstH > 0 ? Math.min(drawn.first / box.w, drawn.firstH / box.h) : 0;
  const want = perUnit > 0 ? muralWidth(WALL_PX * perUnit) : typeof ResizeObserver === 'function' ? null : 480;
  const murals = new Map<string, { src: string; position?: string } | null>();
  for (const s of storeys.slice(0, MURAL_CAP)) if (!murals.has(s.roomId)) murals.set(s.roomId, want ? muralOf(s.roomId, want) : null);
  usePictures([...murals.values()].flatMap((m) => (m ? [m.src] : [])));
  const muralFor = (s: GranaryStorey): Mural | null => {
    const room = storeys.indexOf(s) < MURAL_CAP ? murals.get(s.roomId) : null;
    const facts = readFacts(room?.src);
    if (!room || !facts) return null;
    const f = storeyMuralFrame(facts, room.position);
    return { href: room.src, frame: { x: px(f.x), y: px(f.y), width: px(f.width), height: px(f.height) }, dim: restDim(facts.luma) };
  };
  // The fascia is lettered to read at the size the figure is drawn now; in full until measured.
  const scale = drawn.now > 0 && drawn.tall > 0 ? Math.min(drawn.now / box.w, drawn.tall / box.h) : 0;
  const cut: Cut = scale > 0 ? letteringFor(scale) : 'l';

  // Where each storey stood, and what it was, in the drawing before this one: a dashed twin starts
  // from its solid's place, and drops in from the wallet's lift only if it was at the wallet.
  const sig = storeys.map((s) => `${s.key}:${s.state ?? ''}`).join('|');
  const [stood, setStood] = useState(() => ({ sig, now: zByKey(towers), before: zByKey(towers), is: statesOf(storeys), was: statesOf(storeys) }));
  if (stood.sig !== sig) setStood({ sig, now: zByKey(towers), before: stood.now, is: statesOf(storeys), was: stood.is });

  const ghosts = towers.flatMap((t) => t.placed.filter((q) => q.where === 'ghost').map((q) => ({ t, q })));
  // Each network's stacks, room by room, first to last, each with where its roof hangs over the kit.
  const nets = networks.map((_, n) => towers.flatMap((t, i) => (t.net === n ? [{ t, kitBase: kit[i]!.roof.base }] : [])));
  // The street: its lots in order, the lanes, the wallet (none while reading or with nothing drawn).
  const plan = mode === 'claims' ? cityPlan(towers) : null;
  const lots = [...new Set(towers.map((t) => t.lot))];
  // A footing's near face takes the light of the building before it on the street, whatever its network.
  const before = (lot: Lot) => towers.find((t) => t.last && t.lot === lots[lots.indexOf(lot) - 1]) ?? null;

  return (
    <svg
      ref={host}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      data-testid="harvest-stack"
      data-lettering={cut}
      data-intro={intro === 'armed' || intro === 'play' ? intro : undefined}
      className="granary block h-auto mx-auto overflow-visible select-none w-[min(100%,calc(var(--world-w)*2.6px))] max-h-[var(--fig-max,28rem)]"
      style={{ '--world-w': String(box.w) } as CSSProperties}
      onMouseLeave={() => onActive?.(null)}
    >
      <GranaryDefs id={id} box={box} />
      <Site defs={id} ground={siteOf(towers, plan)} />
      {mode === 'claims' && <Ground defs={id} towers={towers} />}
      {plan && <Street plan={plan} lots={lots} cut={cut} />}
      {plan && <Wallet defs={id} plan={plan} cut={cut} scale={scale} />}
      {mode === 'claims'
        ? nets.map((stacks) => (
          <NetworkFigure key={stacks[0]!.t.chain} defs={id} stacks={stacks} before={before} placed={placed}
            moving={moving} active={active} onActive={onActive} muralFor={muralFor} cut={cut} />
        ))
        : mode !== 'unread' && <BareFooting defs={id} reading={mode === 'reading'} />}
      {plan && <Lanes plan={plan} active={active} cut={cut} />}
      {ghosts.length > 0 && (
        <g data-ghosts="">
          {ghosts.map(({ t, q }) => (
            <DashedStorey key={q.storey.key} x={t.x} y={t.y} at={q} from={stood.before.get(q.storey.key) ?? q.z}
              wasSending={stood.was.get(q.storey.key) === 'sending'} moving={moving} topped={t.topped} cut={cut}
              onEnter={() => onActive?.(q.storey.key)} />
          ))}
        </g>
      )}
    </svg>
  );
}

/**
 * The bungalow's brick, slate and light (IsoBungalow.tsx), and the granary's own: the band a picture
 * lies in, hatching, the halo, the site's fade; a lit pane, hot at its middle, the light it throws
 * along stone and washes onto the next footing, and the warmth round a roof once set on.
 */
function GranaryDefs({ id, box }: { id: string; box: GranaryBox }) {
  return (
    <defs>
      <BungalowDefs id={id} />
      <clipPath id={`${id}-band`}>
        <rect x="0" y={FASCIA_PX} width={WALL_PX} height={BAND_PX} />
      </clipPath>
      <pattern id={`${id}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <path d="M0 0V4" stroke={INK} strokeOpacity="0.16" strokeWidth="0.8" />
      </pattern>
      <radialGradient id={`${id}-halo`}>
        <stop offset="0" stopColor={GLOW} stopOpacity="0.2" />
        <stop offset="0.55" stopColor={GLOW} stopOpacity="0.07" />
        <stop offset="1" stopColor={GLOW} stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${id}-pane`} cx="50%" cy="46%" r="72%">
        <stop offset="0" stopColor={HOT} />
        <stop offset="0.55" stopColor={GLOW} />
        <stop offset="1" stopColor={mixHex(GLOW, '#e09a3c', 0.55)} />
      </radialGradient>
      <linearGradient id={`${id}-throw`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={GLOW} stopOpacity="0.62" />
        <stop offset="1" stopColor={GLOW} stopOpacity="0.06" />
      </linearGradient>
      <linearGradient id={`${id}-wash`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={GLOW} stopOpacity="0.34" />
        <stop offset="1" stopColor={GLOW} stopOpacity="0" />
      </linearGradient>
      <radialGradient id={`${id}-crown`}>
        <stop offset="0" stopColor={GLOW} stopOpacity="0.3" />
        <stop offset="0.5" stopColor={GLOW} stopOpacity="0.1" />
        <stop offset="1" stopColor={GLOW} stopOpacity="0" />
      </radialGradient>
      {/* The wallet's lamplight on its floor, and the sky in its glass. */}
      <radialGradient id={`${id}-wglow`}>
        <stop offset="0" stopColor={GLOW} stopOpacity="0.95" />
        <stop offset="0.5" stopColor={GLOW} stopOpacity="0.3" />
        <stop offset="1" stopColor={GLOW} stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`${id}-wsky`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.2" />
        <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.03" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
      <radialGradient id={`${id}-fade`} cx="50%" cy="80%" r="64%">
        <stop offset="52%" stopColor="#fff" stopOpacity="1" />
        <stop offset="100%" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <mask id={`${id}-m`} maskUnits="userSpaceOnUse" x={box.x} y={box.y} width={box.w} height={box.h}>
        <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={`url(#${id}-fade)`} />
      </mask>
    </defs>
  );
}

interface SiteGround {
  /** The ground plate on the sheet; the board's thickness under it; the plate's opacity; the grid's plan range (x0, x1, y0, y1). */
  plate: Pt[];
  board: Pt[];
  opacity: number;
  grid: readonly [number, number, number, number];
}

/**
 * What the model stands on. With claims: the street's board, ruled on the grid, its thickness only
 * under its two near edges (an upright at each near corner), so nothing opaque lies under the plate
 * and the card's art shows through it. With none: the bare lot's plate on its board, as built.
 */
function siteOf(towers: readonly Tower[], plan: CityPlan | null): SiteGround {
  if (!plan) {
    const plate = convexHull(lotCorners(0, 0));
    return { plate, board: convexHull([...plate, ...plate.map(([a, b]): Pt => [a, b + BOARD * U])]), opacity: 0.94, grid: [-M - 3, W + M + 3, -M - 3, D + M + 3] };
  }
  const plate = cityBoard(towers, plan).map(([x, y]) => P(x, y, 0));
  const low = plate.map(([a, b]): Pt => [a, b + BOARD * U]);
  const board = [plate[1]!, plate[2]!, low[2]!, plate[2]!, plate[3]!, low[3]!, low[2]!, low[1]!];
  const end = Math.max(...towers.map((t) => t.lot.x + t.lot.length));
  return { plate, board, opacity: 0.84, grid: [plan.wx - W_POD_OVER - 3, end + M + 3, -M - 3, plan.kerb + 3] };
}

/** The site: its grid fading to the sheet's edge, the board the model stands on, and the ground plate on it. */
function Site({ defs, ground }: { defs: string; ground: SiteGround }) {
  const [gx0, gx1, gy0, gy1] = ground.grid;
  const grid: [Pt, Pt][] = [];
  for (let gx = Math.ceil(gx0); gx <= gx1; gx++) grid.push([P(gx, gy0, 0), P(gx, gy1, 0)]);
  for (let gy = Math.ceil(gy0); gy <= gy1; gy++) grid.push([P(gx0, gy, 0), P(gx1, gy, 0)]);
  const { plate, board } = ground;
  // The grid is ruled line by line (--i), each from a dash as long as the longest line (index.css, the intro).
  const longest = Math.max(0, ...grid.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1])));
  return (
    <>
      <g mask={`url(#${defs}-m)`} stroke={INK} strokeOpacity="0.075" strokeWidth="0.8" style={pen(longest)} data-grid="">
        {grid.map(([a, b], i) => (
          <line key={i} x1={px(a[0])} y1={px(a[1])} x2={px(b[0])} y2={px(b[1])} style={{ '--i': i } as CSSProperties} />
        ))}
      </g>
      <polygon points={pts(board)} fill={mixHex(BG, INK, 0.02)} stroke={INK} strokeOpacity="0.22" strokeWidth="0.8" strokeLinejoin="round"
        style={pen(edgeOf(board))} data-board="" />
      <polygon points={pts(plate)} fill={mixHex(BG, INK, 0.05)} fillOpacity={ground.opacity} stroke={INK} strokeOpacity="0.3"
        strokeWidth="0.8" strokeLinejoin="round" style={pen(edgeOf(plate))} data-site="" />
    </>
  );
}

/** A closed outline's length on the sheet. */
const edgeOf = (p: readonly Pt[]) => p.reduce((sum, a, i) => sum + Math.hypot(p[(i + 1) % p.length]![0] - a[0], p[(i + 1) % p.length]![1] - a[1]), 0);
/** The dash a line is ruled from as the sheet draws itself: never shorter than the line, so it stands whole after. */
const pen = (length: number): CSSProperties => ({ '--len': Math.ceil(length) + 1 } as CSSProperties);

/**
 * The ground, before any footing (a solid always hides the ground behind it, never the reverse):
 * the shade where each footing meets the board, then the light past each building's last stack,
 * under its two windows, once that stack holds a paid storey; stronger once its network tops out.
 */
function Ground({ defs, towers }: { defs: string; towers: readonly Tower[] }) {
  return (
    <g>
      {towers.filter((t) => t.stack === 0).map(({ chain, lot: { x, y, length, roomId } }) => (
        <polygon key={`${chain}:${roomId}`} fill="#000000" fillOpacity="0.36" data-contact=""
          points={pts([P(x - M - CONTACT, y - M - CONTACT, 0), P(x + length + M + CONTACT, y - M - CONTACT, 0),
            P(x + length + M + CONTACT, y + D + M + CONTACT, 0), P(x - M - CONTACT, y + D + M + CONTACT, 0)])} />
      ))}
      {towers.filter((t) => t.last).flatMap((t) => [D - 0.625, D - 1.575].map((wy) => (
        <ellipse key={`${t.chain}:${t.lot.roomId}:${wy}`} rx={px(0.78 * U)} ry={px(0.4 * U)} transform={groundMatrix([t.x + W + M + 0.56, t.y + wy, 0], U)}
          fill={`url(#${defs}-pool)`} opacity={t.topped ? 0.5 : t.built > 0 ? 0.3 : 0} style={lightOn(t)} data-pool={t.chain} />
      )))}
    </g>
  );
}

/** Light thrown by paid storeys fades in once they are set down, or once their roofs are. */
const lightOn = (t: Tower): CSSProperties => ({ transition: `opacity 600ms ease ${t.topped ? 1550 : 750}ms` });

/**
 * A room's stone footing, `length` along x, hatched, its ticker cut in its near face, where the light
 * of the building before it falls; with no name, the bare dashed footing of reading and nothing.
 */
function Footing({ defs, x, y, length = W, name, cut = 'l', lightFrom = null }: {
  defs: string;
  x: number;
  y: number;
  length?: number;
  name: string | null;
  cut?: Cut;
  /** The last stack of the building before this one on the street: its lit windows face this footing's near end. */
  lightFrom?: Tower | null;
}) {
  const f = solid(x - M, y - M, length + 2 * M, D + 2 * M, FOOT, FOOT, U, 0);
  const bare = name === null;
  const line = bare
    ? { stroke: INK, strokeOpacity: 0.38, strokeWidth: 1, strokeDasharray: '3 3' }
    : { stroke: INK, strokeOpacity: 0.42, strokeWidth: 1, strokeLinejoin: 'round' as const };
  const pavers: [Pt, Pt][] = [];
  if (!bare) {
    for (let g = 1; g < length + 2 * M; g += 1) pavers.push([P(x - M + g, y - M, FOOT), P(x - M + g, y + D + M, FOOT)]);
    for (let g = 1; g < D + 2 * M; g += 1) pavers.push([P(x - M, y - M + g, FOOT), P(x + length + M, y - M + g, FOOT)]);
  }
  return (
    <g data-footing="">
      <polygon points={pts(f.right)} fill={bare ? 'none' : mixHex(BG, INK, 0.1)} {...line} style={pen(edgeOf(f.right))} />
      {!bare && <polygon points={pts(f.right)} fill={`url(#${defs}-hatch)`} />}
      <polygon points={pts(f.left)} fill={bare ? 'none' : mixHex(BG, INK, 0.15)} {...line} style={pen(edgeOf(f.left))} />
      {!bare && <polygon points={pts(f.left)} fill={`url(#${defs}-hatch)`} />}
      {lightFrom && (
        <g transform={wallMatrix([x - M, y + D + M, FOOT], 'x', U)} opacity={lightFrom.topped ? 1 : lightFrom.built > 0 ? 0.6 : 0}
          style={lightOn(lightFrom)} data-wash="">
          <rect width={px(2.4 * U)} height={px(FOOT * U)} fill={`url(#${defs}-wash)`} />
        </g>
      )}
      <polygon points={pts(f.top)} fill={bare ? BG : mixHex(BG, INK, 0.13)} fillOpacity={bare ? 0.5 : 1} {...line} style={pen(edgeOf(f.top))} />
      {pavers.length > 0 && (
        <g stroke={INK} strokeOpacity="0.08" strokeWidth="0.8">
          {pavers.map(([a, b], i) => <line key={i} x1={px(a[0])} y1={px(a[1])} x2={px(b[0])} y2={px(b[1])} />)}
        </g>
      )}
      {!bare && (
        <text transform={wallMatrix([x - M, y + D + M, FOOT], 'x', U)} x="4.5" y="8.4" fontSize={cut === 'm' ? 8.6 : 6.6} letterSpacing="1.05"
          fill={INK} fillOpacity="0.8" style={MONO} data-room-name="">
          {name}
        </text>
      )}
    </g>
  );
}

/** Reading and nothing: one bare footing, no network named on it; while reading, a line sweeps across it. */
function BareFooting({ defs, reading }: { defs: string; reading: boolean }) {
  const a = P(-M, -M, FOOT);
  const b = P(-M, D + M, FOOT);
  const far = P(W + M, -M, FOOT);
  return (
    <g>
      <Footing defs={defs} x={0} y={0} name={null} />
      {reading && (
        <line className="harvest-scan" x1={px(a[0])} y1={px(a[1])} x2={px(b[0])} y2={px(b[1])} stroke={GREEN} strokeWidth="1.6"
          style={{ '--scan-x': `${px(far[0] - a[0])}px`, '--scan-y': `${px(far[1] - a[1])}px` } as CSSProperties} />
      )}
    </g>
  );
}

/** How a placed storey moves to where it now stands: the explode (once the sheet is inked), the lift, the landing, the settle, left hanging. */
function moveOf(q: PlacedStorey, t: Tower, moving: boolean): string {
  if (!moving) return 'none';
  const how = q.storey.state === null ? `800ms ${EASE} ${INK_MS + Math.min(q.storey.n - 1, 12) * 60}ms`
    : q.where === 'built' ? `750ms ${SET}`
      : q.where === 'ghost' ? (t.topped ? `800ms ${SET} 750ms` : `750ms ${SET} 60ms`)
        : q.lifted ? `450ms ${SPRING}` : `750ms ${SET} 60ms`;
  return `transform ${how}, opacity 300ms ease`;
}

/** How the roof (and the guides it hangs on) moves: the explode, the lift, the settle, the topping out. */
function roofMoveOf(t: Tower, moving: boolean): string {
  if (!moving) return 'none';
  if (t.storeys.every((s) => s.state === null)) return `transform 800ms ${EASE} ${INK_MS + Math.min(lastOfStack(t), 12) * 60}ms`;
  if (t.topped) return `transform 800ms ${SET} 750ms`;
  return t.placed.some((q) => q.lifted) ? `transform 450ms ${SPRING}` : `transform 750ms ${SET} 60ms`;
}

const CORNERS: readonly (readonly [number, number])[] = [[0, 0], [W, 0], [W, D], [0, D]];
const zByKey = (towers: readonly Tower[]) => new Map(towers.flatMap((t) => t.placed.map((q) => [q.storey.key, q.z] as const)));
const statesOf = (storeys: readonly GranaryStorey[]) => new Map(storeys.map((s) => [s.key, s.state] as const));
const ghostPaintOf = (s: GranaryStorey) => GHOST_PAINT[isGhost(s.state) ? s.state : 'not-sent'];
/** A stack's last row number: its roof and guides take their place in the run from it. */
const lastOfStack = (t: Tower) => t.storeys[t.storeys.length - 1]!.n;
/** A part's place in the run, for index.css: the kit appears, and floats, in run order. */
const placeInRun = (k: number) => ({ '--k': k }) as CSSProperties;

interface StackProps {
  defs: string;
  /** At its place, or stacked on its footing (the intro armed). */
  placed: boolean;
  /** Moving to a new place as built, or set there at once (armed, or let go unseen). */
  moving: boolean;
  active: string | null;
  onActive?: (key: string | null) => void;
  muralFor: (s: GranaryStorey) => Mural | null;
  cut: Cut;
}

/**
 * One network: the halo of each of its stacks that topped out (so no halo paints over a neighbour),
 * then each of its rooms' buildings along the street: its footing, then its stacks first to last.
 */
function NetworkFigure({ stacks, before, ...props }: StackProps & {
  /** Each stack, room by room, with where its roof hangs over the kit. */
  stacks: readonly { t: Tower; kitBase: number }[];
  /** The last stack of the building before a lot on the street. */
  before: (lot: Lot) => Tower | null;
}) {
  const { chain } = stacks[0]!.t;
  const rooms = [...new Set(stacks.map(({ t }) => t.lot))];
  return (
    <g data-tower={chain} data-topped={stacks.some(({ t }) => t.topped) ? '' : undefined}>
      {stacks.map(({ t }) => t.topped && <Halo key={`${t.lot.roomId}:${t.stack}`} defs={props.defs} t={t} />)}
      {rooms.map((lot) => (
        <g key={`${chain}:${lot.roomId}`} data-room={lot.roomId}>
          <Footing defs={props.defs} x={lot.x} y={lot.y} length={lot.length} name={lot.symbol} cut={props.cut} lightFrom={before(lot)} />
          {stacks.filter(({ t }) => t.lot === lot).map(({ t, kitBase }) => (
            <StackFigure key={`${lot.roomId}:${t.stack}`} t={t} kitBase={kitBase} {...props} />
          ))}
        </g>
      ))}
    </g>
  );
}

/** Behind a stack that topped out: its halo, and the warmth gathered round its roof and its wall of lit windows. */
function Halo({ defs, t }: { defs: string; t: Tower }) {
  const halo = P(t.x + W / 2, t.y + D / 2, t.builtTop * 0.62);
  const crown = P(t.x + W + 0.2, t.y + D / 2, t.builtTop + 0.3);
  const arrive: CSSProperties = { animation: 'iso-mural-in 600ms ease 1550ms both' };
  return (
    <>
      <ellipse cx={px(halo[0])} cy={px(halo[1])} rx={px(3.6 * U)} ry={px((t.builtTop * 0.5 + 2.6) * U)} fill={`url(#${defs}-halo)`}
        style={arrive} data-halo="" />
      <ellipse cx={px(crown[0])} cy={px(crown[1])} rx={px(2.5 * U)} ry={px(2.2 * U)} fill={`url(#${defs}-crown)`} style={arrive} data-crown="" />
    </>
  );
}

/**
 * One stack: the light its paid storeys throw at their wall's foot, its guides, the shadow under its hung roof,
 * its storeys in run order, its roof. `data-thud` flips a, b, a with each storey built on it (index.css: the
 * stack takes the load; an animation restarts only when its name changes).
 */
function StackFigure({ defs, t, kitBase, placed, moving, active, onActive, muralFor, cut }: StackProps & {
  t: Tower;
  /** Where the roof hangs with every storey at the wallet: the guides are drawn this long and scaled to the roof. */
  kitBase: number;
}) {
  const { x, y } = t;
  const roofMove = roofMoveOf(t, moving);
  const lastN = lastOfStack(t);
  // On the footing's margin past a network's last stack; on the alley's floor past any other.
  const run = t.last ? M : ALLEY;
  return (
    <g data-stack={t.stack} data-thud={t.built > 0 ? (t.built % 2 ? 'a' : 'b') : undefined}>
      <g transform={groundMatrix([x + W, y, FOOT], U)} opacity={t.topped ? 1 : t.built > 0 ? 0.7 : 0} style={lightOn(t)} data-throw="">
        <rect width={px(run * U)} height={px(D * U)} fill={`url(#${defs}-throw)`} />
      </g>
      <Guides t={t} kitBase={kitBase} placed={placed} move={roofMove} k={lastN} />
      {t.roof.mode === 'kit' && (
        <polygon points={pts([P(x + 0.05, y + 0.05, 0), P(x + W - 0.05, y + 0.05, 0), P(x + W - 0.05, y + D - 0.05, 0), P(x + 0.05, y + D - 0.05, 0)])}
          fill="#000000" fillOpacity="0.34"
          style={{ transform: raise(t.builtTop), transition: moving ? `transform 750ms ${SET} 60ms` : 'none', ...placeInRun(t.storeys[0]!.n - 1) }}
          data-shadow="" />
      )}
      {t.storeys.map((s) => {
        const q = t.placed.find((p) => p.storey.key === s.key)!;
        // Armed, the kit stands stacked on its footing, roof on top: then it explodes.
        const z = placed ? q.z : FOOT + t.placed.indexOf(q) * H;
        return (
          <Storey key={s.key} defs={defs} x={x} y={y} at={q} z={z} move={moveOf(q, t, moving)} hot={active === s.key}
            mural={muralFor(s)} cut={cut} onEnter={() => onActive?.(s.key)} />
        );
      })}
      <Roof defs={defs} x={x} y={y} mode={t.roof.mode} base={placed ? t.roof.base : FOOT + t.storeys.length * H} move={roofMove} k={lastN} />
    </g>
  );
}

/**
 * The exploded view's guides, dashed up each corner, drawn before the storeys so they show only in
 * the air between them: from the footing to the roof hung over the kit (drawn as long as the kit's
 * and scaled to the roof, so they move with it), fading once the tower tops out; then, over a
 * topped-out tower, from under its ridge to the dashed storey left hanging, in that storey's colour.
 */
function Guides({ t, kitBase, placed, move, k }: { t: Tower; kitBase: number; placed: boolean; move: string; k: number }) {
  const scale = placed ? Math.max(0, Math.min(1, (t.roof.base - FOOT) / (kitBase - FOOT))) : 0;
  const hung = t.placed.filter((q) => q.where === 'ghost').sort((a, b) => b.z - a.z)[0];
  const guide = (dx: number, dy: number, from: number, to: number) => {
    const a = P(t.x + dx, t.y + dy, from);
    const b = P(t.x + dx, t.y + dy, to);
    return { x1: px(a[0]), y1: px(a[1]), x2: px(b[0]), y2: px(b[1]) };
  };
  return (
    <>
      <g stroke={INK} strokeOpacity="0.34" strokeWidth="0.9" strokeDasharray="2 4" data-guides={t.topped ? undefined : ''}
        style={{ opacity: t.topped ? 0 : 1, transition: `opacity 400ms ease ${t.topped ? 750 : 0}ms`, ...placeInRun(k) }}>
        {CORNERS.map(([dx, dy]) => (
          <line key={`${dx}:${dy}`} {...guide(dx, dy, FOOT, kitBase)}
            style={{ transform: `scaleY(${Math.round(scale * 1000) / 1000})`, transformBox: 'fill-box', transformOrigin: '50% 100%', transition: move }} />
        ))}
      </g>
      {t.topped && hung && (
        <g stroke={ghostPaintOf(hung.storey).colour} strokeOpacity="0.45" strokeWidth="0.9" strokeDasharray="2 4" data-guides=""
          className="granary-ghost-in" style={{ animationDelay: '1550ms' }}>
          {CORNERS.map(([dx, dy]) => <line key={`${dx}:${dy}`} {...guide(dx, dy, t.roof.e + RISE * 0.55, hung.z + H)} />)}
        </g>
      )}
    </>
  );
}

/**
 * A storey: brick in its room's colour, its room's door picture on the front wall, a stone fascia
 * lettered with its row's number, drawn as an architect draws a part: its outline a heavier line than
 * the lines inside it. Hung, it carries the shade of whatever hangs over it.
 */
function Storey({ defs, x, y, at, z, move, hot, mural, cut, onEnter }: {
  defs: string;
  x: number;
  y: number;
  at: PlacedStorey;
  z: number;
  move: string;
  hot: boolean;
  mural: Mural | null;
  cut: Cut;
  onEnter: () => void;
}) {
  const s = at.storey;
  // A claim that did not land keeps its solid here, faded out, so its fade and its hooks hold; its dashed twin is drawn on top.
  const ghost = at.where === 'ghost';
  const pointed = hot && !ghost;
  const paint = storeyPaint(ghost ? null : s.state, pointed);
  const late = s.state === 'claimed' ? 750 : 0;
  const pace = s.state === null ? '200ms ease-out' : '300ms ease';
  const tint: CSSProperties = { transition: ['fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width'].map((p) => `${p} ${pace} ${late}ms`).join(', ') };
  // The lines inside the outline, lighter than it; a paid storey's keep their full ink.
  const inside = !ghost && s.state === 'claimed' ? 1 : 0.62;
  const line = { stroke: paint.edge, strokeOpacity: px(paint.edgeOpacity * inside), strokeWidth: px(paint.edgeWidth * 0.72), strokeLinejoin: 'round' as const, style: tint };
  const body = solid(x, y, W, D, H, H, U, 0);
  const outline = [P(x, y, H), P(x + W, y, H), P(x + W, y, 0), P(x + W, y + D, 0), P(x, y + D, 0), P(x, y + D, H)];
  const shade = [P(x + 0.07, y + 0.07, H), P(x + W - 0.07, y + 0.07, H), P(x + W - 0.07, y + D - 0.07, H), P(x + 0.07, y + D - 0.07, H)];
  const dimmed = muralDimmed(ghost ? null : s.state, pointed);
  // Kept once built: a cautioned claim that landed may have paid less than its row's amount.
  const caution = s.caution && !ghost;
  const floor: [Pt, Pt][] = [[P(x + 1, y, H), P(x + 1, y + D, H)], [P(x + 2, y, H), P(x + 2, y + D, H)], [P(x, y + 1.1, H), P(x + W, y + 1.1, H)]];
  const windowY = px(FASCIA_PX + 4.6);
  return (
    <g data-plate={s.key} data-state={s.state ?? 'ready'} data-where={at.where} onMouseEnter={onEnter} pointerEvents={ghost ? 'none' : undefined}
      style={{ transform: raise(z), transition: move, opacity: ghost ? 0 : 1, ...placeInRun(s.n - 1) }}>
      <g style={{ transform: pointed && s.state !== 'claimed' ? 'translateY(-5px)' : 'none', transition: `transform 200ms ${EASE}` }}>
        {s.state === 'sending' && <Cloud x={x} y={y} />}
        <g transform={wallMatrix([x + W, y + D, H], '-y', U)}>
          <rect width={SIDE_PX} height={STOREY_PX} fill={mixHex(BG, s.accent, 0.3)} />
          <rect y={FASCIA_PX} width={SIDE_PX} height={BAND_PX} fill={`url(#${defs}-tone)`} />
          <rect y={FASCIA_PX} width={SIDE_PX} height={BAND_PX} fill={`url(#${defs}-brick)`} />
          <rect width={SIDE_PX} height={STOREY_PX} fill={BG} fillOpacity="0.24" />
          <rect width={SIDE_PX} height={STOREY_PX} fill={paint.veil} fillOpacity={paint.veilOpacity} style={tint} />
          <Lip defs={defs} width={SIDE_PX} />
          <rect width={SIDE_PX} height={FASCIA_PX} fill={mixHex(FASCIA_STONE, BG, 0.3)} />
          <Window defs={defs} x={7.5} y={windowY} lit={paint.lit} delay={0} />
          <Window defs={defs} x={26.5} y={windowY} lit={paint.lit} delay={120} />
          <rect y={px(STOREY_PX - FLOOR_PX)} width={SIDE_PX} height={FLOOR_PX} fill={mixHex(STONE, BG, 0.3)} />
          <Seam length={SIDE_PX} on={paint.seam} />
          <rect width={SIDE_PX} height={STOREY_PX} fill="none" {...line} />
        </g>
        <g transform={wallMatrix([x, y + D, H], 'x', U)}>
          <rect width={WALL_PX} height={STOREY_PX} fill={mixHex(BG, s.accent, 0.42)} />
          {mural && (
            <g clipPath={`url(#${defs}-band)`}>
              <g className="iso-mural">
                <image href={mural.href} {...mural.frame} preserveAspectRatio="none" />
                {mural.dim > 0 && (
                  <rect y={FASCIA_PX} width={WALL_PX} height={BAND_PX} fill={BG} fillOpacity={dimmed ? px(mural.dim) : 0} style={tint} />
                )}
              </g>
            </g>
          )}
          <rect y={FASCIA_PX} width={WALL_PX} height={BAND_PX} fill={`url(#${defs}-tone)`} />
          <rect y={FASCIA_PX} width={WALL_PX} height={BAND_PX} fill={`url(#${defs}-brick)`} opacity="0.75" />
          <rect y={FASCIA_PX} width={WALL_PX} height={BAND_PX} fill={paint.veil} fillOpacity={paint.veilOpacity} style={tint} />
          <Lip defs={defs} width={WALL_PX} />
          <rect width={WALL_PX} height={FASCIA_PX} fill={FASCIA_STONE} />
          <rect y={px(FASCIA_PX - 0.8)} width={WALL_PX} height="0.8" fill={BG} fillOpacity="0.5" />
          <rect y={px(STOREY_PX - FLOOR_PX)} width={WALL_PX} height={FLOOR_PX} fill={STONE} />
          <Seam length={WALL_PX} on={paint.seam} />
          <Plaque n={s.n} symbol={s.symbol} plate={paint.plate} text={paint.plateText} edge={paint.plateEdge} ticker={paint.ticker}
            caution={caution} tint={tint} cut={cut} />
          <rect width={WALL_PX} height={STOREY_PX} fill="none" {...line} />
        </g>
        <polygon points={pts(body.top)} fill={mixHex(mixHex(BG, INK, 0.1), s.accent, 0.1)} {...line} />
        <g stroke={INK} strokeOpacity="0.07" strokeWidth="0.8">
          {floor.map(([a, b], i) => <line key={i} x1={px(a[0])} y1={px(a[1])} x2={px(b[0])} y2={px(b[1])} />)}
        </g>
        {/* A hung storey always has a solid part over it: the next one hung, or the roof, solid until its network has every answer. */}
        {at.where === 'aloft' && <polygon points={pts(shade)} fill="#000000" fillOpacity="0.24" data-shade="" />}
        <polygon points={pts(outline)} fill="none" stroke={paint.edge} strokeOpacity={px(Math.min(1, paint.edgeOpacity * 1.3))}
          strokeWidth={px(paint.edgeWidth * 1.3)} strokeLinejoin="round" pointerEvents="none" style={tint} data-profile="" />
        <Dust x={x} y={y} defs={defs} />
      </g>
    </g>
  );
}

/** Dust for a landing: soft puffs along a storey's foot (`few`: at a roof's cornice), drawn at height 0, unseen until index.css plays them once. */
function Dust({ defs, x, y, few = false }: { defs: string; x: number; y: number; few?: boolean }) {
  // Plan x, plan y, radius, then the drift across and down (sheet px): left corner, front wall, near corner, side wall, right corner.
  const all: [number, number, number, number, number][] = [
    [x, y + D, 3.4, -9, -2], [x + W / 2, y + D, 2.6, -5, 2.5], [x + W, y + D, 3.4, 0, 4.5], [x + W, y + D / 2, 2.6, 5, 2.5], [x + W, y, 3.4, 9, -2],
  ];
  return (
    <g data-dust="">
      {(few ? [all[0]!, all[2]!, all[4]!] : all).map(([ax, ay, r, dx, dy], i) => {
        const c = P(ax, ay, 0);
        return (
          <circle key={i} cx={px(c[0])} cy={px(c[1])} r={r} fill={`url(#${defs}-puff)`} style={{ '--dx': `${dx}px`, '--dy': `${dy}px` } as CSSProperties} />
        );
      })}
    </g>
  );
}

/** The stone fascia stands proud of the wall under it, so it shades the top of the band. */
function Lip({ defs, width }: { defs: string; width: number }) {
  return <rect y={FASCIA_PX} width={width} height="3.6" fill={`url(#${defs}-eave)`} opacity="0.7" />;
}

/**
 * A window in a wall's plane: dark glass, the sky caught in its corner, until its storey is set
 * down paid; then the pane burns, hot at its middle, and its light blooms twice round it. The same
 * for every coin: it reads the claim's state alone.
 */
function Window({ defs, x, y, lit, delay }: { defs: string; x: number; y: number; lit: boolean; delay: number }) {
  const size = 10;
  const half = size / 2;
  const after = lit ? 750 + delay : 0;
  const glow: CSSProperties = { transition: ['opacity', 'fill-opacity', 'stroke-opacity', 'fill', 'stroke'].map((p) => `${p} 450ms ease ${after}ms`).join(', ') };
  // The lamp: the bloom round the pane, which strikes past its size as it lights (index.css; --lamp, its own lag).
  return (
    <g data-window={lit ? 'lit' : 'dark'} style={{ '--lamp': `${delay}ms` } as CSSProperties}>
      <ellipse cx={x + half} cy={y + half} rx={size * 2.5} ry={size * 2.5} fill={`url(#${defs}-bloom)`} opacity={lit ? 0.5 : 0} style={glow} />
      <ellipse cx={x + half} cy={y + half} rx={size * 1.35} ry={size * 1.35} fill={`url(#${defs}-bloom)`} opacity={lit ? 1 : 0} style={glow}
        data-lamp="" />
      <rect x={x} y={y} width={size} height={size} fill={GLASS} />
      <path d={`M${x} ${y}H${px(x + size * 0.66)}L${x} ${px(y + size * 0.66)}Z`} fill={SKY} fillOpacity={lit ? 0 : 0.2} style={glow} />
      <rect x={x} y={y} width={size} height={size} fill={`url(#${defs}-pane)`} fillOpacity={lit ? 1 : 0} style={glow} />
      <rect x={x} y={y} width={size} height={size} fill="none" stroke={INK} strokeOpacity={lit ? 0.95 : 0.7} strokeWidth="0.9" style={glow} />
      <path d={`M${x + half} ${y}V${y + size}M${x} ${y + half}H${x + size}`} stroke={lit ? CROSS_LIT : CROSS} strokeOpacity="0.9" strokeWidth="0.8" style={glow} />
      <rect x={px(x - 1.2)} y={y + size} width={size + 2.4} height="1.6" fill={lit ? SILL_LIT : STONE} style={glow} />
    </g>
  );
}

/** The green seam a paid storey locks in with, drawn along its foot once it is set down. */
function Seam({ length, on }: { length: number; on: boolean }) {
  return (
    <path d={`M0 ${px(STOREY_PX - 0.6)}H${length}`} stroke={GREEN} strokeWidth="1.3" strokeDasharray={`${length} ${length}`}
      strokeDashoffset={on ? 0 : length} style={{ transition: 'stroke-dashoffset 300ms ease-out 750ms' }} />
  );
}

/**
 * The fascia's lettering, in the front wall's plane, cut to read at the size the figure is drawn:
 * `l`, the row's number in a box, its coin's ticker and a cautioned claim's mark clear of the
 * corner; `m` (drawn small), a number tile hung over the picture's corner, the mark larger, no ticker.
 */
function Plaque({ n, symbol, plate, text, edge, ticker, dash, caution, tint, cut }: {
  n: number;
  symbol: string;
  plate: string;
  text: string;
  edge: string;
  ticker: string;
  dash?: string;
  caution: boolean;
  tint?: CSSProperties;
  cut: Cut;
}) {
  const num = pad2(n);
  if (cut === 'm') {
    return (
      <g data-plaque={num}>
        <rect x="1.6" y="1.2" width="16.4" height="11.2" fill={plate === 'none' ? BG : plate} fillOpacity={plate === 'none' ? 0.55 : 1} stroke={edge}
          strokeWidth="0.9" strokeDasharray={dash} style={tint} />
        <text x="9.8" y="9.9" textAnchor="middle" fontSize="9.6" fontWeight="700" fill={text} style={{ ...MONO, ...tint }}>{num}</text>
        {caution && (
          <g data-caution="">
            <path d="M51 1L57.6 11.6H44.4Z" fill={UNSURE} stroke={BG} strokeWidth="0.9" strokeLinejoin="round" />
            <text x="51" y="10.4" textAnchor="middle" fontSize="7.6" fontWeight="800" fill={BG} style={MONO}>!</text>
          </g>
        )}
      </g>
    );
  }
  const base = px(FASCIA_PX - 2.25);
  return (
    <g data-plaque={num}>
      <rect x="2.2" y="1.3" width="11" height={px(FASCIA_PX - 2.6)} fill={plate} stroke={edge} strokeWidth="0.7" strokeDasharray={dash} style={tint} />
      <text x="7.7" y={base} textAnchor="middle" fontSize="6.1" fontWeight="700" fill={text} style={{ ...MONO, ...tint }}>{num}</text>
      <text x="16" y={base} fontSize="6.1" fontWeight="700" letterSpacing="0.55" fill={ticker} style={{ ...MONO, ...tint }} data-ticker="">
        {symbol}
      </text>
      {caution && (
        <g data-caution="">
          <path d="M53.2 0.9L57.4 7.6H49Z" fill={UNSURE} stroke={BG} strokeWidth="0.7" strokeLinejoin="round" />
          <text x="53.2" y="6.9" textAnchor="middle" fontSize="4.8" fontWeight="800" fill={BG} style={MONO}>!</text>
        </g>
      )}
    </g>
  );
}

/** The revision cloud round the storey at the wallet, ruled close and fine: the drafting mark for the part being changed now. */
function Cloud({ x, y }: { x: number; y: number }) {
  const silhouette = [P(x, y, H), P(x + W, y, H), P(x + W, y + D, H), P(x, y + D, H), P(x, y + D, 0), P(x + W, y + D, 0), P(x + W, y, 0)];
  return (
    <path d={cloudPath(silhouette, CLOUD_PAD, CLOUD_STEP)} fill={AMBER} fillOpacity="0.055" stroke={AMBER} strokeWidth="1.15"
      strokeLinejoin="round" pathLength={1} className="hv-cloud" data-cloud="" />
  );
}

/** A claim that did not land: its storey in dashes, in its state's colour, hung in its place and never part of the building. */
function DashedStorey({ x, y, at, from, wasSending, moving, topped, cut, onEnter }: {
  x: number;
  y: number;
  at: PlacedStorey;
  /** Where its solid stood in the drawing before this one. */
  from: number;
  /** Its claim was at the wallet in the drawing before this one. */
  wasSending: boolean;
  /** The drawing moves as built (not armed, not let go unseen). */
  moving: boolean;
  topped: boolean;
  cut: Cut;
  onEnter: () => void;
}) {
  const s = at.storey;
  const g = ghostPaintOf(s);
  const b = solid(x, y, W, D, H, H, U, 0);
  // Left hanging as its tower tops out: it starts where its solid hung, under the roof still hung there,
  // and rises on the roof's own timing as the roof comes down.
  const [rises] = useState(() => moving && topped && from !== at.z);
  // Hung before its tower tops out: it fades, moves while unseen and comes back once the roof is down,
  // so it never passes through the storey landing under it or the roof coming down.
  const [bornTopped] = useState(topped);
  const hops = moving && topped && !bornTopped;
  const arrived = useRisen();
  const z = rises && !arrived ? from : at.z;
  const hidden = (a: Pt, c: Pt) => (
    <line x1={px(a[0])} y1={px(a[1])} x2={px(c[0])} y2={px(c[1])} stroke={g.colour} strokeOpacity="0.35" strokeWidth="0.9" strokeDasharray={g.dash} />
  );
  const face = (p: Pt[], opacity: number) => (
    <polygon points={pts(p)} fill={g.colour} fillOpacity={px(opacity)} stroke={g.colour} strokeWidth="1.1" strokeDasharray={g.dash} strokeLinejoin="round" />
  );
  // Otherwise one that was at the wallet arrives from where it hung there, LIFT higher; any other, in place.
  const [drop] = useState(() => (rises || !wasSending ? 0 : -LIFT * U));
  const move = !moving ? 'none' : hops ? 'transform 0s linear 300ms' : `transform ${topped ? `800ms ${SET} 750ms` : `750ms ${SET} 60ms`}`;
  return (
    <g data-ghost={s.key} data-state={s.state ?? 'ready'} onMouseEnter={onEnter} className={hops ? 'granary-ghost-hop' : undefined}
      style={{ transform: raise(z), transition: move }}>
      <g className="granary-ghost-in" style={{ '--ghost-from': `${drop}px` } as CSSProperties}>
        {hidden(P(x, y, 0), P(x, y, H))}
        {hidden(P(x, y, 0), P(x, y + D, 0))}
        {hidden(P(x, y, 0), P(x + W, y, 0))}
        {face(b.right, g.fill * 0.7)}
        {face(b.left, g.fill)}
        {face(b.top, g.fill * 1.3)}
        <g transform={wallMatrix([x, y + D, H], 'x', U)}>
          <Plaque n={s.n} symbol={s.symbol} plate="none" text={g.colour} edge={g.colour} ticker={g.colour} dash="1.5 1" caution={false} cut={cut} />
        </g>
      </g>
    </g>
  );
}

/** An affine matrix for an SVG `transform` from two axes and an origin, all on the sheet (as IsoBungalow lays its roof). */
function planeMatrix(origin: Pt, along: Pt, down: Pt): string {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `matrix(${r(along[0])} ${r(along[1])} ${r(down[0])} ${r(down[1])} ${r(origin[0])} ${r(origin[1])})`;
}
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const len = (v: Pt) => Math.hypot(v[0], v[1]);
const unit = (v: Pt): Pt => [v[0] / len(v), v[1] / len(v)];

/**
 * The roof module, drawn at height 0 and placed at its base: the bungalow's slate roof, gable and
 * chimney on a stone cornice. Hung over the kit; set on the tower once it tops out (green ridge,
 * flag, smoke); left hung in dashes, unfilled, where nothing on its network was paid.
 */
function Roof({ defs, x, y, mode, base, move, k }: { defs: string; x: number; y: number; mode: RoofMode; base: number; move: string; k: number }) {
  const ghost = mode === 'ghost';
  const topped = mode === 'topped';
  const e = CORNICE;
  const ez = e - OVER_EAVE * FALL;
  const rl: P3 = [x - OVER_GABLE, y + D / 2, e + RISE];
  const rr: P3 = [x + W + OVER_GABLE, y + D / 2, e + RISE];
  const er: P3 = [x + W + OVER_GABLE, y + D + OVER_EAVE, ez];
  const el: P3 = [x - OVER_GABLE, y + D + OVER_EAVE, ez];
  const br: P3 = [x + W + OVER_GABLE, y - OVER_EAVE, ez];
  const drop = (c: P3): P3 => [c[0], c[1], c[2] - ROOF_THICK];
  const at = (c: P3) => iso(c, U);
  const line = ghost
    ? { stroke: mixHex(BG, INK, 0.55), strokeWidth: 0.9, strokeDasharray: '3 3' }
    : { stroke: INK, strokeOpacity: 0.55, strokeWidth: 1, strokeLinejoin: 'round' as const };
  const fade: CSSProperties = { transition: 'fill-opacity 400ms ease, opacity 400ms ease' };
  const fill = ghost ? 0 : 1;
  const late = topped ? 1550 : 0;
  const cornice = solid(x - 0.05, y - 0.05, W + 0.1, D + 0.1, CORNICE, CORNICE, U, 0);
  const rise = px(RISE * U);
  const gable = `0,${rise} ${SIDE_PX / 2},0 ${SIDE_PX},${rise}`;
  const [r0, r1, e0] = [at(rl), at(rr), at(el)];
  // The chimney on the ridge, as the bungalow's (lib/isoBungalow.ts chimneyBox), raised with the roof.
  const size = 0.44;
  const cx = x + W * 0.66;
  const cy = y + D / 2 - size / 2;
  const top = e + RISE + 0.47;
  const csz = px(size * U);
  const stackH = px((top - (e + RISE - (size / 2) * FALL)) * U);
  const ridgeDown = px((top - (e + RISE)) * U);
  const stackSide: Pt[] = [[0, 0], [csz, 0], [csz, px(ridgeDown + csz / 2)], [px(csz / 2), ridgeDown], [0, stackH]];
  const cap = solid(cx - 0.05, cy - 0.05, size + 0.1, size + 0.1, 0.07, 0.07, U, top);
  const flue = P(cx + size / 2, cy + size / 2, top + 0.07);
  const foot = P(x + W + OVER_GABLE, y + D / 2, e + RISE);
  const head = P(x + W + OVER_GABLE, y + D / 2, e + RISE + FLAG_H);
  // The oculus in the gable: dark glass with the sky in it while the roof hangs; lit, and blooming, once set on.
  const [ox, oy, or] = [SIDE_PX / 2, px(rise - 7), 3.3];
  const lamp: CSSProperties = { transition: `opacity 300ms ease ${late}ms, fill-opacity 300ms ease ${late}ms` };
  return (
    <g data-roof={mode} style={{ transform: raise(base), transition: move, ...placeInRun(k) }}>
      <polygon points={pts(cornice.right)} fill={mixHex(STONE, BG, 0.35)} fillOpacity={fill} {...line} style={fade} />
      <polygon points={pts(cornice.left)} fill={STONE} fillOpacity={fill} {...line} style={fade} />
      <polygon points={pts(cornice.top)} fill={mixHex(STONE, BG, 0.2)} fillOpacity={fill} style={fade} />
      <g transform={wallMatrix([x + W, y + D, e + RISE], '-y', U)}>
        <polygon points={gable} fill={mixHex(BG, INK, 0.3)} fillOpacity={fill} {...line} style={fade} />
        <polygon points={gable} fill={`url(#${defs}-brick)`} opacity={fill} style={fade} />
        <polygon points={gable} fill={BG} fillOpacity={ghost ? 0 : 0.22} style={fade} />
        <g opacity={fill} style={fade}>
          <circle cx={ox} cy={oy} r="9" fill={`url(#${defs}-bloom)`} opacity={topped ? 1 : 0} style={lamp} />
          <circle cx={ox} cy={oy} r={or} fill={GLASS} />
          <circle cx={ox} cy={oy} r={or} fill={`url(#${defs}-pane)`} fillOpacity={topped ? 1 : 0} style={lamp} />
          <path d={`M${px(ox - or)} ${oy}A${or} ${or} 0 0 1 ${ox} ${px(oy - or)}Z`} fill={SKY} fillOpacity={topped ? 0 : 0.2} style={lamp} />
          <circle cx={ox} cy={oy} r={or} fill="none" stroke={INK} strokeOpacity="0.8" strokeWidth="0.9" />
        </g>
        {/* Under a roof hung in the air, its own shade; gone once it sits on the cornice. */}
        <rect y={rise} width={SIDE_PX} height="6" fill={`url(#${defs}-eave)`} opacity={mode === 'kit' ? 1 : 0}
          style={{ transition: `opacity 300ms ease ${topped ? 1250 : 0}ms` }} />
      </g>
      <polygon points={pts([at(br), at(rr), at(er), at(drop(er)), at(drop(rr)), at(drop(br))])} fill={SLATE_EDGE} fillOpacity={fill} {...line} style={fade} />
      <polygon points={pts([at(el), at(er), at(drop(er)), at(drop(el))])} fill={SLATE_EDGE} fillOpacity={fill} {...line} style={fade} />
      <g transform={planeMatrix(r0, unit(sub(r1, r0)), unit(sub(e0, r0)))}>
        <rect width={px(len(sub(r1, r0)))} height={px(len(sub(e0, r0)))} fill={SLATE} fillOpacity={fill} style={fade} />
        <rect width={px(len(sub(r1, r0)))} height={px(len(sub(e0, r0)))} fill={`url(#${defs}-tiles)`} opacity={fill} style={fade} />
        <rect width={px(len(sub(r1, r0)))} height={px(len(sub(e0, r0)))} fill={`url(#${defs}-slope)`} opacity={fill} style={fade} />
        <rect width={px(len(sub(r1, r0)))} height={px(len(sub(e0, r0)))} fill="none" {...line} />
      </g>
      <line x1={px(r0[0])} y1={px(r0[1])} x2={px(r1[0])} y2={px(r1[1])}
        stroke={ghost ? mixHex(BG, INK, 0.5) : topped ? GREEN : mixHex(INK, '#ffffff', 0.2)} strokeWidth={ghost ? 1 : 2.6} strokeLinecap="round"
        strokeDasharray={ghost ? '3 3' : undefined} style={{ transition: `stroke 300ms ease ${late}ms` }} data-ridge="" />
      <g opacity={fill} style={fade}>
        <g transform={wallMatrix([cx, cy + size, top], 'x', U)}>
          <rect width={csz} height={stackH} fill={mixHex(BG, INK, 0.36)} />
          <rect width={csz} height={stackH} fill={`url(#${defs}-brick)`} />
          <rect width={csz} height={stackH} fill="none" {...line} />
        </g>
        <g transform={wallMatrix([cx + size, cy + size, top], '-y', U)}>
          <polygon points={pts(stackSide)} fill={mixHex(BG, INK, 0.24)} />
          <polygon points={pts(stackSide)} fill={`url(#${defs}-brick)`} />
        </g>
        <polygon points={pts(cap.right)} fill={mixHex(STONE, BG, 0.4)} />
        <polygon points={pts(cap.left)} fill={mixHex(STONE, BG, 0.25)} />
        <polygon points={pts(cap.top)} fill={mixHex(STONE, INK, 0.2)} />
      </g>
      {topped && (
        <g data-smoke="">
          {[0, 1, 2, 3].map((i) => (
            <circle key={i} className="iso-smoke" cx={px(flue[0])} cy={px(flue[1])} r={px(3 + i * 0.9)} fill={`url(#${defs}-puff)`}
              style={{ animationDelay: `${1600 + i * 500}ms` }} />
          ))}
        </g>
      )}
      {topped && (
        <g data-flag="">
          <line className="granary-flag-pole" x1={px(foot[0])} y1={px(foot[1])} x2={px(head[0])} y2={px(head[1])} stroke={INK} strokeOpacity="0.9" strokeWidth="1.1" />
          <g transform={wallMatrix([x + W + OVER_GABLE, y + D / 2, e + RISE + FLAG_H], '-y', U)}>
            <polygon className="granary-flag-unfurl" points="0,0.4 15,4.1 0,7.8" fill={GREEN} />
          </g>
        </g>
      )}
      <Dust defs={defs} x={x} y={y} few />
    </g>
  );
}

/* ─────────────── the street, YOUR WALLET and the lanes ─────────────── */

/** A straight line between two points of the world; `ruled`, it carries its own length for the pen (index.css, the intro). */
function Seg({ a, b, stroke, opacity, width, ruled = false }: { a: P3; b: P3; stroke: string; opacity: number; width?: number; ruled?: boolean }) {
  const p = iso(a, U);
  const q = iso(b, U);
  return (
    <line x1={px(p[0])} y1={px(p[1])} x2={px(q[0])} y2={px(q[1])} stroke={stroke} strokeOpacity={opacity} strokeWidth={width}
      style={ruled ? pen(Math.hypot(q[0] - p[0], q[1] - p[1])) : undefined} />
  );
}

/**
 * The street's hairlines on the ground: the kerb along its near edge, a tick where each network's
 * buildings begin, and the network's name lettered on its ground in its lanes' colour.
 */
function Street({ plan, lots, cut }: { plan: CityPlan; lots: readonly Lot[]; cut: Cut }) {
  const end = Math.max(...lots.map((l) => l.x + l.length)) + M;
  const k = plan.kerb;
  return (
    <g pointerEvents="none" data-street="">
      <Seg a={[plan.wx - W_POD_OVER, k, 0]} b={[end, k, 0]} stroke={INK} opacity={0.24} width={0.7} ruled />
      {lots.filter((l) => l.first).map((lot) => (
        <Fragment key={lot.chain}>
          <Seg a={[lot.x - M, k - 0.22, 0]} b={[lot.x - M, k + 0.22, 0]} stroke={INK} opacity={0.5} width={0.8} ruled />
          <text transform={groundMatrix([lot.x - M + 0.22, k - 0.13, 0], U)} fontSize={cut === 'm' ? 11 : 9.2} letterSpacing="2.1"
            fill={NET_COLOUR[lot.chain]} fillOpacity="0.85" style={MONO} data-chain-name="">
            {HARVEST_CHAIN_LABEL[lot.chain].toUpperCase()}
          </text>
        </Fragment>
      ))}
    </g>
  );
}

const PLATE_EDGE = { stroke: BG, strokeOpacity: 0.9, strokeWidth: 0.9, strokeLinejoin: 'round' as const };

/**
 * YOUR WALLET, a glass pavilion at the head of the street: one door per network on the face the street
 * runs into, and inside it one plate per claim paid, each the same size, stacked on its network's spot
 * in the order paid. Its floor, lamp and doors light only once a claim is paid. Its name is lettered
 * large enough to read at the size the drawing is drawn (`scale`, sheet px to screen px).
 */
function Wallet({ defs, plan, cut, scale }: { defs: string; plan: CityPlan; cut: Cut; scale: number }) {
  const { wx: X, wy: Y, doors } = plan;
  const T = WT;
  const paid = plan.lanes.filter((l) => l.storey.state === 'claimed').sort((a, b) => a.storey.n - b.storey.n);
  const lit = paid.length > 0;
  // It lights as the first plate comes down (index.css: the run, then the plate).
  const light: CSSProperties = { transition: ['fill', 'fill-opacity', 'opacity'].map((p) => `${p} 600ms ease ${lit ? 1450 : 0}ms`).join(', ') };
  const face = (list: P3[]) => pts(list.map((c) => iso(c, U)));
  const edge = (opacity: number) => ({ stroke: INK, strokeOpacity: opacity, strokeWidth: 1, strokeLinejoin: 'round' as const });
  const podium = solid(X - W_POD_OVER, Y - W_POD_OVER, T + 2 * W_POD_OVER, T + 2 * W_POD_OVER, W_POD, W_POD, U, 0);
  const roof = solid(X - W_ROOF_OVER, Y - W_ROOF_OVER, T + 2 * W_ROOF_OVER, T + 2 * W_ROOF_OVER, W_ROOF_T, W_ROOF_T, U, W_GLASS);
  const sixths = [1, 2, 3, 4, 5].map((i) => (T * i) / 6);
  const glow = iso([X + T / 2, Y + T / 2, W_POD], U);
  const lan = 0.8;
  const top = W_GLASS + W_ROOF_T;
  const size = walletNameSize(cut, scale);
  // Its halo grows with it, from the cut's own.
  const halo = px(((cut === 'm' ? 3 : 2.2) * size) / (cut === 'm' ? 10.4 : 7.4));
  const name = walletLabel(plan, size);
  const sky = px((W_GLASS - W_POD) * U);
  return (
    <g pointerEvents="none" data-wallet="" data-lit={lit ? 'on' : 'off'}>
      <polygon points={pts(podium.right)} fill={mixHex(BG, INK, 0.1)} {...edge(0.4)} />
      <polygon points={pts(podium.left)} fill={mixHex(BG, INK, 0.14)} {...edge(0.4)} />
      <polygon points={pts(podium.top)} fill={mixHex(BG, INK, 0.2)} {...edge(0.4)} />
      <polygon points={face([[X, Y, W_POD], [X + T, Y, W_POD], [X + T, Y + T, W_POD], [X, Y + T, W_POD]])} fill={mixHex(BG, GLOW, lit ? 0.3 : 0.1)}
        style={light} data-wallet-floor="" />
      <ellipse cx={px(glow[0])} cy={px(glow[1])} rx={px(T * U * 0.82)} ry={px(T * U * 0.47)} fill={`url(#${defs}-wglow)`} opacity={lit ? 0.9 : 0.3}
        style={light} data-wallet-glow="" />
      {/* The two back walls, seen from inside through the front glass. */}
      <polygon points={face([[X, Y, W_GLASS], [X, Y + T, W_GLASS], [X, Y + T, W_POD], [X, Y, W_POD]])} fill={mixHex(BG, GLASS_TINT, 0.15)} />
      <polygon points={face([[X, Y, W_GLASS], [X + T, Y, W_GLASS], [X + T, Y, W_POD], [X, Y, W_POD]])} fill={mixHex(BG, GLASS_TINT, 0.2)} />
      {sixths.map((t) => (
        <Fragment key={t}>
          <Seg a={[X, Y + t, W_POD]} b={[X, Y + t, W_GLASS]} stroke={INK} opacity={0.12} />
          <Seg a={[X + t, Y, W_POD]} b={[X + t, Y, W_GLASS]} stroke={INK} opacity={0.12} />
        </Fragment>
      ))}
      {doors.map((d) => (
        <Fragment key={d.chain}>
          <polygon points={face([[d.spot[0], d.spot[1], W_POD], [d.spot[0] + PLATE, d.spot[1], W_POD], [d.spot[0] + PLATE, d.spot[1] + PLATE, W_POD], [d.spot[0], d.spot[1] + PLATE, W_POD]])}
            fill="none" stroke={INK} strokeOpacity="0.4" strokeWidth="0.8" strokeDasharray="2 2" data-spot={d.chain} />
          {paid.filter((l) => l.storey.chain === d.chain).map((l, i) => {
            const s = solid(d.spot[0], d.spot[1], PLATE, PLATE, plan.plateT, plan.plateT, U, W_POD + i * (plan.plateT + plan.plateAir));
            return (
              <g key={l.storey.key} data-landed={l.storey.key}>
                <polygon points={pts(s.right)} fill={mixHex(BG, GREEN, 0.4)} {...PLATE_EDGE} />
                <polygon points={pts(s.left)} fill={mixHex(BG, GREEN, 0.62)} {...PLATE_EDGE} />
                <polygon points={pts(s.top)} fill={GREEN} {...PLATE_EDGE} />
              </g>
            );
          })}
        </Fragment>
      ))}
      {/* The front glass: the two faces the eye sees, the sky in each, the transom, a door per network. */}
      <polygon points={face([[X, Y + T, W_GLASS], [X + T, Y + T, W_GLASS], [X + T, Y + T, W_POD], [X, Y + T, W_POD]])} fill={GLASS_TINT} fillOpacity="0.09" />
      <polygon points={face([[X + T, Y + T, W_GLASS], [X + T, Y, W_GLASS], [X + T, Y, W_POD], [X + T, Y + T, W_POD]])} fill={GLASS_TINT} fillOpacity="0.06" />
      <g transform={wallMatrix([X, Y + T, W_GLASS], 'x', U)}>
        <rect width={px(T * U)} height={sky} fill={`url(#${defs}-wsky)`} />
      </g>
      <g transform={wallMatrix([X + T, Y + T, W_GLASS], '-y', U)}>
        <rect width={px(T * U)} height={sky} fill={`url(#${defs}-wsky)`} opacity="0.7" />
      </g>
      {sixths.map((t) => (
        <Fragment key={t}>
          <Seg a={[X + t, Y + T, W_HEAD]} b={[X + t, Y + T, W_GLASS]} stroke={INK} opacity={0.3} />
          <Seg a={[X + T, Y + t, W_HEAD]} b={[X + T, Y + t, W_GLASS]} stroke={INK} opacity={0.3} />
        </Fragment>
      ))}
      <polyline points={face([[X, Y + T, W_HEAD], [X + T, Y + T, W_HEAD], [X + T, Y, W_HEAD]])} fill="none" stroke={INK} strokeOpacity="0.5" strokeWidth="1" />
      {doors.map((d) => (
        <polygon key={d.chain} points={face([[X + T, d.hi, W_POD], [X + T, d.hi, W_HEAD], [X + T, d.lo, W_HEAD], [X + T, d.lo, W_POD]])} fill={GLOW}
          fillOpacity={paid.some((l) => l.storey.chain === d.chain) ? 0.16 : 0.05} stroke={INK} strokeOpacity="0.9" strokeWidth="1.3" strokeLinejoin="round"
          style={light} data-door={d.chain} />
      ))}
      {sixths.map((t) => (
        <Fragment key={t}>
          <Seg a={[X + t, Y + T, W_POD]} b={[X + t, Y + T, W_HEAD]} stroke={INK} opacity={0.3} />
          {!doors.some((d) => Y + t > d.lo - 0.05 && Y + t < d.hi + 0.05) && <Seg a={[X + T, Y + t, W_POD]} b={[X + T, Y + t, W_HEAD]} stroke={INK} opacity={0.3} />}
        </Fragment>
      ))}
      <Seg a={[X + T, Y + T, W_POD]} b={[X + T, Y + T, W_GLASS]} stroke={INK} opacity={0.95} width={2} />
      <Seg a={[X, Y + T, W_POD]} b={[X, Y + T, W_GLASS]} stroke={INK} opacity={0.7} width={1.4} />
      <Seg a={[X + T, Y, W_POD]} b={[X + T, Y, W_GLASS]} stroke={INK} opacity={0.7} width={1.4} />
      {/* The roof, a thin slab, and in it a lantern the light below shows through. */}
      <polygon points={pts(roof.right)} fill={mixHex(BG, INK, 0.22)} {...edge(0.6)} />
      <polygon points={pts(roof.left)} fill={mixHex(BG, INK, 0.32)} {...edge(0.6)} />
      <polygon points={pts(roof.top)} fill={mixHex(BG, INK, 0.17)} {...edge(0.6)} />
      <polygon points={face([[X + lan, Y + lan, top], [X + T - lan, Y + lan, top], [X + T - lan, Y + T - lan, top], [X + lan, Y + T - lan, top]])}
        fill={mixHex(BG, GLOW, lit ? 0.6 : 0.22)} stroke={INK} strokeOpacity="0.4" strokeWidth="0.8" style={light} data-lantern="" />
      {[1, 2, 3].map((i) => {
        const t = lan + ((T - 2 * lan) * i) / 4;
        return <Seg key={i} a={[X + t, Y + lan, top]} b={[X + t, Y + T - lan, top]} stroke={BG} opacity={0.55} />;
      })}
      {/* Its name, a callout off the lantern, as a drawing letters a part. */}
      <line x1={px(name.foot[0])} y1={px(name.foot[1])} x2={px(name.foot[0])} y2={px(name.at[1] + 3)} stroke={INK} strokeOpacity="0.7" strokeWidth="0.8" />
      <circle cx={px(name.foot[0])} cy={px(name.foot[1])} r="1.3" fill={INK} />
      <text x={px(name.at[0])} y={px(name.at[1])} textAnchor="middle" fontSize={size} letterSpacing="1.1" fontWeight="700"
        fill={INK} stroke={BG} strokeOpacity="0.9" strokeWidth={halo} strokeLinejoin="round" paintOrder="stroke" style={MONO}
        data-wallet-name="">
        YOUR WALLET
      </text>
    </g>
  );
}

/** The light amber dashed inside the lane of the claim at the wallet. */
const MARCH = mixHex(AMBER, '#ffffff', 0.35);

/**
 * One lane a claim, in the street's order, then (drawn at a size it can be read) each lane's number
 * where it leaves its building. A lane is painted by its claim's state alone (lanePaint), the same for
 * every coin; it moves only once its claim is paid (index.css: the green run).
 */
function Lanes({ plan, active, cut }: { plan: CityPlan; active: string | null; cut: Cut }) {
  return (
    <>
      <g pointerEvents="none" data-lanes="">
        {plan.lanes.map((l) => <LaneFigure key={l.storey.key} plan={plan} lane={l} pointed={active === l.storey.key} />)}
      </g>
      {cut === 'l' && (
        <g pointerEvents="none" data-lane-tags="">
          {plan.lanes.map((l) => <LaneTag key={l.storey.key} lane={l} pointed={active === l.storey.key} />)}
        </g>
      )}
    </>
  );
}

/**
 * A lane: a stub out of its building's front, the run along the street, the wallet's step and the
 * threshold to its network's door; one whose claim did not land stops halfway, behind a bar across it.
 */
function LaneFigure({ plan, lane, pointed }: { plan: CityPlan; lane: Lane; pointed: boolean }) {
  const s = lane.storey;
  const paint = lanePaint(s.state, pointed);
  const path = paint.short ? laneHalf(plan, lane) : laneRoute(plan, lane);
  const line = { points: pts(path.map((c) => iso(c, U))), fill: 'none', strokeLinejoin: 'round' as const };
  const w = plan.laneW * U;
  // Paid, it turns green once its run reaches the door (750 + 700 ms); pointed at before a run, at once.
  const tint: CSSProperties = {
    transition: ['stroke', 'stroke-opacity'].map((p) => `${p} ${s.state === null ? '200ms ease-out' : '300ms ease'} ${s.state === 'claimed' ? 1450 : 0}ms`).join(', '),
  };
  // The stop bar: across the lane where it ends, 0.16 to each side.
  const [end, prev] = [path[path.length - 1]!, path[path.length - 2]!];
  const run = Math.hypot(end[0] - prev[0], end[1] - prev[1]) || 1;
  const [nx, ny] = [((prev[1] - end[1]) / run) * 0.16, ((end[0] - prev[0]) / run) * 0.16];
  const [b0, b1] = [iso([end[0] - nx, end[1] - ny, end[2]], U), iso([end[0] + nx, end[1] + ny, end[2]], U)];
  return (
    <g data-lane={s.key} data-state={s.state ?? 'ready'} data-net={s.chain} data-hot={pointed ? '' : undefined}>
      {paint.glow && <polyline {...line} stroke={paint.glow} strokeOpacity="0.2" strokeWidth={px(w * 2.8)} strokeLinecap="round" style={tint} data-lane-glow="" />}
      <polyline {...line} stroke={BG} strokeWidth={px(w + 2.4)} data-lane-bed="" />
      <polyline {...line} stroke={paint.line ?? NET_COLOUR[s.chain]} strokeOpacity={paint.lineOpacity} strokeWidth={px(w)} strokeDasharray={paint.dash}
        style={tint} data-lane-line="" />
      {paint.run && <polyline {...line} stroke={GREEN} strokeWidth={px(w)} pathLength={1} data-lane-run="" />}
      {paint.core && <polyline {...line} stroke={paint.core} strokeWidth={px(w * 0.42)} style={tint} data-lane-core="" />}
      {paint.march && <polyline {...line} stroke={MARCH} strokeWidth={px(w * 0.42)} strokeDasharray="3 5" data-lane-march="" />}
      {paint.short && (
        <line x1={px(b0[0])} y1={px(b0[1])} x2={px(b1[0])} y2={px(b1[1])} stroke={paint.line ?? INK} strokeWidth="1.6" strokeLinecap="round" data-lane-stop="" />
      )}
    </g>
  );
}

/** A lane's number on a small plate where it leaves its building: its row's number, in its state's paint. */
function LaneTag({ lane, pointed }: { lane: Lane; pointed: boolean }) {
  const s = lane.storey;
  const paint = lanePaint(s.state, pointed);
  const [cx, cy] = iso([lane.x, D + M + 0.3, 0], U);
  const num = pad2(s.n);
  // It turns with its storey: green as the storey is set down (750 ms).
  const tint: CSSProperties = {
    transition: ['fill', 'fill-opacity', 'stroke'].map((p) => `${p} ${s.state === null ? '200ms ease-out' : '300ms ease'} ${s.state === 'claimed' ? 750 : 0}ms`).join(', '),
  };
  return (
    <g data-lane-n={num}>
      <rect x={px(cx - 5.7)} y={px(cy - 3.4)} width="11.4" height="6.8" fill={paint.plate} fillOpacity={paint.plateOpacity} stroke={paint.plateEdge}
        strokeWidth="0.7" strokeDasharray={paint.plateDash} style={tint} />
      <text x={px(cx)} y={px(cy + 2.2)} textAnchor="middle" fontSize="6.1" fontWeight="700" fill={paint.plateText} style={{ ...MONO, ...tint }}>{num}</text>
    </g>
  );
}
