import { useId } from 'react';
import { formatEther } from 'viem';
import { EDITORIAL_BG, EDITORIAL_GREEN, EDITORIAL_INK, mixHex } from '../../lib/editorial';
import { useDrawWidth } from '../../hooks/useDrawWidth';
import type { LendingMarket } from '../../lib/gondi/lenderPitch';
import { sameAddress } from '../../lib/gondi/loanOffer.js';
import { wallElevation, wallFacts, type WallShare } from '../../lib/gondi/wall';
import { COLLECTIONS, COLLECTION_ART } from '../nftfinance/nftLendingShared';

/** The sheet's violet (styles/dwg.css, --dwg-spot under data-sheet L), amber for unread, coral for over the floor. */
const SPOT = '#b79cff';
const WARN = '#f0b26b';
const BAD = '#f08a6b';
const ink = (a: number) => `rgba(245, 228, 184, ${a})`;

/** A 45 degree hatch in one ink: a faint ground and a line. */
function Hatch({ id, color, step, alpha }: { id: string; color: string; step: number; alpha: readonly [number, number] }) {
  return (
    <pattern id={id} width={step} height={step} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={step} height={step} fill={color} fillOpacity={alpha[0]} />
      <rect width="1" height={step} fill={color} fillOpacity={alpha[1]} />
    </pattern>
  );
}

/**
 * L-01's instrument (owner, 2026-11-15): an elevation of one gallery wall for the collection the
 * lender picked. The picture stands from datum 0 to the FLOOR, the BEST BID is a level under it,
 * and the loan typed is a third level that moves. It reads nothing itself: the market card's own
 * read, the amount and the floor-share chips come in as props (lib/gondi/wall.ts does the sums).
 * A floor not read draws nothing at a height. Decoration to a reader: aria-hidden, no <text>,
 * every word drawn from data-t and data-v.
 */
export function LoanWall({ collection, market, loading, principalWei, shares }: {
  collection: string;
  market: LendingMarket | undefined;
  loading: boolean;
  principalWei: bigint | null;
  shares: readonly WallShare[];
}) {
  const [box, W] = useDrawWidth();
  const uid = `wall${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const col = COLLECTIONS.find((c) => sameAddress(c.address, collection)) ?? COLLECTIONS[0]!;
  const principal = principalWei !== null && principalWei > 0n ? Number(formatEther(principalWei)) : null;
  const f = wallFacts({ market, loading, principal, shares });
  const d = wallElevation(W, f, col);
  const scaled = f.mode === 'scaled';
  const { x0, x1, wallW, scaleH, yHead, yRail, yS, y0, yG, sx, sw } = d;
  const p = d.picture;
  const tx = x1 + (d.compact ? 26 : 30);
  const key = scaled ? 'ELEVATION A · PICTURE HEIGHT = THE FLOOR' : f.mode === 'nts' ? 'ELEVATION A · NOT TO SCALE: FLOOR NOT READ' : 'ELEVATION A · READING THE MARKET';
  const at = (x: number, y: number) => ({ left: Math.round(x), top: Math.round(y) });

  return (
    <div className="l01-wallslot" aria-hidden="true">
      <div ref={box} className="l01-wall" data-mode={f.mode} data-zone={f.zone ?? undefined}>
        <div className="dwg-figwrap l01-wall-wrap" style={{ height: d.H }}>
          <svg className="dwg-fig l01-wall-fig" viewBox={`0 0 ${d.W} ${d.H}`} width={d.W} height={d.H} focusable="false">
            <defs>
              <Hatch id={`${uid}-z-covered`} color={EDITORIAL_GREEN} step={5} alpha={[0.2, 0.95]} />
              <Hatch id={`${uid}-z-under-floor`} color={WARN} step={5} alpha={[0.2, 0.95]} />
              <Hatch id={`${uid}-z-over-floor`} color={BAD} step={5} alpha={[0.2, 0.95]} />
              <Hatch id={`${uid}-l-covered`} color={EDITORIAL_GREEN} step={9} alpha={[0.1, 0.7]} />
              <Hatch id={`${uid}-l-under-floor`} color={WARN} step={9} alpha={[0.1, 0.7]} />
              <Hatch id={`${uid}-l-over-floor`} color={BAD} step={9} alpha={[0.1, 0.7]} />
              <pattern id={`${uid}-earth`} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                <rect width="1" height="7" fill={ink(0.45)} />
              </pattern>
              <pattern id={`${uid}-plaster`} width="9" height="9" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="0.55" fill={ink(0.16)} />
                <circle cx="6.5" cy="6.5" r="0.55" fill={ink(0.1)} />
              </pattern>
              <clipPath id={`${uid}-wall`}>
                <rect x={x0} y={yS} width={wallW} height={scaleH} />
              </clipPath>
              <clipPath id={`${uid}-pic`}>
                <rect x={p.x + 12} y={p.y + 12} width={Math.max(0, p.side - 24)} height={Math.max(0, p.side - 24)} />
              </clipPath>
            </defs>

            {/* The ground the wall stands on, then the wall: plaster, a plinth under datum 0, a picture rail. */}
            <rect x={x0 - 30} y={yG} width={wallW + 60} height="9" fill={`url(#${uid}-earth)`} />
            <line x1={x0 - 34} y1={yG} x2={x1 + 34} y2={yG} stroke={EDITORIAL_INK} strokeWidth="2" />
            <rect x={x0} y={yHead} width={wallW} height={y0 - yHead} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.075)} />
            <rect x={x0} y={yHead} width={wallW} height={y0 - yHead} fill={`url(#${uid}-plaster)`} />
            <rect x={x0} y={y0} width={wallW} height={yG - y0} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.13)} />
            <rect className="dwg-draw" pathLength={1} x={x0} y={yHead} width={wallW} height={yG - yHead} fill="none" stroke={ink(0.62)} strokeWidth="1" />
            <line x1={x0} y1={yRail} x2={x1} y2={yRail} stroke={ink(0.5)} strokeWidth="1" />
            <line x1={x0} y1={yRail + 3} x2={x1} y2={yRail + 3} stroke={ink(0.22)} strokeWidth="1" />

            {/* The staff: datum 0 to the head of the scale, its three zones only to scale. */}
            {d.zones ? (
              <>
                {d.zones.covered && <rect x={d.zones.covered.x} y={d.zones.covered.y} width={d.zones.covered.w} height={d.zones.covered.h} fill={`url(#${uid}-z-covered)`} />}
                <rect x={d.zones.under.x} y={d.zones.under.y} width={d.zones.under.w} height={d.zones.under.h} fill={`url(#${uid}-z-under-floor)`} />
                <rect x={d.zones.over.x} y={d.zones.over.y} width={d.zones.over.w} height={d.zones.over.h} fill={`url(#${uid}-z-over-floor)`} />
                <rect x={sx} y={yS} width={sw} height={scaleH} fill="none" stroke={ink(0.6)} strokeWidth="0.9" />
                {d.grads.map(([y, len], k) => (
                  <line key={`g${k}`} x1={sx + sw} y1={y} x2={sx + sw + len} y2={y} stroke={ink(0.55)} strokeWidth="0.8" />
                ))}
                {d.shareMarks.map((m, k) => (
                  <line key={`s${k}`} x1={sx - 6} y1={m.y} x2={sx + sw} y2={m.y} stroke={m.on ? SPOT : ink(0.7)} strokeWidth={m.on ? 1.6 : 0.9} />
                ))}
              </>
            ) : (
              <rect x={sx} y={yS} width={sw} height={scaleH} fill="none" stroke={ink(0.4)} strokeWidth="0.9" strokeDasharray="3 3" />
            )}
            <line x1={sx - 6} y1={y0} x2={x1 + 12} y2={y0} stroke={ink(0.6)} strokeWidth="1" />

            {/* The picture, hung from the rail on two wires: keyed by the collection, so a new pick re-hangs it. */}
            <g className="l01-hang" key={col.symbol}>
              <polyline points={p.wire} fill="none" stroke={ink(0.45)} strokeWidth="0.8" />
              <circle cx={p.nail[0]} cy={p.nail[1]} r="2.2" fill={EDITORIAL_INK} />
              <rect x={p.x} y={p.y} width={p.side} height={p.side} fill={EDITORIAL_BG} stroke={ink(0.85)} strokeWidth="1.2" strokeDasharray={scaled ? undefined : '4 3'} />
              <rect x={p.x + 5} y={p.y + 5} width={Math.max(0, p.side - 10)} height={Math.max(0, p.side - 10)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.1)} stroke={ink(0.3)} strokeWidth="0.7" />
              <image
                href={COLLECTION_ART[col.symbol]}
                x={p.x + 12}
                y={p.y + 12}
                width={Math.max(0, p.side - 24)}
                height={Math.max(0, p.side - 24)}
                preserveAspectRatio="xMidYMid slice"
                clipPath={`url(#${uid}-pic)`}
                opacity={scaled ? undefined : 0.55}
              />
              <rect x={p.x + 12} y={p.y + 12} width={Math.max(0, p.side - 24)} height={Math.max(0, p.side - 24)} fill="none" stroke={ink(0.5)} strokeWidth="0.7" />
            </g>

            {/* The loan's hatch: the wall from datum 0 up to the amount typed, in its zone's ink. */}
            {d.loanY !== null && f.zone && (
              <g clipPath={`url(#${uid}-wall)`}>
                <g className="l01-loan" style={{ transform: `translateY(${d.loanY}px)` }}>
                  <rect x={x0} y="0" width={wallW} height={scaleH + 40} fill={`url(#${uid}-l-${f.zone})`} />
                </g>
              </g>
            )}
            {d.floorY !== null && (
              <>
                <line className="dwg-draw" pathLength={1} x1={sx} y1={d.floorY} x2={x1 + 14} y2={d.floorY} stroke={EDITORIAL_INK} strokeWidth="1.1" />
                <path d={`M${x1 + 14} ${d.floorY} l5 -7 h-10 z`} fill={EDITORIAL_INK} />
              </>
            )}
            {d.bidY !== null && (
              <>
                <line className="dwg-draw" pathLength={1} x1={sx} y1={d.bidY} x2={x1 + 14} y2={d.bidY} stroke={EDITORIAL_GREEN} strokeWidth="1.1" style={{ animationDelay: '0.12s' }} />
                <path d={`M${x1 + 14} ${d.bidY} l5 -7 h-10 z`} fill={EDITORIAL_GREEN} />
              </>
            )}
            {/* The loan, the level that moves: in front of everything, a mark riding the staff. */}
            {d.loanY !== null && (
              <g className="l01-loan" style={{ transform: `translateY(${d.loanY}px)` }}>
                <line x1={sx} y1="0" x2={x1 + 20} y2="0" stroke={SPOT} strokeWidth="2" />
                <rect x={sx - 3} y="-3.5" width={sw + 6} height="7" fill={SPOT} stroke={EDITORIAL_BG} strokeWidth="1" />
                <rect x={x1 + 14} y="-4" width="8" height="8" fill={SPOT} />
              </g>
            )}
            {d.dim && (
              <>
                <line x1={d.dim.x} y1={d.dim.a} x2={d.dim.x} y2={d.dim.b} stroke={ink(0.6)} strokeWidth="0.9" />
                <line x1={d.dim.x - 3.5} y1={d.dim.a + 3} x2={d.dim.x + 3.5} y2={d.dim.a - 3} stroke={ink(0.8)} strokeWidth="0.9" />
                <line x1={d.dim.x - 3.5} y1={d.dim.b + 3} x2={d.dim.x + 3.5} y2={d.dim.b - 3} stroke={ink(0.8)} strokeWidth="0.9" />
              </>
            )}
            {d.leaders.map((points, k) => (
              <polyline key={`l${k}`} points={points} fill="none" stroke={ink(0.4)} strokeWidth="0.7" />
            ))}
            {/* Not to scale: a dashed rule to each value listed, at no height. */}
            {d.listed.map((y, k) => (
              <line key={`n${k}`} x1={x1 + 6} y1={y} x2={tx - 4} y2={y} stroke={ink(0.4)} strokeWidth="0.8" strokeDasharray="2 3" />
            ))}
          </svg>

          {d.labels.map((l) =>
            l.k === 'stamp' ? (
              <span key={l.id} className="dwg-stamp l01-wall-stamp" data-tone={l.tone ?? ''} data-t={l.t} style={at(l.x, l.y)} />
            ) : l.k === 'plate' ? (
              <span key={l.id} className="dwg-figlabel l01-plate" data-t={l.t} data-v={l.v} style={at(l.x, l.y)} />
            ) : (
              <span
                key={l.id}
                className="dwg-figlabel l01-tag"
                data-k={l.k}
                data-tone={l.tone ?? ''}
                data-on={l.on ? '' : undefined}
                data-stack={l.stack ? '' : undefined}
                data-align={l.align}
                data-t={l.t}
                data-v={l.v}
                style={at(l.x, l.y)}
              />
            ),
          )}
        </div>
        <p className="l01-vt">
          <span className="dwg-mark" data-a="A" data-b="L-01" />
          <span className="l01-vt-rule" />
          <span className="l01-vt-key dwg-t" data-tone={f.mode === 'nts' ? 'warn' : ''} data-t={key} />
        </p>
      </div>
    </div>
  );
}
