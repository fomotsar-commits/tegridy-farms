// Consent gate for analytics + error reporting (R046 / agent 066 finding H-1).
// GDPR/ePrivacy: deny-by-default. NO telemetry fires until the user explicitly
// opts in via the ConsentBanner. Choice is persisted in localStorage so we
// don't re-prompt on every visit.

const STORAGE_KEY = 'tegridy_telemetry_consent';

export type ConsentState = 'granted' | 'denied' | 'pending';

/**
 * Read the user's current telemetry consent.
 *
 * Returns 'pending' on first visit (banner should show), 'granted' / 'denied'
 * after the user has made a choice. Defensive against environments where
 * localStorage is unavailable (privacy mode, SSR) — those return 'pending'
 * which means deny-by-default for the gate callers.
 */
export function getConsent(): ConsentState {
  try {
    if (typeof localStorage === 'undefined') return 'pending';
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'granted' || v === 'denied') return v;
    return 'pending';
  } catch {
    return 'pending';
  }
}

/** Persist the user's consent choice. Triggers a window event so live modules can react. */
export function setConsent(state: 'granted' | 'denied'): void {
  try {
    localStorage.setItem(STORAGE_KEY, state);
  } catch {
    // localStorage unavailable — choice won't persist but session will honour it
  }
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('tegridy:consent-changed', { detail: state }));
    } catch {
      // CustomEvent may be unavailable in non-browser contexts
    }
  }
}

/** True only when the user has affirmatively granted consent. */
export function hasConsent(): boolean {
  return getConsent() === 'granted';
}
