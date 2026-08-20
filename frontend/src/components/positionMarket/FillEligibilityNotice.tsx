import type { FillVerdict } from '../../hooks/usePositionMarketFillability';
import { canOfferOneClickFill, secondsUntilReleasable } from '../../hooks/usePositionMarketFillability';

/**
 * Renders the buyer pre-check for one listing.
 *
 * Four states, and they are four states on purpose:
 *
 *   clear       — the chain confirmed every applicable condition.
 *   unverified  — nothing blocking was found, but the check could not be
 *                 finished (a contract recipient's position count is unreadable
 *                 on TegridyStaking). Deliberately does NOT look like `clear`:
 *                 the buyer may proceed, but from a screen that says so.
 *   blocked     — the chain says this will fail, and why.
 *   unavailable — nothing was read. Never drawn as either a pass or a refusal.
 *
 * The one thing this component must never do is let `unverified` or
 * `unavailable` render with the affirmative styling of `clear`.
 */

const TONE = {
  clear: { color: '#22c55e', glyph: '✓', border: 'rgba(34,197,94,0.35)', bg: 'rgba(34,197,94,0.08)' },
  unverified: { color: 'var(--color-towelie)', glyph: '?', border: 'rgba(148,163,184,0.35)', bg: 'rgba(148,163,184,0.08)' },
  blocked: { color: 'var(--color-kenny)', glyph: '⚠', border: 'rgba(239,68,68,0.35)', bg: 'rgba(239,68,68,0.08)' },
  unavailable: { color: '#94a3b8', glyph: '–', border: 'rgba(148,163,184,0.25)', bg: 'rgba(148,163,184,0.05)' },
} as const;

function formatWait(seconds: number): string {
  if (seconds <= 0) return '';
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.ceil(mins / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function FillEligibilityNotice({
  verdict,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  verdict: FillVerdict;
  nowSeconds?: number;
}) {
  const tone = TONE[verdict.kind];
  const wait = secondsUntilReleasable(verdict, nowSeconds);

  let heading: string;
  let body: string;
  if (verdict.kind === 'clear') {
    heading = 'Checked — this wallet can receive the position';
    body = 'The staking contract will accept the transfer to this address.';
  } else if (verdict.kind === 'unverified') {
    heading = 'Could not finish checking';
    body = verdict.message;
  } else if (verdict.kind === 'blocked') {
    heading = 'This purchase would fail';
    body = verdict.message;
  } else {
    heading = 'Eligibility unknown';
    body = verdict.reason;
  }

  return (
    <div
      role="status"
      data-verdict={verdict.kind}
      style={{
        display: 'flex',
        gap: '0.6rem',
        alignItems: 'flex-start',
        padding: '0.7rem 0.85rem',
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        borderRadius: 10,
        fontSize: '0.85rem',
        lineHeight: 1.45,
      }}
    >
      <span aria-hidden style={{ color: tone.color, fontWeight: 700, lineHeight: 1.4 }}>
        {tone.glyph}
      </span>
      <span>
        <strong style={{ color: tone.color, display: 'block' }}>{heading}</strong>
        <span style={{ opacity: 0.85 }}>{body}</span>
        {verdict.kind === 'blocked' && verdict.releasableAt !== null && wait > 0 && (
          <span style={{ display: 'block', marginTop: '0.35rem', opacity: 0.7 }}>
            Buyable in {formatWait(wait)}.
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The buy control. Separated from the notice so the rule that governs it is in
 * one place: only a `clear` verdict gets an unqualified button. `unverified`
 * still lets the buyer act — refusing outright would be its own lie about what
 * we know — but it is labelled as a proceed-anyway, not as a confirmed purchase.
 */
export function FillButton({
  verdict,
  priceLabel,
  onFill,
  disabled = false,
}: {
  verdict: FillVerdict;
  priceLabel: string;
  onFill: () => void;
  disabled?: boolean;
}) {
  const confirmed = canOfferOneClickFill(verdict);
  const proceedAnyway = verdict.kind === 'unverified';
  const usable = (confirmed || proceedAnyway) && !disabled;

  return (
    <button
      type="button"
      onClick={onFill}
      disabled={!usable}
      style={{
        width: '100%',
        padding: '0.7rem 1rem',
        borderRadius: 10,
        fontWeight: 700,
        cursor: usable ? 'pointer' : 'not-allowed',
        opacity: usable ? 1 : 0.45,
        border: confirmed ? 'none' : '1px solid rgba(148,163,184,0.5)',
        background: confirmed ? 'var(--color-towelie)' : 'transparent',
        color: confirmed ? '#0b0b0b' : 'inherit',
      }}
    >
      {confirmed ? `Buy for ${priceLabel}` : proceedAnyway ? `Buy for ${priceLabel} (unchecked)` : `Buy for ${priceLabel}`}
    </button>
  );
}
