// The loan as one picture you can drag through.
//
// A loan's whole deal is three facts that tables hide: the cost grows every day, there are a
// few moments worth being reminded of, and at the deadline the NFT changes hands with no grace
// period. This draws the loan's life left to right: the debt rising as a wedge, the reminder
// moments as ticks, and the deadline as a wall. Dragging the handle (or the arrow keys: it is
// a native range input) answers "what if it is repaid THEN?" in WETH, for either side.
//
// It adds no promise of its own: every figure comes from `costAt`, which the caller builds
// from Gondi's own arithmetic (lib/gondi/loanMath.ts).
import { useId, useState } from 'react';
import { dayOf, lifeFraction, reminderFractions, scrubStep } from '../../lib/gondi/timeline';
import { fmtWeth, formatDue } from './nftLendingShared';

export interface TimelineCost {
  /** What the borrower pays to close the loan at that moment. */
  total: bigint;
  /** The venue's share of the interest. */
  toVenue: bigint;
  /** What the lender receives: principal plus their share of the interest. */
  toLenders: bigint;
  interest: bigint;
}

interface Props {
  side: 'borrower' | 'lender';
  /** Seconds since 1970. For an offer not taken yet, "now". */
  start: number;
  duration: number;
  /** A live loan's present moment: the scrub starts here and cannot go back before it. */
  now?: number;
  costAt: (seconds: number) => TimelineCost;
  /** What changes hands at the wall, e.g. "NAKA #1234" or "a NAKA". */
  nft: string;
  /** False for an offer preview: the dates are "about", since the loan has not started. */
  exact?: boolean;
}

const W = 320;
const H = 84;
const PAD = 10;
const BASE = 62; // the debt's floor line
const TOP = 16; // the wedge's height at the deadline

export function LoanTimeline({ side, start, duration, now, costAt, nft, exact = true }: Props) {
  const id = useId();
  const end = start + duration;
  const min = now !== undefined ? Math.min(Math.max(now, start), end) : start;
  const step = scrubStep(duration);
  const [picked, setPicked] = useState<number | null>(null);
  // An offer preview opens at the deadline (the most it can cost); a live loan opens at now.
  const at = picked !== null ? Math.min(Math.max(picked, min), end) : now !== undefined ? min : end;

  const x = (f: number) => PAD + f * (W - 2 * PAD);
  const fAt = lifeFraction(start, duration, at);
  const fNow = now !== undefined ? lifeFraction(start, duration, min) : 0;
  const yAt = BASE - fAt * (BASE - TOP);
  const atWall = at >= end;
  const cost = costAt(at);
  const interestKept = cost.interest - cost.toVenue;
  const { day, of } = dayOf(start, duration, at);

  const headline =
    side === 'borrower'
      ? `Repay ${fmtWeth(cost.total, 6)} WETH`
      : `You keep ${fmtWeth(interestKept > 0n ? interestKept : 0n, 6)} WETH`;
  const when = `${exact ? '' : 'about '}${formatDue(at)}`;
  const valueText = `Day ${day} of ${of}, ${when}: ${headline}`;

  return (
    <div className="rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.10)' }} data-testid="loan-timeline">
      <div className="flex items-baseline justify-between gap-3">
        <p className={`text-[15px] font-semibold font-mono ${atWall ? 'text-amber-300' : 'text-emerald-300'}`} data-testid="loan-timeline-headline">
          {headline}
        </p>
        <p className="text-white/80 text-[11px] text-right" data-testid="loan-timeline-when">
          day {day} of {of} · {when}
        </p>
      </div>

      <div className="relative mt-1" style={{ touchAction: 'pan-y' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={`${id}-debt`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#10b981" stopOpacity="0.15" />
              <stop offset="1" stopColor="#10b981" stopOpacity="0.55" />
            </linearGradient>
            <pattern id={`${id}-lost`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="rgba(239,68,68,0.10)" />
              <rect width="2" height="6" fill="rgba(239,68,68,0.55)" />
            </pattern>
          </defs>

          {/* The debt: flat principal, interest rising on top of it, left to right. */}
          <polygon points={`${x(0)},${BASE} ${x(1)},${BASE} ${x(1)},${TOP}`} fill={`url(#${id}-debt)`} />
          <line x1={x(0)} y1={BASE} x2={x(1)} y2={TOP} stroke="#34d399" strokeWidth="1.5" />
          <line x1={x(0)} y1={BASE} x2={x(1)} y2={BASE} stroke="rgba(255,255,255,0.35)" strokeWidth="1" />

          {/* Time already spent on a live loan. */}
          {now !== undefined && fNow > 0 && (
            <rect x={x(0)} y={TOP - 4} width={x(fNow) - x(0)} height={BASE - TOP + 4} fill="rgba(6,12,26,0.6)" />
          )}

          {/* The moments the calendar file rings. */}
          {reminderFractions(duration).map((f) => (
            <g key={f}>
              <line x1={x(f)} y1={BASE} x2={x(f)} y2={BASE + 6} stroke="#fbbf24" strokeWidth="1.5" />
              <circle cx={x(f)} cy={BASE + 9} r="1.8" fill="#fbbf24" />
            </g>
          ))}

          {/* The wall: past the deadline the NFT is the lender's. */}
          <rect x={x(1)} y={TOP - 8} width={PAD} height={BASE - TOP + 16} fill={`url(#${id}-lost)`} />
          <line x1={x(1)} y1={TOP - 8} x2={x(1)} y2={BASE + 8} stroke="#ef4444" strokeWidth="2" />

          {/* The handle. */}
          <line x1={x(fAt)} y1={yAt} x2={x(fAt)} y2={BASE} stroke={atWall ? '#fbbf24' : '#ffffff'} strokeWidth="1.5" strokeDasharray="2 2" />
          <circle cx={x(fAt)} cy={yAt} r="6.5" fill={atWall ? '#fbbf24' : '#10b981'} stroke="#ffffff" strokeWidth="2" style={{ transition: 'fill 150ms' }} />
        </svg>
        {/* The real control: a native range input laid over the picture, so touch drag, the
            arrow keys, Home/End and screen readers all work without code of our own. */}
        <input
          type="range"
          min={min}
          max={end}
          step={step}
          value={at}
          onChange={(e) => {
            const v = Number(e.target.value);
            // A range input stops at its last whole step, which can fall short of the deadline:
            // the last stop IS the deadline.
            setPicked(v + step > end ? end : v);
          }}
          aria-label={side === 'borrower' ? 'Day you repay on' : 'Day the loan is repaid on'}
          aria-valuetext={valueText}
          className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
          style={{ minHeight: 44 }}
        />
      </div>

      <p className={`text-[12px] mt-1 ${atWall ? 'text-amber-300' : 'text-white/80'}`} aria-live="polite" data-testid="loan-timeline-line">
        {atWall
          ? side === 'borrower'
            ? `Last moment to repay. After it the lender keeps ${nft}.`
            : `Not repaid by now: you own ${nft}, and no interest.`
          : side === 'borrower'
          ? `${fmtWeth(cost.interest, 6)} WETH of that is interest. Drag to try another day.`
          : `The venue keeps ${fmtWeth(cost.toVenue, 6)} WETH of the interest. Drag to try another day.`}
      </p>
    </div>
  );
}
