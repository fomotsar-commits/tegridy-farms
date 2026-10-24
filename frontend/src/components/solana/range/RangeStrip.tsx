import { EDITORIAL_INK } from '../../../lib/editorial';
import { stripLayout } from '../../../lib/solana/clmm/rangeStrip';

const GREEN = '#22c55e';

/**
 * The range, drawn: this pool's price (green, "here"), the market's (cream) and the picked
 * range as a band, on one log axis (rangeStrip.ts). Only prices the card already shows are
 * drawn, and one sentence says it all to a screen reader. The band moves as the range does.
 */
export function RangeStrip(p: {
  now: number;
  market: number | null;
  lo: number | null;
  hi: number | null;
  /** The same prices as the card's rows write them. */
  words: { now: string; market: string | null; lo: string | null; hi: string | null; unit: string };
}) {
  const s = stripLayout({ now: p.now, market: p.market, lo: p.lo, hi: p.hi });
  if (!s) return null;
  const w = p.words;
  const range = s.band && w.lo && w.hi ? `your range, ${w.lo} to ${w.hi}` : null;
  const label = [
    `This pool’s price, ${w.now}${range ? `, is ${s.where === 'inside' ? 'inside' : s.where === 'below' ? 'below' : 'above'} ${range}` : ''}.`,
    s.market !== null && w.market ? `The market price is ${w.market}.` : '',
  ].join(' ').trim();
  return (
    <figure data-testid="range-strip" data-where={s.where ?? 'none'} className="!mt-3 !mb-1">
      <div role="img" aria-label={label} className="relative h-[72px] border-y border-white/[0.14] overflow-hidden">
        {/* A hairline every tenth of the axis: the strip's own ruler. */}
        <div aria-hidden="true" className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(to right, rgba(245,228,184,0.07) 1px, transparent 1px)', backgroundSize: '10% 100%' }} />
        {s.band && (
          <div
            data-testid="range-strip-band"
            className="absolute inset-y-3 transition-[left,width] duration-500 ease-out motion-reduce:transition-none"
            style={{ left: `${s.band.from}%`, width: `${s.band.to - s.band.from}%`, background: 'rgba(34,197,94,0.16)', borderLeft: `1px solid ${GREEN}`, borderRight: `1px solid ${GREEN}` }}
          />
        )}
        {s.market !== null && <Mark at={s.market} color={EDITORIAL_INK} label="market" low />}
        <Mark at={s.now} color={GREEN} label="this pool" />
      </div>
      <figcaption className="mt-1.5 flex justify-between gap-3 font-mono text-[10px] tracking-[0.12em] text-[#f5e4b8]/55">
        <span>{s.where === 'inside' ? 'in range: earning from the first swap' : s.where ? 'out of range now: earns once the price reaches it' : 'pick a range to see it here'}</span>
        <span className="hidden sm:inline">{w.unit}, log scale</span>
      </figcaption>
    </figure>
  );
}

function Mark({ at, color, label, low = false }: { at: number; color: string; label: string; low?: boolean }) {
  // Labels hug the side with room, so one near an edge stays on the strip.
  const right = at > 70;
  return (
    <div aria-hidden="true" className="absolute inset-y-0" style={{ left: `${at}%` }}>
      <span className="absolute inset-y-0 w-px" style={{ background: color }} />
      <span
        className={`absolute ${low ? 'bottom-1' : 'top-1'} ${right ? 'right-1.5' : 'left-1.5'} whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em]`}
        style={{ color }}
      >
        {label}
      </span>
    </div>
  );
}
