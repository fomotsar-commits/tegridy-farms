import type { MetricDisplay } from '../../lib/yield/display';

// One figure, or the explicit absence of one.
//
// The reason is rendered as VISIBLE TEXT, not as a tooltip or a title attribute.
// A hidden explanation behind an em dash is functionally the same as no
// explanation: the reader who most needs it is the one skimming a column of
// numbers, and skimming does not hover. It also keeps the disclosure on the touch
// path, which a hover affordance never reaches.
//
// The unavailable branch is styled DOWN, not up — muted rather than alarmed. An
// unread figure is a gap in what this venue could measure, not a warning about
// the protocol in that row, and colouring it red would turn a missing reading
// into an accusation.

export interface YieldMetricCellProps {
  label: string;
  display: MetricDisplay;
  /** Draws attention to a real reading (a peg discount). Never set on an absence. */
  notable?: boolean;
}

export function YieldMetricCell({ label, display, notable = false }: YieldMetricCellProps) {
  const emphasise = notable && !display.unavailable;
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-text-muted mb-0.5">{label}</p>
      <p
        className={`font-mono text-[15px] leading-tight ${
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
        {display.unavailable && <span className="sr-only"> not available</span>}
      </p>
      <p className="text-[10px] text-text-muted leading-snug mt-0.5">{display.detail}</p>
    </div>
  );
}

export default YieldMetricCell;
