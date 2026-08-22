// Fiat on-ramp configuration — the single place that decides whether the venue has a
// card rail at all, and which licensed partner carries it.
//
// SHIPS OFF. No provider is usable until an operator sets that provider's full key set.
// There is deliberately no fallback key, no shared demo key, and no "staging by default":
// a half-configured provider is UNCONFIGURED here, because the alternative is a widget
// that opens, asks for a card number, and fails after the user has typed it.
//
// Structured like lib/fees/swapFee.ts and heat/heatGateConfig.ts: every value is read
// through a function rather than exported as a constant, so a caller cannot capture one at
// module-init and drift from a redeployed dial, and a nonsense override is IGNORED rather
// than obeyed. `onrampStatus()` returns BOTH the usable providers and the exact missing
// keys for the unusable ones, so the surface can say what is missing instead of going
// blank — an operator staring at an empty panel cannot tell "off on purpose" from "broken".
//
// ── OPERATOR KEYS ───────────────────────────────────────────────────────────────
//  VITE_ONRAMP_TRANSAK_KEY       Transak public API key (partner dashboard).
//  VITE_ONRAMP_TRANSAK_ENV       'PRODUCTION' or 'STAGING'. No default — a production
//                                key handed to the staging host fails at checkout, and
//                                the reverse takes real money in a test account.
//  VITE_ONRAMP_MOONPAY_KEY       MoonPay PUBLISHABLE key (`pk_live_…` / `pk_test_…`).
//                                The secret key is server-side and must never be VITE_-
//                                prefixed — anything VITE_ is inlined into the public bundle.
//  VITE_ONRAMP_MOONPAY_SIGN_URL  Same-origin path of the endpoint that signs the MoonPay
//                                widget URL with the secret key. MoonPay rejects an
//                                unsigned live URL that carries a walletAddress, so
//                                without this the provider is not configured — not
//                                "configured and occasionally failing".
//  VITE_ONRAMP_PARTNER_FEE_BPS   Disclosure mirror of the partner fee set in the provider
//                                dashboard. See partnerFee.ts — it is not a mechanism.
//
// The venue never receives card, bank or identity data: the handoff leaves our origin and
// the licensed partner collects payment details on their own. Nothing here may be extended
// to collect or forward personal data.

/** Providers this venue knows how to hand off to. Closed set — an id is code, not config. */
export type OnrampProviderId = 'transak' | 'moonpay';

export interface OnrampProviderDescriptor {
  id: OnrampProviderId;
  label: string;
  /**
   * The ONLY origin a handoff for this provider may open.
   *
   * A literal, never env-derived, and checked again after a signing round-trip — a signer
   * that answered with some other host would otherwise be able to redirect a funding user
   * anywhere, which is the entire attack this constant exists to close.
   */
  origin: string;
  /** Env keys that must ALL be usable before the provider is offered. */
  requiredKeys: readonly string[];
  /** Where the operator gets them. Rendered on the unconfigured surface. */
  signupUrl: string;
}

export const ONRAMP_PROVIDERS: Record<OnrampProviderId, OnrampProviderDescriptor> = {
  transak: {
    id: 'transak',
    label: 'Transak',
    origin: 'https://global.transak.com',
    requiredKeys: ['VITE_ONRAMP_TRANSAK_KEY', 'VITE_ONRAMP_TRANSAK_ENV'],
    signupUrl: 'https://transak.com/partners',
  },
  moonpay: {
    id: 'moonpay',
    label: 'MoonPay',
    origin: 'https://buy.moonpay.com',
    requiredKeys: ['VITE_ONRAMP_MOONPAY_KEY', 'VITE_ONRAMP_MOONPAY_SIGN_URL'],
    signupUrl: 'https://www.moonpay.com/business',
  },
};

/** Iteration order for the picker. Stable so the default provider does not move per render. */
export const ONRAMP_PROVIDER_ORDER: readonly OnrampProviderId[] = ['transak', 'moonpay'];

export type TransakEnvironment = 'PRODUCTION' | 'STAGING';

interface ConfiguredTransak {
  id: 'transak';
  descriptor: OnrampProviderDescriptor;
  apiKey: string;
  environment: TransakEnvironment;
  /** Transak takes its parameters in the URL; nothing is signed server-side. */
  signUrl: null;
}

interface ConfiguredMoonPay {
  id: 'moonpay';
  descriptor: OnrampProviderDescriptor;
  apiKey: string;
  /** Same-origin path. The widget URL is built here and signed there. */
  signUrl: string;
}

export type ConfiguredOnrampProvider = ConfiguredTransak | ConfiguredMoonPay;

/** One provider the operator has not finished wiring, and precisely what is missing. */
export interface UnconfiguredOnrampProvider {
  id: OnrampProviderId;
  label: string;
  signupUrl: string;
  /** Env keys that are absent or unusable. Never empty for an entry in this list. */
  missing: string[];
}

export interface OnrampStatus {
  /** Usable right now. Empty means the venue has no card rail — say so, do not go blank. */
  providers: ConfiguredOnrampProvider[];
  /** Everything not usable, with the reason. Drives the operator checklist. */
  unconfigured: UnconfiguredOnrampProvider[];
}

/**
 * Trimmed env value, or null.
 *
 * Whitespace and control characters disqualify rather than get stripped: a key that
 * arrived with a stray newline is a key that was pasted wrong, and quietly repairing it
 * would send a mangled credential to a partner and read the rejection as an outage.
 */
function cleanEnv(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  // Printable ASCII only, space excluded. Partner keys are alphanumeric with `_`/`-`;
  // anything else in the value means the paste carried something the operator cannot see.
  if (/[^\x21-\x7e]/.test(t)) return null;
  return t;
}

/**
 * MoonPay publishable keys are `pk_live_…` / `pk_test_…`.
 *
 * The prefix check is not cosmetic: MoonPay's SECRET key is `sk_…`, and an operator who
 * pastes the wrong half into a `VITE_`-prefixed variable has published a secret to every
 * visitor. Refusing the value here does not un-publish it, but it does stop the build from
 * behaving as though the mistake worked.
 */
function moonpayPublishableKey(raw: string | undefined): string | null {
  const t = cleanEnv(raw);
  if (!t) return null;
  if (!/^pk_(live|test)_[A-Za-z0-9]+$/.test(t)) return null;
  return t;
}

/**
 * The signing endpoint, restricted to a SAME-ORIGIN absolute path.
 *
 * An absolute URL is rejected even over https. The request carries the funding user's
 * wallet address, and an env typo pointing it at a third party would be a silent
 * address-exfiltration channel that nothing downstream could detect. Protocol-relative
 * (`//host`) and traversal-prefixed values are rejected for the same reason.
 */
function signingPath(raw: string | undefined): string | null {
  const t = cleanEnv(raw);
  if (!t) return null;
  if (!t.startsWith('/') || t.startsWith('//')) return null;
  return t;
}

function transakEnvironment(raw: string | undefined): TransakEnvironment | null {
  const t = cleanEnv(raw)?.toUpperCase();
  if (t === 'PRODUCTION' || t === 'STAGING') return t;
  return null;
}

/**
 * The venue's current on-ramp configuration. Read it; do not cache it.
 *
 * A provider appears in exactly one of the two lists. Nothing here consults the network,
 * so this answers "is a rail wired" — never "is the partner up". Liveness is the hook's
 * problem and has its own honest failure state.
 */
export function onrampStatus(): OnrampStatus {
  const providers: ConfiguredOnrampProvider[] = [];
  const unconfigured: UnconfiguredOnrampProvider[] = [];

  const env = import.meta.env as Record<string, string | undefined>;

  const transakKey = cleanEnv(env.VITE_ONRAMP_TRANSAK_KEY);
  const transakEnv = transakEnvironment(env.VITE_ONRAMP_TRANSAK_ENV);
  const moonpayKey = moonpayPublishableKey(env.VITE_ONRAMP_MOONPAY_KEY);
  const moonpaySign = signingPath(env.VITE_ONRAMP_MOONPAY_SIGN_URL);

  for (const id of ONRAMP_PROVIDER_ORDER) {
    const descriptor = ONRAMP_PROVIDERS[id];
    if (id === 'transak') {
      const missing: string[] = [];
      if (!transakKey) missing.push('VITE_ONRAMP_TRANSAK_KEY');
      if (!transakEnv) missing.push('VITE_ONRAMP_TRANSAK_ENV');
      if (transakKey && transakEnv) {
        providers.push({ id, descriptor, apiKey: transakKey, environment: transakEnv, signUrl: null });
      } else {
        unconfigured.push({ id, label: descriptor.label, signupUrl: descriptor.signupUrl, missing });
      }
      continue;
    }
    const missing: string[] = [];
    if (!moonpayKey) missing.push('VITE_ONRAMP_MOONPAY_KEY');
    if (!moonpaySign) missing.push('VITE_ONRAMP_MOONPAY_SIGN_URL');
    if (moonpayKey && moonpaySign) {
      providers.push({ id, descriptor, apiKey: moonpayKey, signUrl: moonpaySign });
    } else {
      unconfigured.push({ id, label: descriptor.label, signupUrl: descriptor.signupUrl, missing });
    }
  }

  return { providers, unconfigured };
}

/** True only when at least one partner is fully wired. */
export function isOnrampConfigured(): boolean {
  return onrampStatus().providers.length > 0;
}
