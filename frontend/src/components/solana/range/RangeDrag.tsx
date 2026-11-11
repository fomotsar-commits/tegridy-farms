// The range, picked by dragging its two edges.
//
// The strip under this one DRAWS the range; this one SETS it. Two handles on a fixed log axis
// around the price the range starts from (lib/solana/clmm/rangeDrag.ts): drag the left one for
// the lowest price, the right one for the highest. Each move writes a price into the same two
// boxes the presets and the keyboard fill (rangePick.ts), so everything below (the nearest
// usable prices, which coins the range holds, the amounts) follows exactly as if it were typed.
// It decides nothing of its own.
//
// Two real sliders sit under the picture for the keyboard and screen readers; the picture
// itself takes the pointer, so one touch grabs whichever handle is nearer.
import { useRef, useState } from 'react';
import {
  DRAG_GAP,
  DRAG_STEP,
  DRAG_STOPS,
  moveHandle,
  nearerHandle,
  priceAtStop,
  stopAtFraction,
  stopAtPrice,
  stopFraction,
  stopTimes,
} from '../../../lib/solana/clmm/rangeDrag';
import { formatSolPrice } from '../../../lib/solana/lp/format';

const GREEN = '#22c55e';
const W = 320;
const H = 64;
const PAD = 14;
const MID = 30;

const x = (stop: number) => PAD + stopFraction(stop) * (W - 2 * PAD);

export function RangeDrag(p: {
  /** The price the range starts from. */
  now: number;
  /** The range as it stands, in the same unit; null while none is picked. */
  lo: number | null;
  hi: number | null;
  /** What `now` is, for the sliders' names: "this pool’s price". */
  at: string;
  setMin: (text: string) => void;
  setMax: (text: string) => void;
  /** True while the form is sending: the handles hold still. */
  disabled?: boolean;
}) {
  const track = useRef<SVGSVGElement | null>(null);
  // While a handle is held, it follows the finger; let go, and it shows the range the form
  // settled on (the nearest prices a position can use).
  const [held, setHeld] = useState<{ which: 'lo' | 'hi'; lo: number; hi: number } | null>(null);
  // The handle a keyboard is on, drawn larger: the real sliders are off screen.
  const [focused, setFocused] = useState<'lo' | 'hi' | null>(null);
  if (!(Number.isFinite(p.now) && p.now > 0)) return null;

  const fromForm = { lo: stopAtPrice(p.now, p.lo), hi: stopAtPrice(p.now, p.hi) };
  const picked = fromForm.lo !== null && fromForm.hi !== null && fromForm.lo < fromForm.hi;
  // Before any range is picked the handles rest at half and double, drawn faint.
  const shown = held ?? (picked ? { lo: fromForm.lo!, hi: fromForm.hi! } : { lo: -100, hi: 100 });

  const commit = (which: 'lo' | 'hi', to: number): { lo: number; hi: number } => {
    const next = moveHandle(shown, which, to);
    // The first move of an unpicked range sets both edges: one price alone is no range.
    if (which === 'lo' || !picked) p.setMin(formatSolPrice(priceAtStop(p.now, next.lo)));
    if (which === 'hi' || !picked) p.setMax(formatSolPrice(priceAtStop(p.now, next.hi)));
    return next;
  };

  const stopUnder = (clientX: number): number | null => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    const inner = (clientX - box.left) / box.width; // 0..1 across the whole picture
    const f = (inner * W - PAD) / (W - 2 * PAD);
    return stopAtFraction(f);
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (p.disabled) return;
    const stop = stopUnder(e.clientX);
    if (stop === null) return;
    const which = nearerHandle(shown, stop);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHeld({ which, ...commit(which, stop) });
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!held) return;
    const stop = stopUnder(e.clientX);
    if (stop === null) return;
    const next = commit(held.which, stop);
    if (next.lo !== held.lo || next.hi !== held.hi) setHeld({ which: held.which, ...next });
  };
  const onUp = () => setHeld(null);

  const inside = shown.lo <= 0 && shown.hi >= 0;
  const faint = !picked && !held;
  const slider = (which: 'lo' | 'hi') => (
    <input
      type="range"
      min={which === 'lo' ? -DRAG_STOPS : shown.lo + DRAG_GAP}
      max={which === 'lo' ? shown.hi - DRAG_GAP : DRAG_STOPS}
      step={DRAG_STEP}
      value={shown[which]}
      onChange={(e) => commit(which, Number(e.target.value))}
      onFocus={() => setFocused(which)}
      onBlur={() => setFocused(null)}
      disabled={p.disabled}
      aria-label={`Range’s ${which === 'lo' ? 'lower' : 'upper'} edge, against ${p.at}`}
      aria-valuetext={`${stopTimes(shown[which])}: ${formatSolPrice(priceAtStop(p.now, shown[which]))}`}
      data-testid={`range-drag-${which}`}
      className="sr-only"
      style={{ fontSize: 16 }}
    />
  );

  return (
    <div data-testid="range-drag" data-picked={picked ? 'yes' : 'no'}>
      <svg
        ref={track}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full h-auto select-none cursor-ew-resize rounded-lg border border-white/[0.14] bg-black/30"
        style={{ touchAction: 'pan-y', minHeight: 56 }}
        aria-hidden="true"
        focusable="false"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {/* One hairline a doubling: a sixteenth ... the same ... 16 times. */}
        {[-400, -300, -200, -100, 0, 100, 200, 300, 400].map((s) => (
          <line key={s} x1={x(s)} y1={s === 0 ? 6 : 14} x2={x(s)} y2={s === 0 ? H - 6 : H - 14} stroke={s === 0 ? GREEN : 'rgba(245,228,184,0.18)'} strokeWidth={s === 0 ? 1.5 : 1} />
        ))}
        {/* The band between the handles. */}
        <rect
          x={x(shown.lo)}
          y={MID - 12}
          width={Math.max(0, x(shown.hi) - x(shown.lo))}
          height={24}
          rx={4}
          fill={inside ? 'rgba(34,197,94,0.22)' : 'rgba(245,158,11,0.22)'}
          opacity={faint ? 0.45 : 1}
        />
        {(['lo', 'hi'] as const).map((which) => (
          <g key={which} opacity={faint ? 0.55 : 1}>
            <line x1={x(shown[which])} y1={MID - 16} x2={x(shown[which])} y2={MID + 16} stroke={inside ? GREEN : '#f59e0b'} strokeWidth="2" />
            <circle
              cx={x(shown[which])}
              cy={MID}
              r={held?.which === which || focused === which ? 9 : 7.5}
              fill={inside ? '#10b981' : '#f59e0b'}
              stroke="#ffffff"
              strokeWidth={focused === which ? 3.5 : 2}
              style={{ transition: 'r 120ms' }}
            />
            <text x={x(shown[which])} y={H - 3} textAnchor={which === 'lo' ? 'end' : 'start'} dx={which === 'lo' ? -4 : 4} fontSize="9" fontFamily="ui-monospace, monospace" fill="rgba(245,228,184,0.8)">
              {stopTimes(shown[which])}
            </text>
          </g>
        ))}
      </svg>
      {slider('lo')}
      {slider('hi')}
    </div>
  );
}
