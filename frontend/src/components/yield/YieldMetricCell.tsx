import type { MetricDisplay } from '../../lib/yield/display';

// One figure, or the explicit absence of one.
//
// The reason is rendered as VISIBLE TEXT, not as a tooltip or a title attribute.
// A hidden explanation behind an em dash is functionally the same as no
// explanation: the reader who most needs it is the one skimming a column of
// numbers, and skimming does not hover. It also keeps the disclosure on the touch
// path, which a hover affordance never reaches.
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
}

export function YieldMetricCell({ label, display, notable = false }: YieldMetricCellProps) {
  const emphasise = notable && !display.unavailable;
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
        {display.unavailable && (
          <span className="sr-only">{display.notApplicable ? ' not applicable' : ' not available'}</span>
        )}
      </p>
      <p className="text-[10px] text-text-muted leading-snug mt-0.5 break-words">{display.detail}</p>
    </div>
  );
}

export default YieldMetricCell;
