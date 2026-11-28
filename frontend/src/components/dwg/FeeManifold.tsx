import { useRef } from 'react';
import { MANIFOLD_BOX, manifoldShape, manifoldWidths } from './manifold';
import { useOffScreenPause } from './offScreen';

type TierRates = { tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint };

/**
 * The Rates card's figure (P-01): a trade's fee as one pipe in and two out, the pool's and the
 * venue's, each as wide as its share of the tier the card read. No tier read, nothing drawn.
 * Decoration to a reader: aria-hidden, its captions drawn from data-t.
 */
export function FeeManifold({ tier }: { tier: TierRates | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const paused = useOffScreenPause(ref);
  const widths = manifoldWidths(tier);
  if (!widths) return null;
  const s = manifoldShape(widths);
  const [x0, cy, xs] = s.inPipe;
  // A caption ends at its point (above it) or starts there (below it), as manifoldShape lays it.
  const at = ([x, y, side]: readonly [number, number, 'above' | 'below']) => ({
    style: { left: `${x * 100}%`, top: `${y * 100}%` },
    'data-below': side === 'below' ? '' : undefined,
  });
  return (
    <div ref={ref} className="p01-manifold" aria-hidden="true" data-dwg-paused={paused ? '' : undefined}>
      <svg className="dwg-fig" viewBox={`0 0 ${MANIFOLD_BOX.w} ${MANIFOLD_BOX.h}`} focusable="false">
        <line className="p01-pipe-in" x1={x0} y1={cy} x2={xs} y2={cy} strokeWidth={widths.in} />
        {s.pool && <path className="p01-pipe-pool" d={s.pool} strokeWidth={widths.pool} />}
        {s.venue && <path className="p01-pipe-venue" d={s.venue} strokeWidth={widths.venue} />}
        <line className="p01-flow dwg-ripple" x1={x0} y1={cy} x2={xs} y2={cy} />
        {s.pool && <path className="p01-flow dwg-ripple" d={s.pool} />}
        <rect className="p01-valve" x={s.valve.x} y={s.valve.y} width={s.valve.w} height={s.valve.h} />
      </svg>
      <span className="p01-mcap" data-t="A TRADE’S FEE" {...at(s.captions.fee)} />
      {s.pool && <span className="p01-mcap" data-end="" data-t="TO THE POOL" {...at(s.captions.pool)} />}
      {s.venue && <span className="p01-mcap" data-end="" data-t="TO THE VENUE" {...at(s.captions.venue)} />}
    </div>
  );
}
