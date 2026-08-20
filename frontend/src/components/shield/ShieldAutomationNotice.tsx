import { SHIELD_COPY, shieldAutomationState } from '../../lib/shield/automation';

// The block that keeps this product honest.
//
// It is rendered ABOVE the positions, unconditionally, and it is not collapsible
// into nothing: a user who scrolls straight to the red row and the big button
// must have already passed the sentence saying nothing fires on its own. The
// requirements list is shown behind a disclosure because it is for the curious
// and the operator, but the two sentences before it are not.

export function ShieldAutomationNotice() {
  const state = shieldAutomationState();

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-kenny)' }}
      aria-label="How this shield works"
    >
      <p className="text-[12px] font-semibold" style={{ color: 'var(--color-kenny)' }}>
        {state.statusLabel}
      </p>
      <p className="mt-1 text-white text-[13px] leading-snug">{state.statusDetail}</p>
      <p className="mt-1 text-white/70 text-[12px] leading-snug">{SHIELD_COPY.monitoringScope}</p>
      <p className="mt-1 text-white/70 text-[12px] leading-snug">{SHIELD_COPY.alertIsNotAnAction}</p>
      <p className="mt-1 text-white/70 text-[12px] leading-snug">{SHIELD_COPY.onlyFullRepayment}</p>

      {state.requirements.length > 0 && (
        <details className="mt-3">
          <summary className="text-white/60 text-[11px] cursor-pointer">
            {SHIELD_COPY.automationHeading}
          </summary>
          <p className="mt-2 text-white/60 text-[11px] leading-snug">{SHIELD_COPY.automationLead}</p>
          <ul className="mt-2 space-y-1.5">
            {state.requirements.map((req) => (
              <li key={req} className="text-white/55 text-[11px] leading-snug list-disc ml-4">
                {req}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default ShieldAutomationNotice;
