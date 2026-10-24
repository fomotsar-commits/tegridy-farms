import { SHIELD_COPY, shieldAutomationState } from '../../lib/shield/automation';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';

// The block that keeps this product honest.
//
// It is rendered ABOVE the positions, unconditionally, and it is not collapsible
// into nothing: a user who scrolls straight to the red row and the big button
// must have already passed the sentence saying nothing fires on its own. That
// sentence (statusDetail) stays visible; the scope, the alert and the
// full-repayment rule, and the requirements list, sit one press away
// (owner, 2026-10-13: minimal words, small print in drop-downs).

export function ShieldAutomationNotice() {
  const state = shieldAutomationState();

  return (
    <section
      className="relative isolate rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-kenny)' }}
      aria-label="How this shield works"
    >
      <CardArt pageId="shield" idx={1} />
      <p className="text-[12px] font-semibold" style={{ color: 'var(--color-kenny)' }}>
        {state.statusLabel}
      </p>
      <p className="mt-1 text-white text-[13px] leading-snug">{state.statusDetail}</p>

      <FinePrint summary="How it works" className="mt-1">
        <p>{SHIELD_COPY.subtitle}</p>
        <p>{SHIELD_COPY.monitoringScope}</p>
        <p>{SHIELD_COPY.alertIsNotAnAction}</p>
        <p>{SHIELD_COPY.onlyFullRepayment}</p>
      </FinePrint>

      {state.requirements.length > 0 && (
        <FinePrint summary={SHIELD_COPY.automationHeading}>
          <p>{SHIELD_COPY.automationLead}</p>
          <ul className="space-y-1.5">
            {state.requirements.map((req) => (
              <li key={req} className="list-disc ml-4">
                {req}
              </li>
            ))}
          </ul>
        </FinePrint>
      )}
    </section>
  );
}

export default ShieldAutomationNotice;
