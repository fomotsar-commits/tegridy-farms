import { EDITORIAL_INK } from '../../../lib/editorial';
import { stripLayout } from '../../../lib/solana/clmm/rangeStrip';
import { monoWidth, placeLabels, sideWithRoom } from '../../../lib/markLabels';
import { useDrawWidth } from '../../../hooks/useDrawWidth';

const GREEN = '#22c55e';
// A mark's label: 10 px capitals, tracked 0.14em, 6 px off its line. Its width is estimated the
// way the other instruments' labels are (lib/markLabels.ts), plus the tracking.
const MARK_FONT = 10;
const MARK_GAP = 6;
const markWidth = (text: string) => monoWidth(text, MARK_FONT) + text.length * MARK_FONT * 0.14;

/**
 * The range, drawn: the price the range starts from (a pool's own, or a new pool's opening
 * price; green), the market's (cream) and the picked range as a band, on one log axis
 * (rangeStrip.ts). Only prices the card already shows are drawn, and one sentence says it all
 * to a screen reader. The band moves as the range does. From PR #978's strip.
 */
export function RangeStrip(p: {
  now: number;
  market: number | null;
  lo: number | null;
  hi: number | null;
  /** What `now` is, as a sentence starts it ("This pool’s price") and as its mark says it ("this pool"). */
  nowName: string;
  nowMark: string;
  /** The same prices as the card's rows write them. */
  words: { now: string; market: string | null; lo: string | null; hi: string | null; unit: string };
}) {
  const [box, W] = useDrawWidth();
  const s = stripLayout({ now: p.now, market: p.market, lo: p.lo, hi: p.hi });
  if (!s) return null;
  // Each label on the right of its line when the whole of it fits there, else on the left: one
  // near an edge stays whole on a phone. The two never meet: one is at the top, one at the foot.
  const labelLeft = (at: number, text: string) => {
    const x = (at / 100) * W;
    const width = markWidth(text);
    const [left = x] = placeLabels([{ at: x, width, side: sideWithRoom(x, width, W, 'right', MARK_GAP) }], W, MARK_GAP);
    return left;
  };
  const w = p.words;
  const range = s.band && w.lo && w.hi ? `your range, ${w.lo} to ${w.hi}` : null;
  const label = [
    `${p.nowName}, ${w.now}${range ? `, is ${s.where === 'inside' ? 'inside' : s.where === 'below' ? 'below' : 'above'} ${range}` : ''}.`,
    s.market !== null && w.market ? `The market price is ${w.market}.` : '',
  ]
    .join(' ')
    .trim();
  return (
    <figure data-testid="range-strip" data-where={s.where ?? 'none'} className="m-0">
      <div role="img" aria-label={label} className="relative h-[72px] rounded-lg border border-white/[0.14] bg-black/30 overflow-hidden">
        {/* A hairline every tenth of the axis: the strip's own ruler. */}
        <div aria-hidden="true" className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(to right, rgba(245,228,184,0.07) 1px, transparent 1px)', backgroundSize: '10% 100%' }} />
        {s.band && (
          <div
            data-testid="range-strip-band"
            className="absolute inset-y-3 transition-[left,width] duration-500 ease-out motion-reduce:transition-none"
            style={{ left: `${s.band.from}%`, width: `${s.band.to - s.band.from}%`, background: 'rgba(34,197,94,0.16)', borderLeft: `1px solid ${GREEN}`, borderRight: `1px solid ${GREEN}` }}
          />
        )}
        <div ref={box} aria-hidden="true" className="absolute inset-0">
          {s.market !== null && <Mark at={s.market} left={labelLeft(s.market, 'market')} color={EDITORIAL_INK} label="market" low />}
          <Mark at={s.now} left={labelLeft(s.now, p.nowMark)} color={GREEN} label={p.nowMark} />
        </div>
      </div>
      <figcaption className="mt-1.5 flex justify-between gap-3 font-mono text-[10px] tracking-[0.12em] text-[#f5e4b8]/55">
        <span>{s.where === 'inside' ? 'in range: earning from the first swap' : s.where ? 'out of range now: earns once the price reaches it' : 'pick a range to see it here'}</span>
        <span className="hidden sm:inline">{w.unit}, log scale</span>
      </figcaption>
    </figure>
  );
}

/** A price's line across the strip, and its label `left` px from the strip's left edge. */
function Mark({ at, left, color, label, low = false }: { at: number; left: number; color: string; label: string; low?: boolean }) {
  return (
    <>
      <span className="absolute inset-y-0 w-px" style={{ left: `${at}%`, background: color }} />
      <span
        data-testid={low ? 'range-strip-label-market' : 'range-strip-label-now'}
        className={`absolute ${low ? 'bottom-1' : 'top-1'} whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em]`}
        style={{ left, color }}
      >
        {label}
      </span>
    </>
  );
}
