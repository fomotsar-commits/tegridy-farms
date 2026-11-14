// A range position, dragged through prices it has not reached.
//
// The hardest thing to see about a range position is that it changes what it holds: the token
// when the price falls, the pairing coin when it rises, and all of one of them past either
// edge, where it earns nothing. This draws that as one shape (the token's share of the
// position, sliding from all to none across the range) and lets the reader drag the price to
// read the two amounts there.
//
// lib/solana/clmm/rangeHoldings.ts: the program's own maths on the liquidity the form already
// planned, rounded down as a withdrawal is. It is the same position at another price, not a
// forecast of one.
import { useId, useState } from 'react';
import { HOLDINGS_STOPS, holdingsAt, holdingsPrice, holdingsStop } from '../../../lib/solana/clmm/rangeHoldings';
import { priceNumber, rangePrices, type Pair, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import { coinAmount, priceNumberText, tokenAmount, tokenWord, type NamedPair } from './rangeText';
import { useDrawWidth } from '../../../hooks/useDrawWidth';

// Pixels: the picture is drawn as wide as its box (hooks/useDrawWidth.ts), never stretched.
const H = 78;
// A handle at either end, or at the top, clears the picture's border by 3 px or more.
const PAD = 12;
const TOP = 12;
const BASE = 62;

export function RangeHoldingsDial({ pair, r, liquidity, now }: { pair: Pair; r: TickRange; liquidity: bigint | null; now: number }) {
  const id = useId();
  const prices = rangePrices(pair, r);
  const min = priceNumber(prices.min);
  const max = priceNumber(prices.max);
  const [picked, setPicked] = useState<number | null>(null);
  const [box, W] = useDrawWidth();
  if (liquidity === null || liquidity <= 0n || !(min > 0) || !(max > min)) return null;
  const named = pair as NamedPair;
  const stop = picked ?? holdingsStop(min, max, now);
  // Until it is dragged, the dial stands at the price now itself, not the nearest stop to it,
  // so the amounts it opens on are the ones the form just planned.
  const onAxis = now >= holdingsPrice(min, max, 0) && now <= holdingsPrice(min, max, HOLDINGS_STOPS);
  const price = picked === null && onAxis ? now : holdingsPrice(min, max, stop);
  const here = holdingsAt(pair, r, liquidity, price);
  if (!here) return null;

  const x = (s: number) => PAD + (s / HOLDINGS_STOPS) * (W - 2 * PAD);
  const y = (share: number) => BASE - share * (BASE - TOP);
  const pts: string[] = [];
  for (let s = 0; s <= HOLDINGS_STOPS; s += 4) {
    const h = holdingsAt(pair, r, liquidity, holdingsPrice(min, max, s));
    pts.push(`${x(s).toFixed(1)},${y(h?.tokenShare ?? 0).toFixed(1)}`);
  }
  const curve = pts.join(' ');
  const xMin = x(holdingsStop(min, max, min));
  const xMax = x(holdingsStop(min, max, max));
  const xNow = x(holdingsStop(min, max, now));
  const out = here.where !== 'inside';

  const headline = `${tokenAmount(named, here.token)} and ${coinAmount(pair, here.coin)}`;
  const at = `at ${priceNumberText(named, price)}`;
  const line =
    here.where === 'below'
      ? `Under your range it is all ${tokenWord(named)}, and earns nothing until the price comes back.`
      : here.where === 'above'
      ? `Over your range it is all ${pair.quote.symbol}, and earns nothing until the price comes back.`
      : 'Inside your range it holds both, and earns from swaps.';

  return (
    <div data-testid="range-holdings" data-where={here.where} className="space-y-1">
      <p className="text-white/90 text-[12px] font-semibold">What this position holds as the price moves</p>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className={`text-[12px] font-mono ${out ? 'text-amber-300' : 'text-emerald-300'}`} data-testid="range-holdings-headline">
          {headline}
        </p>
        <p className="text-white/70 text-[11px]" data-testid="range-holdings-at">
          {at}
        </p>
      </div>
      <div ref={box} className="relative" style={{ touchAction: 'pan-y' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full rounded-lg border border-white/[0.14] bg-black/30" style={{ height: H }} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${id}-token`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#a78bfa" stopOpacity="0.55" />
              <stop offset="1" stopColor="#a78bfa" stopOpacity="0.15" />
            </linearGradient>
          </defs>
          {/* Past either edge: all one coin, earning nothing. */}
          <rect x={x(0)} y={TOP - 4} width={Math.max(0, xMin - x(0))} height={BASE - TOP + 8} fill="rgba(245,158,11,0.10)" />
          <rect x={xMax} y={TOP - 4} width={Math.max(0, x(HOLDINGS_STOPS) - xMax)} height={BASE - TOP + 8} fill="rgba(245,158,11,0.10)" />
          {/* The token's share of the position: all of it on the left, none on the right. */}
          <polygon points={`${x(0)},${BASE} ${curve} ${x(HOLDINGS_STOPS)},${BASE}`} fill={`url(#${id}-token)`} />
          <polyline points={curve} fill="none" stroke="#c4b5fd" strokeWidth="1.75" />
          <line x1={x(0)} y1={BASE} x2={x(HOLDINGS_STOPS)} y2={BASE} stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
          <line x1={xMin} y1={TOP - 4} x2={xMin} y2={BASE + 4} stroke="#22c55e" strokeWidth="1" />
          <line x1={xMax} y1={TOP - 4} x2={xMax} y2={BASE + 4} stroke="#22c55e" strokeWidth="1" />
          {/* Where the price is now. */}
          <line x1={xNow} y1={BASE} x2={xNow} y2={BASE + 8} stroke="#f5e4b8" strokeWidth="1.5" />
          <circle cx={xNow} cy={BASE + 10} r="1.8" fill="#f5e4b8" />
          <line x1={x(stop)} y1={y(here.tokenShare)} x2={x(stop)} y2={BASE} stroke="#ffffff" strokeWidth="1.5" strokeDasharray="2 2" />
          <circle cx={x(stop)} cy={y(here.tokenShare)} r="6.5" fill={out ? '#f59e0b' : '#10b981'} stroke="#ffffff" strokeWidth="2" />
        </svg>
        <input
          type="range"
          min={0}
          max={HOLDINGS_STOPS}
          step={1}
          value={stop}
          onChange={(e) => setPicked(Number(e.target.value))}
          aria-label={`Price, to see what the position holds there`}
          aria-valuetext={`${headline} ${at}. ${line}`}
          className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
          style={{ minHeight: 44, fontSize: 16 }}
        />
      </div>
      <p className={`text-[11px] ${out ? 'text-amber-300' : 'text-white/75'}`} aria-live="polite" data-testid="range-holdings-line">
        {line}
      </p>
    </div>
  );
}
