// "What if the price moves", as a curve you can drag along.
//
// The table under it gives three rows. This draws the whole shape: the position against just
// holding both coins, for every price from an eighth to 8 times the price at the deposit. The
// curve peaks at "the same" and falls away on both sides, which is the one thing about a pool
// position a table cannot show. Dragging the handle (a native range input: touch, arrow keys
// and screen readers work unaided) reads off that price's figure and how the two sides of the
// position have shifted.
//
// Every figure is lib/solana/lp/priceMove.ts's arithmetic for x*y=k. Nothing is predicted,
// no fee is counted and no currency value is printed.
import { useId, useState } from 'react';
import { DIAL_MAX_TIMES, priceMovePoint, vsHolding } from '../../../lib/solana/lp/priceMove';

const W = 320;
const H = 96;
const PAD = 12;
const TOP = 14;
const BOTTOM = 80;
// The slider works in hundredths of a doubling: 0 is "the same", 100 is double, -100 is half.
const STOPS = Math.round(Math.log2(DIAL_MAX_TIMES) * 100);
const STEP = 5;
const DEEPEST = -(vsHolding(DIAL_MAX_TIMES) ?? -0.4);

const timesAt = (stop: number) => 2 ** (stop / 100);
const xAt = (stop: number) => PAD + ((stop + STOPS) / (2 * STOPS)) * (W - 2 * PAD);
const yAt = (vs: number) => TOP + (-vs / DEEPEST) * (BOTTOM - TOP);

const CURVE = (() => {
  const pts: string[] = [];
  for (let stop = -STOPS; stop <= STOPS; stop += STEP) {
    pts.push(`${xAt(stop).toFixed(1)},${yAt(vsHolding(timesAt(stop)) ?? 0).toFixed(1)}`);
  }
  return pts.join(' ');
})();

export function PriceMoveDial({ quoteSymbol }: { quoteSymbol: string }) {
  const id = useId();
  const [stop, setStop] = useState(100); // opens at "2 times", the table's middle row
  const point = priceMovePoint(timesAt(stop));
  if (!point) return null;
  const x = xAt(stop);
  const y = yAt(point.vs);
  const headline = point.position === 'the same' ? 'The same as holding' : `${point.position.replace(/^a/, 'A')} than holding`;
  const valueText = `Price ${point.price}: ${headline}`;

  return (
    <div data-testid="lp-price-dial">
      <div className="flex items-baseline justify-between gap-3">
        <p className={`font-semibold font-mono ${point.vs === 0 ? 'text-emerald-300' : 'text-amber-300'}`} data-testid="lp-price-dial-headline">
          {headline}
        </p>
        <p className="text-white/75 text-right" data-testid="lp-price-dial-price">
          price: {point.price}
        </p>
      </div>
      <div className="relative" style={{ touchAction: 'pan-y' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#f59e0b" stopOpacity="0.05" />
              <stop offset="1" stopColor="#f59e0b" stopOpacity="0.35" />
            </linearGradient>
          </defs>
          {/* "Just holding": the level line the curve is measured against. */}
          <line x1={PAD} y1={TOP} x2={W - PAD} y2={TOP} stroke="rgba(52,211,153,0.8)" strokeWidth="1" strokeDasharray="3 3" />
          {/* The gap between holding and the position, at every price. */}
          <polygon points={`${PAD},${TOP} ${CURVE} ${W - PAD},${TOP}`} fill={`url(#${id}-fill)`} />
          <polyline points={CURVE} fill="none" stroke="#fbbf24" strokeWidth="1.75" />
          {/* Half, the same, double: the table's own rows, as ticks. */}
          {[-200, -100, 0, 100, 200].map((s) => (
            <line key={s} x1={xAt(s)} y1={BOTTOM + 4} x2={xAt(s)} y2={BOTTOM + (s === 0 ? 12 : 9)} stroke={s === 0 ? '#34d399' : 'rgba(255,255,255,0.5)'} strokeWidth="1.5" />
          ))}
          <line x1={x} y1={TOP} x2={x} y2={y} stroke="#ffffff" strokeWidth="1.5" strokeDasharray="2 2" />
          <circle cx={x} cy={y} r="6.5" fill={point.vs === 0 ? '#10b981' : '#f59e0b'} stroke="#ffffff" strokeWidth="2" />
        </svg>
        <input
          type="range"
          min={-STOPS}
          max={STOPS}
          step={STEP}
          value={stop}
          onChange={(e) => setStop(Number(e.target.value))}
          aria-label="Price, against when you added"
          aria-valuetext={valueText}
          className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
          style={{ minHeight: 44, fontSize: 16 }}
        />
      </div>
      <p className="text-white/80" aria-live="polite" data-testid="lp-price-dial-mix">
        {point.vs === 0
          ? 'Your position holds what you put in. Drag to move the price.'
          : `Your position would hold ${point.tokens} of this token and ${point.quote} ${quoteSymbol}.`}
      </p>
    </div>
  );
}
