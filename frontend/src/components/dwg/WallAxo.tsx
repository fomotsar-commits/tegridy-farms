import { EDITORIAL_BG, EDITORIAL_INK, mixHex } from '../../lib/editorial';
import { iso, pts, wallMatrix, type Pt } from '../../lib/iso';
import { COLLECTIONS, COLLECTION_ART } from '../nftfinance/nftLendingShared';

const ink = (a: number) => `rgba(245, 228, 184, ${a})`;
const r1 = (n: number) => Math.round(n * 10) / 10;
/** The model's units: px to a unit, the wall's length, thickness and height, a frame's side. */
const U = 40;
const L = 10.4;
const T = 0.5;
const H = 4.5;
const F = 2.3;
const Z_TOP = 3.62;
const Z_BOT = Z_TOP - F;
const DEPTH = 0.12;
const RAIL = H - 0.3;
const FLOOR = { x0: -0.8, x1: L + 0.9, y0: -0.6, y1: 4.1 } as const;
const q = (x: number, y: number, z: number): Pt => iso([x, y, z], U);
const EDGE = { stroke: ink(0.6), strokeWidth: 0.9, strokeLinejoin: 'round' } as const;

/**
 * L-01's hero model (owner, 2026-11-15): the wall as an object, the three lending collections
 * hung on it in three identical frames (nothing is measured here, so none may look bigger), and
 * on the floor the mark that names the view drawn below as elevation A. Constants only: no read,
 * no state. Decoration to a reader: aria-hidden, no <text>, every word drawn from data-t.
 */
export function WallAxo() {
  const gap = (L - COLLECTIONS.length * F) / (COLLECTIONS.length + 1);
  const floor = [q(FLOOR.x0, FLOOR.y0, 0), q(FLOOR.x1, FLOOR.y0, 0), q(FLOOR.x1, FLOOR.y1, 0), q(FLOOR.x0, FLOOR.y1, 0)];
  const grid: [Pt, Pt][] = [];
  for (let gx = 0; gx <= L; gx += 1.3) grid.push([q(gx, FLOOR.y0, 0), q(gx, FLOOR.y1, 0)]);
  for (let gy = 0.5; gy < FLOOR.y1; gy += 1.3) grid.push([q(FLOOR.x0, gy, 0), q(FLOOR.x1, gy, 0)]);
  const top = [q(0, 0, H), q(L, 0, H), q(L, T, H), q(0, T, H)];
  const end = [q(L, 0, H), q(L, T, H), q(L, T, 0), q(L, 0, 0)];
  const face = [q(0, T, H), q(L, T, H), q(L, T, 0), q(0, T, 0)];

  // The elevation mark on the floor: stand here, look at the wall.
  const cx = L * 0.5;
  const cy = 3.25;
  const R = 0.62;
  const ring = Array.from({ length: 32 }, (_, k) => q(cx + R * Math.cos((k / 32) * 2 * Math.PI), cy + R * Math.sin((k / 32) * 2 * Math.PI), 0));
  const arrow = [q(cx, cy - R - 0.72, 0), q(cx + 0.5, cy - R + 0.1, 0), q(cx - 0.5, cy - R + 0.1, 0)];

  const frames = COLLECTIONS.map((c, i) => {
    const x = gap + i * (F + gap);
    const yF = T + DEPTH;
    const a = 0.13;
    const b = 0.3;
    return {
      c,
      i,
      side: (F - 2 * b) * U,
      nail: q(x + F / 2, T, RAIL),
      wire: [q(x + 0.5, yF, Z_TOP), q(x + F / 2, T, RAIL), q(x + F - 0.5, yF, Z_TOP)],
      lid: [q(x, T, Z_TOP), q(x + F, T, Z_TOP), q(x + F, yF, Z_TOP), q(x, yF, Z_TOP)],
      cheek: [q(x + F, T, Z_TOP), q(x + F, yF, Z_TOP), q(x + F, yF, Z_BOT), q(x + F, T, Z_BOT)],
      front: [q(x, yF, Z_TOP), q(x + F, yF, Z_TOP), q(x + F, yF, Z_BOT), q(x, yF, Z_BOT)],
      mat: [q(x + a, yF, Z_TOP - a), q(x + F - a, yF, Z_TOP - a), q(x + F - a, yF, Z_BOT + a), q(x + a, yF, Z_BOT + a)],
      matrix: wallMatrix([x + b, yF, Z_TOP - b], 'x', U),
      inner: [q(x + b, yF, Z_TOP - b), q(x + F - b, yF, Z_TOP - b), q(x + F - b, yF, Z_BOT + b), q(x + b, yF, Z_BOT + b)],
      plate: [q(x + 0.08, T, 1.04), q(x + 1.42, T, 1.04), q(x + 1.42, T, 0.66), q(x + 0.08, T, 0.66)],
      label: q(x + 0.2, T, 1.0),
    };
  });

  // The box holds every corner drawn.
  const all: Pt[] = [...floor, ...top, ...end, ...face, ...ring, ...arrow, ...frames.flatMap((f) => [...f.lid, ...f.cheek, ...f.front, ...f.plate])];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const bx = Math.floor(Math.min(...xs)) - 6;
  const by = Math.floor(Math.min(...ys)) - 8;
  const bw = Math.ceil(Math.max(...xs)) + 6 - bx;
  const bh = Math.ceil(Math.max(...ys)) + 8 - by;
  const at = ([x, y]: Pt) => ({ left: `${(((x - bx) / bw) * 100).toFixed(2)}%`, top: `${(((y - by) / bh) * 100).toFixed(2)}%` });
  const markA = q(cx - 0.16, cy - 0.42, 0);
  const markB = q(cx - 0.47, cy + 0.07, 0);
  const sightFrom = q(cx, cy - R - 0.72, 0);
  const sightTo = q(cx, T, 0);
  const barA = q(cx - R, cy, 0);
  const barB = q(cx + R, cy, 0);
  const foot = [q(0, T, 0), q(L, T, 0)] as const;
  const rail = [q(0.12, T, RAIL), q(L - 0.12, T, RAIL)] as const;
  const skirt = [q(0, T, 0.34), q(L, T, 0.34)] as const;

  return (
    <div className="l01-axo dwg-figwrap" aria-hidden="true">
      <svg className="dwg-fig" viewBox={`${bx} ${by} ${bw} ${bh}`} focusable="false">
        <polygon points={pts(floor)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.035)} stroke={ink(0.22)} strokeWidth="0.8" />
        <g stroke={ink(0.09)} strokeWidth="0.7">
          {grid.map(([a, b], k) => (
            <line key={k} x1={r1(a[0])} y1={r1(a[1])} x2={r1(b[0])} y2={r1(b[1])} />
          ))}
        </g>
        {/* The wall: a slab, its long face toward the words. */}
        <polygon points={pts(top)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.24)} {...EDGE} />
        <polygon points={pts(end)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.07)} {...EDGE} />
        <polygon points={pts(face)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.12)} {...EDGE} />
        <line x1={r1(foot[0][0])} y1={r1(foot[0][1])} x2={r1(foot[1][0])} y2={r1(foot[1][1])} stroke={EDITORIAL_INK} strokeWidth="1.5" />
        <line x1={r1(rail[0][0])} y1={r1(rail[0][1])} x2={r1(rail[1][0])} y2={r1(rail[1][1])} stroke={ink(0.5)} strokeWidth="0.9" />
        <line x1={r1(skirt[0][0])} y1={r1(skirt[0][1])} x2={r1(skirt[1][0])} y2={r1(skirt[1][1])} stroke={ink(0.2)} strokeWidth="0.8" />
        {frames.map((f) => (
          <g key={f.c.symbol} className="dwg-fill-in" style={{ animationDelay: `${f.i * 90}ms` }}>
            <polyline points={pts(f.wire)} fill="none" stroke={ink(0.45)} strokeWidth="0.8" />
            <circle cx={r1(f.nail[0])} cy={r1(f.nail[1])} r="2" fill={EDITORIAL_INK} />
            <polygon points={pts(f.lid)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.34)} stroke={ink(0.7)} strokeWidth="0.7" />
            <polygon points={pts(f.cheek)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.05)} stroke={ink(0.7)} strokeWidth="0.7" />
            <polygon points={pts(f.front)} fill={EDITORIAL_BG} stroke={ink(0.85)} strokeWidth="1" />
            <polygon points={pts(f.mat)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.1)} stroke={ink(0.3)} strokeWidth="0.6" />
            <image href={COLLECTION_ART[f.c.symbol]} width={r1(f.side)} height={r1(f.side)} preserveAspectRatio="xMidYMid slice" transform={f.matrix} />
            <polygon points={pts(f.inner)} fill="none" stroke={ink(0.5)} strokeWidth="0.6" />
            <polygon points={pts(f.plate)} fill={mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.03)} stroke={ink(0.5)} strokeWidth="0.7" />
          </g>
        ))}
        <line x1={r1(sightFrom[0])} y1={r1(sightFrom[1])} x2={r1(sightTo[0])} y2={r1(sightTo[1])} stroke={ink(0.55)} strokeWidth="0.9" strokeDasharray="7 3 1.5 3" />
        <polygon points={pts(arrow)} fill={EDITORIAL_INK} />
        <polygon points={pts(ring)} fill={EDITORIAL_BG} stroke={EDITORIAL_INK} strokeWidth="1" />
        <line x1={r1(barA[0])} y1={r1(barA[1])} x2={r1(barB[0])} y2={r1(barB[1])} stroke={ink(0.6)} strokeWidth="0.8" />
      </svg>
      {frames.map((f) => (
        <span key={f.c.symbol} className="dwg-figlabel l01-axo-label" data-k="plate" data-plane="wall" data-t={f.c.symbol} style={at(f.label)} />
      ))}
      <span className="dwg-figlabel l01-axo-label" data-k="mark-a" data-plane="ground" data-t="A" style={at(markA)} />
      <span className="dwg-figlabel l01-axo-label" data-k="mark-b" data-plane="ground" data-t="L-01" style={at(markB)} />
    </div>
  );
}
