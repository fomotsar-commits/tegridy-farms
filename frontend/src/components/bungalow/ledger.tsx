// THE LEDGER — the shared surface both bungalow pool cards print their figures on.
//
// One solid panel with hairline dividers, never a translucent box per number. It was
// written for the lock-ladder card (0f968312) after the owner called the old stat
// tiles "hideous": labels wrapped into values, units fell onto their own line,
// sentences sat inside tiles. The lighthouse card now prints on the SAME primitive,
// so the two cards cannot drift apart again.
import { m } from 'framer-motion';
import { staggerItem } from '../../lib/motion';

export const HEAD = 'var(--font-family-heading)';
/** Solid enough that a number never fights the art behind it for legibility. */
export const PANEL_BG = 'rgba(5,9,18,0.92)';
export const LEDGER_BG = 'rgba(7,11,22,0.94)';
export const HAIR = 'rgba(255,255,255,0.08)';
/**
 * A grid's background as its dividers: cells are opaque, the 1px gaps between them
 * show this. Layered over the solid ledger colour so the island's art does NOT show
 * through the hairlines.
 */
export const DIVIDED_BG = `linear-gradient(rgba(255,255,255,0.06), rgba(255,255,255,0.06)), ${LEDGER_BG}`;
export const CELL_BG = '#070b16';

/**
 * One fact in a ledger: a label, then its value, then (only when the value itself is
 * in doubt) a short state note — "reading…" or "could not be read".
 *
 * ⚠️ THE DOM CONTRACT the card's tests read: label <p>, then the value <p> as its
 * nextElementSibling (the unit INSIDE it), then the optional state <p>, all children of
 * one cell element.
 *
 * Nothing is absolutely positioned, so a label can never sit on top of its value. On a
 * narrow ledger it is a list row (label left, value right, one baseline); past `at`
 * the value stacks under the label.
 *
 * The narrow row is a WRAPPING FLEX row, not a two-column grid. In a
 * `minmax(0,1fr) auto` grid a wide value squeezed an unbreakable label ("CONFIGURED"
 * beside "22.1%–43.7% APR" at 320px) to zero and the two overlapped. Flex wraps
 * before it shrinks, so when both do not fit the value drops to its own line,
 * still right-aligned, and nothing overlaps. The value never wraps and the unit shares its
 * baseline, so a number and its unit cannot come apart.
 *
 * The class strings are spelled out per breakpoint because Tailwind only emits classes
 * it can find verbatim in the source.
 */
const FACT_LAYOUT = {
  '30rem': {
    cell: 'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 @min-[30rem]:grid @min-[30rem]:grid-cols-1 @min-[30rem]:content-start @min-[30rem]:gap-y-1.5 @min-[30rem]:px-5 @min-[30rem]:py-4',
    value: 'ml-auto @min-[30rem]:ml-0 @min-[30rem]:justify-self-start',
    state: 'basis-full text-right @min-[30rem]:justify-self-start @min-[30rem]:text-left',
    span2: '@min-[30rem]:col-span-2',
  },
  '40rem': {
    cell: 'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 @min-[40rem]:grid @min-[40rem]:grid-cols-1 @min-[40rem]:content-start @min-[40rem]:gap-y-1.5 @min-[40rem]:px-5 @min-[40rem]:py-4',
    value: 'ml-auto @min-[40rem]:ml-0 @min-[40rem]:justify-self-start',
    state: 'basis-full text-right @min-[40rem]:justify-self-start @min-[40rem]:text-left',
    span2: '@min-[40rem]:col-span-2',
  },
} as const;

export function Fact({
  label, value, unit, state, describedBy, span2, inline, at = '30rem', tone, className = '',
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  state?: string;
  describedBy?: string;
  span2?: boolean;
  /** A single pair set in running layout (the action rail), not a ledger cell. */
  inline?: boolean;
  at?: keyof typeof FACT_LAYOUT;
  /** 'good' greens a live, positive figure; 'muted' softens a real zero. */
  tone?: 'good' | 'muted';
  /** Extra cell classes — e.g. column spans a ledger computes from its cell count. */
  className?: string;
}) {
  const valueEl = (
    <p
      className={`m-0 flex items-baseline gap-[0.35em] whitespace-nowrap tabular-nums ${inline ? '' : FACT_LAYOUT[at].value}`}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <span
        style={{ color: tone === 'good' ? '#4ade80' : tone === 'muted' ? 'rgba(255,255,255,0.85)' : '#ffffff', fontWeight: 600, fontSize: inline ? 15 : 'clamp(18px, calc(2.2cqi + 10px), 24px)', lineHeight: 1.15 }}
      >
        {value}
      </span>
      {unit ? (
        <span style={{ fontFamily: HEAD, fontWeight: 500, fontSize: 'max(11px, 0.5em)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.55)' }}>
          {unit}
        </span>
      ) : null}
    </p>
  );
  const labelEl = (
    <p className="m-0 min-w-0 text-[11px] uppercase tracking-[0.12em] leading-snug" style={{ color: 'rgba(76,175,80,0.9)', fontFamily: HEAD }}>
      {label}
    </p>
  );
  if (inline) {
    return (
      <div className="flex items-baseline gap-2.5 min-w-0" aria-describedby={describedBy}>
        {labelEl}
        {valueEl}
      </div>
    );
  }
  return (
    <m.div
      variants={staggerItem}
      className={`${FACT_LAYOUT[at].cell} ${span2 ? FACT_LAYOUT[at].span2 : ''} ${className} min-w-0`}
      style={{ background: CELL_BG }}
      aria-describedby={describedBy}
    >
      {labelEl}
      {valueEl}
      {state && (
        <p className={`m-0 text-[11px] ${FACT_LAYOUT[at].state}`} style={{ color: '#f0b26b' }}>{state}</p>
      )}
    </m.div>
  );
}
