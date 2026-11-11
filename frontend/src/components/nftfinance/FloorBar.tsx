// The amount a lender offers, drawn against what the NFT sells for.
//
// A whole-collection offer is a bid that pays interest while it waits: not repaid, the lender
// owns the NFT for what they lent. So the amount is only large or small against two prices,
// and this bar draws all three on one line: the best open bid (a buyer who pays that today),
// the floor (the cheapest one listed), and the amount, as a handle. Green up to the best bid,
// amber from there to the floor, red past it. Dragging the handle writes the amount box, so
// the interest, the timeline and the sentence under this bar all follow.
//
// The prices are the market card's own read (lib/gondi/lenderPitch.ts). The bar adds none.
import { barAmount, barMax, barStep, barZone } from '../../lib/gondi/floorBar';
import { monoWidth, placeLabels, type MarkLabel } from '../../lib/markLabels';

const W = 320;
const H = 58;
const PAD = 10;
const LABEL = 9;
const TRACK = 20;

const COLOR = { covered: '#10b981', 'under-floor': '#f59e0b', 'over-floor': '#ef4444' } as const;

export function FloorBar(p: {
  symbol: string;
  /** WETH lent per loan, as a number; null while nothing valid is typed. */
  principal: number | null;
  floor: number | null;
  /** The best open bid for any NFT of the collection; null when there is none or it is unread. */
  bestBid: number | null;
  setPrincipal: (text: string) => void;
}) {
  const max = barMax(p.floor, p.bestBid, p.principal);
  if (max === null || p.floor === null || p.principal === null || !(p.principal > 0)) return null;
  const floor = p.floor;
  const x = (v: number) => PAD + (Math.min(Math.max(v, 0), max) / max) * (W - 2 * PAD);
  const zone = barZone(p.principal, floor, p.bestBid);
  const bid = p.bestBid !== null && p.bestBid > 0 ? p.bestBid : null;
  const step = barStep(floor);
  // "best bid" on the outer side of its mark, "floor" on the outer side of its own (a bid that
  // reads past the floor swaps them). A bid far down the bar slides its label inward rather
  // than off the bar.
  const bidPastFloor = bid !== null && bid > floor;
  const marks: MarkLabel[] = [{ at: x(floor), width: monoWidth('floor', LABEL), side: bidPastFloor ? 'left' : 'right' }];
  if (bid !== null) marks.push({ at: x(bid), width: monoWidth('best bid', LABEL), side: bidPastFloor ? 'right' : 'left' });
  const [floorLabel, bidLabel] = placeLabels(marks, W, 3);
  const valueText =
    zone === 'covered'
      ? `${barAmount(p.principal)} WETH: at or under the best bid`
      : zone === 'under-floor'
      ? `${barAmount(p.principal)} WETH: over the best bid, under the floor`
      : `${barAmount(p.principal)} WETH: over the floor`;

  return (
    <div className="relative" data-testid="floor-bar" data-zone={zone} style={{ touchAction: 'pan-y' }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" aria-hidden="true" focusable="false">
        {/* The three stretches: a buyer already pays this; under the floor; over it. */}
        {bid !== null && <rect x={x(0)} y={TRACK} width={x(Math.min(bid, floor)) - x(0)} height={10} fill="rgba(16,185,129,0.35)" />}
        <rect x={x(bid !== null ? Math.min(bid, floor) : 0)} y={TRACK} width={x(floor) - x(bid !== null ? Math.min(bid, floor) : 0)} height={10} fill="rgba(245,158,11,0.30)" />
        <rect x={x(floor)} y={TRACK} width={x(max) - x(floor)} height={10} fill="rgba(239,68,68,0.30)" />

        {bid !== null && (
          <g>
            <line x1={x(bid)} y1={TRACK - 6} x2={x(bid)} y2={TRACK + 16} stroke="#34d399" strokeWidth="1.5" />
            <text x={bidLabel} y={H - 4} fontSize={LABEL} fontFamily="ui-monospace, monospace" fill="#6ee7b7">
              best bid
            </text>
          </g>
        )}
        <line x1={x(floor)} y1={TRACK - 6} x2={x(floor)} y2={TRACK + 16} stroke="#f5e4b8" strokeWidth="1.5" />
        <text x={floorLabel} y={H - 4} fontSize={LABEL} fontFamily="ui-monospace, monospace" fill="#f5e4b8">
          floor
        </text>

        <line x1={x(p.principal)} y1={TRACK - 10} x2={x(p.principal)} y2={TRACK + 10} stroke="#ffffff" strokeWidth="1.5" />
        <circle cx={x(p.principal)} cy={TRACK + 5} r="7" fill={COLOR[zone]} stroke="#ffffff" strokeWidth="2" style={{ transition: 'fill 150ms' }} />
      </svg>
      <input
        type="range"
        min={0}
        max={max}
        step={step}
        value={Math.min(p.principal, max)}
        onChange={(e) => {
          const v = Number(e.target.value);
          // Nothing is not an offer: the handle stops one step above it.
          p.setPrincipal(barAmount(v < step ? step : v));
        }}
        aria-label={`Amount lent, against the ${p.symbol} floor and best bid`}
        aria-valuetext={valueText}
        className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
        style={{ minHeight: 44, fontSize: 16 }}
      />
    </div>
  );
}
