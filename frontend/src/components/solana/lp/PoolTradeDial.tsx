// One buy, dragged from tiny to a quarter of the pool: how far it moves the price, and who
// it pays.
//
// A pool's card says its reserves and its fee split as numbers. This turns them into the one
// picture a liquidity provider (and a trader) reads at a glance: the curve is how hard the
// price moves as a buy gets bigger, so a flat curve is a deep pool; the line under it is the
// trade fee from that one buy, split between the pool's providers, the venue and, where the
// pool charges one, its creator.
//
// lib/solana/lp/tradeDepth.ts arithmetic on the reserve and fee tier the chain returned. It
// says nothing of how often anyone trades, so it carries no rate over time and no forecast.
import { useEffect, useId, useRef, useState } from 'react';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { quoteText } from '../../../lib/solana/lp/format';
import { DEPTH_STOPS, depthPoint, moveText, sizeAtStop } from '../../../lib/solana/lp/tradeDepth';
import { useDrawWidth } from '../../../hooks/useDrawWidth';

// Pixels: the picture is drawn as wide as its box (hooks/useDrawWidth.ts), never stretched.
const H = 84;
const PAD = 12;
const TOP = 12;
const BASE = 70;

/**
 * The dial, drawn only while the fold it sits in is open. A pool list draws every card on
 * every read; a closed fold's dial is arithmetic and SVG nobody can see.
 */
export function PoolTradeDialWhenOpen(props: { view: PoolView; creatorFeeRate: bigint }) {
  const mark = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const fold = mark.current?.closest('details');
    if (!fold) {
      setOpen(true); // not in a fold: always in view
      return;
    }
    const sync = () => setOpen(fold.open);
    sync();
    fold.addEventListener('toggle', sync);
    return () => fold.removeEventListener('toggle', sync);
  }, []);
  return (
    <>
      <span ref={mark} hidden />
      {open && <PoolTradeDial {...props} />}
    </>
  );
}

export function PoolTradeDial({ view, creatorFeeRate }: { view: PoolView; creatorFeeRate: bigint }) {
  const id = useId();
  const [stop, setStop] = useState(50);
  const [box, W] = useDrawWidth();
  const cfg = view.config;
  if (!cfg || view.quoteReserve <= 0n || view.tokenReserve <= 0n) return null;
  const at = (s: number) => depthPoint(view.quoteReserve, sizeAtStop(view.quoteReserve, s), cfg, creatorFeeRate);
  const point = at(stop);
  const deepest = at(DEPTH_STOPS);
  if (!point || !deepest || !(deepest.move > 0)) return null;

  const x = (s: number) => PAD + (s / DEPTH_STOPS) * (W - 2 * PAD);
  const y = (move: number) => BASE - (move / deepest.move) * (BASE - TOP);
  const pts: string[] = [];
  for (let s = 0; s <= DEPTH_STOPS; s += 2) pts.push(`${x(s).toFixed(1)},${y(at(s)?.move ?? 0).toFixed(1)}`);
  const curve = pts.join(' ');

  const headline = `A ${quoteText(point.size, view.quote)} buy moves the price up about ${moveText(point.move)}%`;
  const paid = `Liquidity providers keep ${quoteText(point.lpKeeps, view.quote)} of it, the venue ${quoteText(point.venueTakes, view.quote)}${
    point.creatorTakes > 0n ? `, the pool’s creator ${quoteText(point.creatorTakes, view.quote)}` : ''
  }.`;

  return (
    <div data-testid="lp-trade-dial" className="space-y-1">
      <p className="text-white/90 font-semibold">What one buy does here</p>
      <p className="text-emerald-300 font-mono" data-testid="lp-trade-dial-headline">
        {headline}
      </p>
      <div ref={box} className="relative" style={{ touchAction: 'pan-y' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height: H }} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#34d399" stopOpacity="0.08" />
              <stop offset="1" stopColor="#34d399" stopOpacity="0.4" />
            </linearGradient>
          </defs>
          <polygon points={`${x(0)},${BASE} ${curve} ${x(DEPTH_STOPS)},${BASE}`} fill={`url(#${id}-fill)`} />
          <polyline points={curve} fill="none" stroke="#34d399" strokeWidth="1.75" />
          <line x1={x(0)} y1={BASE} x2={x(DEPTH_STOPS)} y2={BASE} stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
          <line x1={x(stop)} y1={y(point.move)} x2={x(stop)} y2={BASE} stroke="#ffffff" strokeWidth="1.5" strokeDasharray="2 2" />
          <circle cx={x(stop)} cy={y(point.move)} r="6.5" fill="#10b981" stroke="#ffffff" strokeWidth="2" />
        </svg>
        <input
          type="range"
          min={0}
          max={DEPTH_STOPS}
          step={1}
          value={stop}
          onChange={(e) => setStop(Number(e.target.value))}
          aria-label={`Size of one buy, in ${view.quote.symbol}`}
          aria-valuetext={`${headline}. ${paid}`}
          className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
          style={{ minHeight: 44, fontSize: 16 }}
        />
      </div>
      <p className="text-white/80" aria-live="polite" data-testid="lp-trade-dial-paid">
        {paid}
      </p>
      <p className="text-white/55">One buy’s arithmetic on this pool as it stands. It does not say how often anyone trades.</p>
    </div>
  );
}
