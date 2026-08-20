import { safetyBadge, type RowSafety, type SafetyTone } from '../../lib/terminal/rowSafety';

// The row's safety mark.
//
// The colour comes from `safetyBadge`, never from a prop and never from a local
// branch, because the colour is the claim: on a page scanned at speed, green IS
// the recommendation. Keeping the tone in the pure module means the one predicate
// that decides "safe" (isKnownSafe) drives the badge and the filter together, and
// a test can assert green ⇒ fully read without going through the DOM.
//
// `unknown` is styled as a distinctly UNFILLED, muted mark rather than as a
// paler green. A washed-out success colour reads as a weak pass; this has to read
// as an absence.

const TONE_STYLE: Record<SafetyTone, { color: string; tint: string; border: string }> = {
  good: { color: 'var(--color-success)', tint: 'rgba(49,208,170,0.12)', border: 'rgba(49,208,170,0.40)' },
  warn: { color: 'var(--color-warning)', tint: 'rgba(255,178,55,0.12)', border: 'rgba(255,178,55,0.40)' },
  bad: { color: 'var(--color-danger)', tint: 'rgba(255,78,163,0.12)', border: 'rgba(255,78,163,0.40)' },
  unknown: { color: 'rgba(255,255,255,0.72)', tint: 'transparent', border: 'rgba(255,255,255,0.28)' },
};

export interface SafetyBadgeProps {
  safety: RowSafety;
  /** Renders the explanatory sentence beneath the pill. */
  withDetail?: boolean;
}

export function SafetyBadge({ safety, withDetail = false }: SafetyBadgeProps) {
  const badge = safetyBadge(safety);
  const style = TONE_STYLE[badge.tone];
  return (
    <span className="inline-flex flex-col gap-1 align-top">
      <span
        data-testid="safety-badge"
        data-tone={badge.tone}
        className="inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
        style={{ color: style.color, background: style.tint, borderColor: style.border }}
        title={badge.detail}
      >
        {badge.tone === 'unknown' ? (
          <span aria-hidden="true" className="text-[13px] leading-none">
            ?
          </span>
        ) : null}
        {badge.label}
      </span>
      {withDetail && badge.detail ? (
        <span className="max-w-prose text-[11px] leading-snug text-white/70">{badge.detail}</span>
      ) : null}
    </span>
  );
}
