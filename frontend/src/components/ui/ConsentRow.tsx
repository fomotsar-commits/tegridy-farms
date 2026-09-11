import { useState } from 'react';
import { getConsent, setConsent } from '../../lib/consent';

/**
 * WAVE SEVEN, row S: THE CONSENT ASK IS A FOOTER ROW, NEVER A BANNER.
 *
 * It was a fixed, z-[120] strip across the bottom of every first visit, over
 * whatever the visitor was reading, and it printed the storage key it writes to
 * for people who have no reason to know what a storage key is. Same shape as
 * the install offer (element E): one line in the venue's voice, two words for
 * the choice, sitting in the footer's flow where a visitor finds it.
 *
 * NOTHING ABOUT CONSENT ITSELF CHANGES (R046 / H-1). Telemetry stays
 * fail-closed: analytics.ts and errorReporting.ts send nothing while
 * getConsent() is 'pending', so a visitor who never reaches the footer is a
 * visitor who never opted in. The row renders only while the answer is pending
 * and goes the moment one is given.
 *
 * A11Y-R13 still holds: this is not a dialog and never claims to be. It is a
 * group named by its own sentence, so a screen reader hears what "Yes" answers.
 */
const SHADOW = { textShadow: '0 1px 6px rgba(0,0,0,0.95)' } as const;
const CHOICE =
  'min-h-[44px] min-w-[44px] px-2 text-[12px] text-white underline underline-offset-4 decoration-white/30 hover:decoration-white transition-colors';

export function ConsentRow() {
  // Decided during state init, no effect needed (R007 Pattern B).
  const [pending, setPending] = useState(() => {
    try {
      return getConsent() === 'pending';
    } catch {
      return false;
    }
  });

  if (!pending) return null;

  const answer = (state: 'granted' | 'denied') => {
    setConsent(state);
    setPending(false);
  };

  return (
    <div
      role="group"
      aria-labelledby="consent-row-line"
      className="flex flex-wrap items-center justify-center md:justify-start gap-x-3 pt-3"
    >
      <span id="consent-row-line" className="text-white/80 text-[12px]" style={SHADOW}>
        Analytics are anonymous and off until you say yes.
      </span>
      <span className="flex items-center gap-1">
        <button type="button" onClick={() => answer('granted')} className={CHOICE} style={SHADOW}>
          Yes
        </button>
        <button type="button" onClick={() => answer('denied')} className={CHOICE} style={SHADOW}>
          No
        </button>
      </span>
    </div>
  );
}

export default ConsentRow;
