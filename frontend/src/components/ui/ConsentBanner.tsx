import { useState, useEffect } from 'react';
import { getConsent, setConsent } from '../../lib/consent';

/**
 * R046 / H-1: GDPR/ePrivacy consent banner.
 *
 * Renders a sticky bottom strip on first visit. Until the user clicks Accept
 * or Decline, no analytics events or error reports fire (the gate lives in
 * `analytics.ts` / `errorReporting.ts`). Choice is persisted in localStorage,
 * so we only show this once per browser.
 *
 * Design follows the existing OnboardingModal palette (rgba navy panel,
 * purple accent for primary action, neutral border for secondary) so it
 * doesn't fight with the current visual identity.
 */
export function ConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (getConsent() === 'pending') setVisible(true);
  }, []);

  if (!visible) return null;

  const accept = () => {
    setConsent('granted');
    setVisible(false);
  };
  const decline = () => {
    setConsent('denied');
    setVisible(false);
  };

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Privacy consent"
      className="fixed left-0 right-0 bottom-0 z-[120] px-4 pb-4 md:pb-6"
      style={{
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
      }}
    >
      <div
        className="mx-auto max-w-3xl rounded-2xl border p-4 md:p-5 shadow-2xl backdrop-blur-md flex flex-col md:flex-row md:items-center gap-3 md:gap-4"
        style={{
          background: 'rgba(13, 21, 48, 0.95)',
          borderColor: 'var(--color-purple-20)',
        }}
      >
        <div className="text-sm text-gray-200 leading-relaxed flex-1">
          <p className="font-semibold text-white mb-1">Privacy &amp; telemetry</p>
          <p className="text-gray-300">
            We use anonymous analytics and error reports to keep Tegridy Farms healthy.
            Nothing is sent until you choose. You can change your mind in your browser&apos;s storage
            (<code className="text-xs px-1 py-0.5 rounded bg-black/40 text-purple-200">tegridy_telemetry_consent</code>).
          </p>
        </div>
        <div className="flex gap-2 shrink-0 justify-end">
          <button
            type="button"
            onClick={decline}
            className="px-4 py-2 text-sm rounded-lg text-gray-300 hover:text-white border border-gray-600 hover:border-gray-400 transition-colors"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={accept}
            className="px-4 py-2 text-sm font-semibold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
