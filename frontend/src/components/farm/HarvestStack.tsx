import { useEffect, useState, type CSSProperties } from 'react';
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK, mixHex } from '../../lib/editorial';
import { bounds, groundMatrix, iso, pts, solid, type Pt } from '../../lib/iso';
import { HARVEST_CHAIN_LABEL, HARVEST_CHAIN_ORDER, type ClaimState, type HarvestChain } from '../../lib/harvest/types';

/**
 * Harvest's figure (owner, 2026-11-14: "next gen esp the harvest"): the claims as plates, drawn as
 * an architect's exploded axonometric. One stack per chain, side by side in the order a harvest runs; one plate
 * per claim, in the order it is sent, each in its room's colour.
 *
 * ⚠️ IT DRAWS THE RUN, NOT THE MONEY. Every plate is the same size: the claims are in different
 * coins and no price is read here, so a bigger plate would be a comparison nobody made. What a
 * plate shows is where its claim stands, and nothing else:
 *   - ready, or waiting its turn: afloat, apart from its neighbours;
 *   - at the wallet: lifted clear, in amber, breathing;
 *   - claimed: green, and down on the pad, each on the last, so a harvest that lands builds a
 *     solid block from the ground up;
 *   - refused on chain, or not confirmed: left afloat, in that state's colour;
 *   - cancelled, or never sent: left afloat, as a dashed outline.
 * The ledger beside it says each of these in words, with the amount, the reason and the
 * transaction (HarvestCard.tsx); this is hidden from assistive tech.
 *
 * While the pools are being read there are no plates to draw, so the pad is drawn alone with a
 * line sweeping across it. Nothing to claim is the pad alone, still.
 */

export interface StackPlate {
  key: string;
  chain: HarvestChain;
  /** The room's colour, `#rrggbb`. */
  accent: string;
  /** Null before a run: ready to claim. */
  state: ClaimState['kind'] | null;
}

const U = 20;
/** A pad's side, a plate's thickness, and the air between two plates afloat. */
const SIDE = 4;
const THICK = 0.46;
const AIR = 0.62;
/** How far the lowest plate afloat stands off what is under it. */
const FLOAT = 1.1;
const LIFT = 0.5;
/** From one pad to the next. The pads stand side by side across the sheet, so each steps along x and back along y. */
const STEP = SIDE + 0.7;
const INSET = 0.3;

const AMBER = '#e3b341';
const REFUSED = '#f08a6b';
const UNSURE = '#f0b26b';

const MONO = { fontFamily: 'var(--font-family-mono)' } as const;

function paint(plate: StackPlate, hot: boolean) {
  const accent = plate.accent;
  const base = { stroke: EDITORIAL_INK, strokeOpacity: 0.6, dash: undefined as string | undefined, width: 1 };
  switch (plate.state) {
    case 'claimed':
      return { ...base, top: EDITORIAL_GREEN, left: mixHex(EDITORIAL_BG, EDITORIAL_GREEN, 0.62), right: mixHex(EDITORIAL_BG, EDITORIAL_GREEN, 0.4), stroke: EDITORIAL_BG, strokeOpacity: 0.9 };
    case 'sending':
      return { ...base, top: mixHex(EDITORIAL_BG, AMBER, 0.55), left: mixHex(EDITORIAL_BG, AMBER, 0.3), right: mixHex(EDITORIAL_BG, AMBER, 0.18), stroke: AMBER, strokeOpacity: 1, width: 1.5 };
    case 'reverted':
      return { ...base, top: mixHex(EDITORIAL_BG, REFUSED, 0.4), left: mixHex(EDITORIAL_BG, REFUSED, 0.22), right: mixHex(EDITORIAL_BG, REFUSED, 0.12), stroke: REFUSED, strokeOpacity: 1 };
    case 'unconfirmed':
      return { ...base, top: mixHex(EDITORIAL_BG, UNSURE, 0.28), left: mixHex(EDITORIAL_BG, UNSURE, 0.16), right: mixHex(EDITORIAL_BG, UNSURE, 0.09), stroke: UNSURE, strokeOpacity: 1, dash: '4 3' };
    case 'declined':
    case 'not-sent':
      return { ...base, top: mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.05), left: EDITORIAL_BG, right: EDITORIAL_BG, strokeOpacity: 0.4, dash: '3 3' };
    case 'waiting':
      return { ...base, top: mixHex(EDITORIAL_BG, accent, 0.3), left: mixHex(EDITORIAL_BG, accent, 0.16), right: mixHex(EDITORIAL_BG, accent, 0.09), strokeOpacity: hot ? 1 : 0.45 };
    default:
      return { ...base, top: mixHex(EDITORIAL_BG, accent, hot ? 0.85 : 0.5), left: mixHex(EDITORIAL_BG, accent, hot ? 0.5 : 0.28), right: mixHex(EDITORIAL_BG, accent, hot ? 0.3 : 0.15), stroke: hot ? '#ffffff' : EDITORIAL_INK, strokeOpacity: hot ? 1 : 0.6 };
  }
}

export function HarvestStack({ plates, reading = false, active = null, onActive, className = '' }: {
  plates: readonly StackPlate[];
  reading?: boolean;
  /** The claim a ledger row is pointed at, by key: its plate lights. */
  active?: string | null;
  onActive?: (key: string | null) => void;
  className?: string;
}) {
  // The plates rise off the pad once drawn, each a beat after the last.
  const [risen, setRisen] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setRisen(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const chains = HARVEST_CHAIN_ORDER.filter((c) => plates.some((p) => p.chain === c));
  // With nothing read yet, or nothing to claim, one pad stands alone.
  const pads: (HarvestChain | null)[] = chains.length ? chains : [null];
  const most = Math.max(1, ...chains.map((c) => plates.filter((p) => p.chain === c).length));
  // A tall stack closes up, so a wallet with many positions still fits its frame.
  const air = most > 6 ? Math.max(0.14, (AIR * 6) / most) : AIR;
  const tallest = FLOAT + LIFT + most * (THICK + air);

  const corner = (i: number, dx: number, dy: number, z: number): Pt => iso([i * STEP + dx, -i * STEP + dy, z], U);

  const frame: Pt[] = pads.flatMap((_, i) => [
    corner(i, 0, 0, 0), corner(i, SIDE, 0, 0), corner(i, SIDE, SIDE + 0.9, 0), corner(i, 0, SIDE + 0.9, 0),
    corner(i, 0, 0, tallest), corner(i, SIDE, 0, tallest), corner(i, 0, SIDE, tallest),
  ]);
  const [bx, by, bw, bh] = bounds(frame);

  return (
    <svg
      viewBox={`${Math.floor(bx - 8)} ${Math.floor(by - 8)} ${Math.ceil(bw + 16)} ${Math.ceil(bh + 16)}`}
      aria-hidden="true"
      data-testid="harvest-stack"
      preserveAspectRatio="xMidYMax meet"
      className={`block w-full select-none ${className}`}
      onMouseLeave={() => onActive?.(null)}
    >
      {pads.map((chain, i) => {
        const mine = chain ? plates.filter((p) => p.chain === chain) : [];
        const pad: Pt[] = [corner(i, 0, 0, 0), corner(i, SIDE, 0, 0), corner(i, SIDE, SIDE, 0), corner(i, 0, SIDE, 0)];
        const lines: [Pt, Pt][] = [];
        for (let g = 1; g < SIDE; g++) {
          lines.push([corner(i, g, 0, 0), corner(i, g, SIDE, 0)], [corner(i, 0, g, 0), corner(i, SIDE, g, 0)]);
        }
        // Where each plate stands: the claimed ones down on the pad in the order they landed
        // there, the rest afloat above them in the order they are sent.
        let banked = 0;
        let afloat = 0;
        const placed = mine.map((plate) => {
          const down = plate.state === 'claimed';
          const z = down
            ? banked * THICK
            : mine.filter((p) => p.state === 'claimed').length * THICK + FLOAT + afloat * (THICK + air) + (plate.state === 'sending' ? LIFT : 0);
          if (down) banked += 1;
          else afloat += 1;
          return { plate, z };
        });
        const top = Math.max(0, ...placed.map((p) => p.z + THICK));
        const body = solid(i * STEP + INSET, -i * STEP + INSET, SIDE - 2 * INSET, SIDE - 2 * INSET, THICK, THICK, U);
        return (
          <g key={chain ?? 'pad'}>
            <polygon points={pts(pad)} fill={EDITORIAL_BG} fillOpacity="0.6" stroke={EDITORIAL_INK} strokeOpacity={mine.length ? 0.4 : 0.3}
              strokeDasharray={mine.length || reading ? undefined : '4 4'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            <g stroke={EDITORIAL_INK} strokeOpacity="0.1" strokeWidth="1">
              {lines.map(([a, b], n) => <line key={n} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} vectorEffect="non-scaling-stroke" />)}
            </g>
            {reading && mine.length === 0 && (
              <line className="harvest-scan" x1={pad[0]![0]} y1={pad[0]![1]} x2={pad[3]![0]} y2={pad[3]![1]}
                stroke={EDITORIAL_GREEN} strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                style={{ '--scan-x': `${pad[1]![0] - pad[0]![0]}px`, '--scan-y': `${pad[1]![1] - pad[0]![1]}px` } as CSSProperties} />
            )}
            {chain && (
              <text transform={groundMatrix([i * STEP, -i * STEP + SIDE + 0.74, 0], U)} fontSize="11.5" letterSpacing="0.16em"
                fill={EDITORIAL_INK} fillOpacity="0.6" style={{ ...MONO, textTransform: 'uppercase' }}>
                {HARVEST_CHAIN_LABEL[chain]}
              </text>
            )}
            {/* The exploded view's guides: a dashed line up each corner the plates were lifted along. */}
            {mine.length > 0 && (
              <g stroke={EDITORIAL_INK} strokeOpacity="0.28" strokeWidth="1" strokeDasharray="2 4">
                {([[INSET, INSET], [SIDE - INSET, INSET], [SIDE - INSET, SIDE - INSET], [INSET, SIDE - INSET]] as const).map(([dx, dy]) => {
                  const foot = corner(i, dx, dy, 0);
                  const head = corner(i, dx, dy, risen ? top : THICK);
                  return <line key={`${dx}:${dy}`} x1={foot[0]} y1={foot[1]} x2={head[0]} y2={head[1]} vectorEffect="non-scaling-stroke" style={{ transition: 'all 0.8s cubic-bezier(0.22, 1, 0.36, 1)' }} />;
                })}
              </g>
            )}
            {placed.map(({ plate, z }, n) => {
              const hot = active === plate.key;
              const p = paint(plate, hot);
              const face = { stroke: p.stroke, strokeOpacity: p.strokeOpacity, strokeWidth: p.width, strokeDasharray: p.dash, strokeLinejoin: 'round' as const, vectorEffect: 'non-scaling-stroke' as const, style: { transition: 'fill 0.5s ease, stroke 0.5s ease' } };
              const rise = (risen ? z : 0) * U + (hot && plate.state !== 'claimed' ? 5 : 0);
              return (
                <g key={plate.key} data-plate={plate.key} data-state={plate.state ?? 'ready'}
                  onMouseEnter={() => onActive?.(plate.key)}
                  style={{ transform: `translateY(${rise ? -rise : 0}px)`, transition: `transform 0.8s cubic-bezier(0.22, 1, 0.36, 1) ${risen && plate.state === null ? Math.min(n, 12) * 55 : 0}ms` }}>
                  <g className={plate.state === 'sending' ? 'harvest-breathe' : undefined}>
                    <polygon points={pts(body.right)} fill={p.right} {...face} />
                    <polygon points={pts(body.left)} fill={p.left} {...face} />
                    <polygon points={pts(body.top)} fill={p.top} {...face} />
                  </g>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
