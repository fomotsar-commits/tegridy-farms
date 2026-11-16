import { useId, useMemo, useRef, type CSSProperties } from 'react';
import { BUNGALOWS } from '../../lib/bungalows';
import { EDITORIAL_BG, EDITORIAL_INK, mixHex } from '../../lib/editorial';
import { setFieldHot, useFieldHot, useFieldPools, useFieldView, type FieldPool } from '../../lib/solana/lp/fieldStore';
import { tankFarm } from './tankFarm';
import { useOffScreenPause } from './offScreen';

const SPOT = '#5ad1e6';
const FACE_LEFT = mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.13);
const FACE_RIGHT = mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.07);
const FACE_TOP = mixHex(EDITORIAL_BG, EDITORIAL_INK, 0.2);
const INSIDE = mixHex(EDITORIAL_BG, SPOT, 0.06);
const WALL_A = { wet: mixHex(EDITORIAL_BG, SPOT, 0.2), dry: mixHex(EDITORIAL_BG, SPOT, 0.06) };
const WALL_B = { wet: mixHex(EDITORIAL_BG, SPOT, 0.12), dry: mixHex(EDITORIAL_BG, SPOT, 0.04) };
const WATER = mixHex(EDITORIAL_BG, SPOT, 0.6);
const STILL = mixHex(EDITORIAL_BG, SPOT, 0.22);
const STILL_LINE = mixHex(EDITORIAL_BG, SPOT, 0.5);
const RIPPLE = mixHex(SPOT, '#ffffff', 0.55);
/** The staff gauge's marks, top to bottom (tankFarm.ts GAUGE_LOW_USD to GAUGE_HIGH_USD). */
const MARKS = ['$10K', '$1K', '$100', '$10'];

/** The island's Solana coins with a pool on the venue (lib/bungalows.ts `venueSolPool`): dry until a list is read. */
function registryTanks(): FieldPool[] {
  return BUNGALOWS.flatMap((b) =>
    b.chain === 'solana' && b.address && b.venueSolPool ? [{ address: b.venueSolPool, tokenMint: b.address, name: `${b.symbol}/SOL`, usd: null }] : [],
  );
}

/**
 * P-01's drawing (owner, 2026-11-15): the pools as a tank farm. From the registry at once, every
 * tank dry and dashed; once All pools lands, its pools (lib/solana/lp/fieldStore.ts): water on the
 * gauge where dollars were read, still hatched water where a pool holds coins not yet priced.
 * A pointer on a tank lights its row, and a press does what its View does.
 * Decoration to a reader: aria-hidden, every word drawn from data-t.
 */
export function PoolField() {
  const listed = useFieldPools();
  const hot = useFieldHot();
  const view = useFieldView();
  const registry = useMemo(() => registryTanks(), []);
  const pools = listed ?? registry;
  const farm = useMemo(() => tankFarm(pools), [pools]);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const ref = useRef<HTMLDivElement>(null);
  const paused = useOffScreenPause(ref);
  if (!farm) return null;
  const [vx, vy, vw, vh] = farm.viewBox;
  const at = (x: number, y: number) => ({ left: `${((x - vx) / vw) * 100}%`, top: `${((y - vy) / vh) * 100}%` });
  // The key's dollar scale stands for something only once a tank is on it.
  const priced = farm.tanks.some((t) => t.state === 'wet');
  const hatch = `${id}h`;
  return (
    <div
      ref={ref}
      className="p01-field"
      aria-hidden="true"
      data-read={listed ? '' : undefined}
      data-priced={priced ? '' : undefined}
      data-dwg-paused={paused ? '' : undefined}
      style={{ '--vbw': vw } as CSSProperties}
    >
      <svg className="dwg-fig p01-farm" viewBox={`${vx} ${vy} ${vw} ${vh}`} focusable="false">
        <defs>
          <pattern id={hatch} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
            <rect width="5" height="5" fill={STILL} />
            <line x1="0" y1="0.5" x2="5" y2="0.5" stroke={STILL_LINE} strokeWidth="0.8" />
          </pattern>
        </defs>
        <g className="p01-ground">
          {farm.grid.map(([x1, y1, x2, y2], k) => (
            <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} />
          ))}
        </g>
        {farm.mains.map(({ line: [x1, y1, x2, y2], hole }, k) => (
          <g key={k} className="p01-main">
            <line className="dwg-ripple" x1={x1} y1={y1} x2={x2} y2={y2} />
            <ellipse cx={hole[0]} cy={hole[1]} rx={12} ry={6.9} />
          </g>
        ))}
        {farm.tanks.map((t) => {
          const wet = t.state === 'wet';
          const still = t.state === 'still';
          const clip = `${id}t${t.i}`;
          return (
            <g
              key={t.pool.address}
              className="p01-tank dwg-fill-in"
              data-hot={hot === t.pool.address ? '' : undefined}
              data-dry={t.state === 'dry' ? '' : undefined}
              data-still={still ? '' : undefined}
              data-press={view ? '' : undefined}
              style={{ animationDelay: `${t.i * 55}ms` }}
              onPointerEnter={() => setFieldHot(t.pool.address)}
              onPointerLeave={() => setFieldHot(null)}
              onClick={view ? () => view(t.pool.tokenMint) : undefined}
            >
              <clipPath id={clip}>
                <polygon points={t.hole} />
              </clipPath>
              <polygon className="p01-face" points={t.left} fill={FACE_LEFT} />
              <polygon className="p01-face" points={t.right} fill={FACE_RIGHT} />
              <polygon className="p01-face" points={t.top} fill={FACE_TOP} />
              <g clipPath={`url(#${clip})`}>
                <polygon points={t.hole} fill={INSIDE} />
                <polygon points={t.wallA} fill={wet || still ? WALL_A.wet : WALL_A.dry} />
                <polygon points={t.wallB} fill={wet || still ? WALL_B.wet : WALL_B.dry} />
                {wet ? (
                  <>
                    <polygon className="p01-water" points={t.water} fill={WATER} />
                    {t.ripples.map(([x1, y1, x2, y2], k) => (
                      <line key={k} className="p01-ripple dwg-ripple" x1={x1} y1={y1} x2={x2} y2={y2} stroke={RIPPLE} strokeDashoffset={k * 7} />
                    ))}
                  </>
                ) : still ? (
                  <polygon className="p01-still" points={t.water} fill={`url(#${hatch})`} />
                ) : (
                  <polygon className="p01-dryline" points={t.water} />
                )}
              </g>
              <polygon className="p01-rim" points={t.hole} />
            </g>
          );
        })}
      </svg>
      {farm.tanks.map((t) => (
        <span
          key={t.pool.address}
          className="p01-tag"
          data-t={t.pool.name}
          data-hot={hot === t.pool.address ? '' : undefined}
          style={{ ...at(t.label[0], t.label[1]), '--fs': t.labelSize } as CSSProperties}
        />
      ))}
      <div className="p01-key">
        <span className="p01-key-cap" data-t="IN THE POOL" />
        <span className="p01-key-staff">
          {MARKS.map((m, k) => (
            <span key={m} className="p01-key-mark" data-t={m} style={{ top: `${(k / (MARKS.length - 1)) * 100}%` }} />
          ))}
        </span>
      </div>
    </div>
  );
}
