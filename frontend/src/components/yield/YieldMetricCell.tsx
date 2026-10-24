import type { MetricDisplay } from '../../lib/yield/display';

// One figure, or the explicit absence of one.
//
// The ABSENCE is rendered as visible words ("not read", "not applicable"), not as
// a tooltip or a title attribute: the reader who most needs it is the one
// skimming a column of numbers, and skimming does not hover. The longer WHY
// (the source, the basis, the reason a read failed) moved into the row's
// FinePrint on 2026-10-13, at the owner's request for fewer words on the page;
// the row passes `detail` there, so nothing it said was dropped.
//
// `note` is the one qualifier a figure cannot be read without: whether an exit
// figure is redeemable liquidity or a queue in front of you, or how far under
// NAV a token is trading. Those stay visible because the bare number would say
// the opposite of the truth.
//
// The absent branches are styled DOWN, not up — muted rather than alarmed. An
// unread figure is a gap in what this venue could measure, not a warning about
// the protocol in that row, and colouring it red would turn a missing reading
// into an accusation.
//
// The two absences read differently to a screen reader on purpose. "Not
// available" means the read failed and might succeed on a reload; "not
// applicable" means there is nothing there to read and never will be. A reader
// who cannot tell them apart will keep reloading a cell that has already given
// its final answer.

export interface YieldMetricCellProps {
  label: string;
  display: MetricDisplay;
  /** Draws attention to a real reading (a discount to NAV). Never set on an absence. */
  notable?: boolean;
  /** A short visible qualifier the figure cannot be read without. Ignored on an absence. */
  note?: string;
}

export function YieldMetricCell({ label, display, notable = false, note }: YieldMetricCellProps) {
  const emphasise = notable && !display.unavailable;
  const qualifier = display.unavailable
    ? display.notApplicable
      ? 'not applicable'
      : 'not read'
    : [note, display.stale ? 'stale' : null].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5">{label}</p>
      <p
        className={`font-mono text-[15px] leading-tight break-words ${
          display.unavailable
            ? 'text-text-muted'
            : emphasise
              ? 'text-amber-300'
              : display.stale
                ? 'text-text-secondary'
                : 'text-text-primary'
        }`}
      >
        {display.text}
      </p>
      {qualifier !== '' && (
        <p className={`text-[10px] leading-snug mt-0.5 break-words ${emphasise ? 'text-amber-300/90' : 'text-text-muted'}`}>
          {qualifier}
        </p>
      )}
    </div>
  );
}

export default YieldMetricCell;
