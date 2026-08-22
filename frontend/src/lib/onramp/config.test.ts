// The on-ramp config's acceptance list.
//
// Four properties carry real money and are pinned hardest:
//   1. OFF is the default, and leaving it takes every key of a provider — a partial set is
//      unconfigured, because the alternative is a payment form that dies mid-checkout.
//   2. The unconfigured state is DESCRIBED, not silent. An empty `unconfigured` list would
//      make "off on purpose" and "the panel broke" render identically.
//   3. A secret key pasted into a client variable is refused. `VITE_` is inlined into the
//      public bundle; accepting `sk_…` there would be the venue publishing it and then
//      behaving as though nothing happened.
//   4. The signing endpoint is same-origin only. It receives the user's wallet address.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ONRAMP_PROVIDERS,
  ONRAMP_PROVIDER_ORDER,
  isOnrampConfigured,
  onrampStatus,
} from './config';

const TRANSAK_KEY = '4fcd6904-706b-4aff-bd9d-77422813bbb7';
const MOONPAY_KEY = 'pk_live_abc123DEF456';
const SIGN_PATH = '/api/aggregator?resource=ramp-sign';

function configureTransak() {
  vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', TRANSAK_KEY);
  vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'PRODUCTION');
}

function configureMoonPay() {
  vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', MOONPAY_KEY);
  vi.stubEnv('VITE_ONRAMP_MOONPAY_SIGN_URL', SIGN_PATH);
}

function missingFor(id: string) {
  return onrampStatus().unconfigured.find((u) => u.id === id)?.missing ?? [];
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('the on-ramp is off until an operator turns it on', () => {
  it('reports no providers with nothing configured', () => {
    expect(onrampStatus().providers).toEqual([]);
    expect(isOnrampConfigured()).toBe(false);
  });

  it('names every provider and every missing key rather than going silent', () => {
    const { unconfigured } = onrampStatus();
    expect(unconfigured.map((u) => u.id).sort()).toEqual([...ONRAMP_PROVIDER_ORDER].sort());
    for (const entry of unconfigured) {
      expect(entry.missing.length, `${entry.id} listed as unconfigured with no reason`).toBeGreaterThan(0);
      expect(entry.signupUrl).toMatch(/^https:\/\//);
    }
  });

  it('every listed missing key is one the provider actually declares', () => {
    for (const entry of onrampStatus().unconfigured) {
      const declared = ONRAMP_PROVIDERS[entry.id].requiredKeys;
      for (const key of entry.missing) expect(declared).toContain(key);
    }
  });
});

describe('a half-configured provider is unconfigured, not "mostly working"', () => {
  it('refuses Transak with a key but no declared environment', () => {
    vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', TRANSAK_KEY);
    expect(onrampStatus().providers).toEqual([]);
    expect(missingFor('transak')).toEqual(['VITE_ONRAMP_TRANSAK_ENV']);
  });

  it('refuses Transak with an environment but no key', () => {
    vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'STAGING');
    expect(missingFor('transak')).toEqual(['VITE_ONRAMP_TRANSAK_KEY']);
  });

  it('refuses an environment value it does not recognise instead of guessing one', () => {
    vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', TRANSAK_KEY);
    vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'prod');
    expect(missingFor('transak')).toEqual(['VITE_ONRAMP_TRANSAK_ENV']);
  });

  it('refuses MoonPay without a signing endpoint — an unsigned live URL is a broken widget', () => {
    vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', MOONPAY_KEY);
    expect(onrampStatus().providers).toEqual([]);
    expect(missingFor('moonpay')).toEqual(['VITE_ONRAMP_MOONPAY_SIGN_URL']);
  });
});

describe('key shape', () => {
  it('refuses a MoonPay SECRET key handed to the client variable', () => {
    vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', 'sk_live_abc123DEF456');
    vi.stubEnv('VITE_ONRAMP_MOONPAY_SIGN_URL', SIGN_PATH);
    expect(missingFor('moonpay')).toEqual(['VITE_ONRAMP_MOONPAY_KEY']);
  });

  it('accepts a test publishable key', () => {
    vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', 'pk_test_abc123');
    vi.stubEnv('VITE_ONRAMP_MOONPAY_SIGN_URL', SIGN_PATH);
    expect(onrampStatus().providers.map((p) => p.id)).toEqual(['moonpay']);
  });

  it('refuses a key carrying whitespace rather than silently repairing the paste', () => {
    vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', 'abc def');
    vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'PRODUCTION');
    expect(missingFor('transak')).toEqual(['VITE_ONRAMP_TRANSAK_KEY']);
  });

  it('trims a key that is only surrounded by whitespace', () => {
    vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', `  ${TRANSAK_KEY}  `);
    vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', ' production ');
    const [provider] = onrampStatus().providers;
    expect(provider).toMatchObject({ id: 'transak', apiKey: TRANSAK_KEY, environment: 'PRODUCTION' });
  });
});

describe('the signing endpoint may only be our own origin', () => {
  const rejected = [
    'https://attacker.example/sign',
    'http://localhost/sign',
    '//attacker.example/sign',
    'api/aggregator?resource=ramp-sign',
    'javascript:alert(1)',
  ];

  for (const value of rejected) {
    it(`refuses ${value}`, () => {
      vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', MOONPAY_KEY);
      vi.stubEnv('VITE_ONRAMP_MOONPAY_SIGN_URL', value);
      expect(missingFor('moonpay')).toEqual(['VITE_ONRAMP_MOONPAY_SIGN_URL']);
    });
  }

  it('accepts a same-origin path', () => {
    configureMoonPay();
    const provider = onrampStatus().providers.find((p) => p.id === 'moonpay');
    expect(provider).toMatchObject({ id: 'moonpay', signUrl: SIGN_PATH });
  });
});

describe('a fully configured venue', () => {
  it('offers both partners in a stable order and reports nothing outstanding', () => {
    configureTransak();
    configureMoonPay();
    const status = onrampStatus();
    expect(status.providers.map((p) => p.id)).toEqual([...ONRAMP_PROVIDER_ORDER]);
    expect(status.unconfigured).toEqual([]);
    expect(isOnrampConfigured()).toBe(true);
  });

  it('never lists a provider as both usable and outstanding', () => {
    configureTransak();
    const status = onrampStatus();
    const usable = new Set(status.providers.map((p) => p.id));
    for (const entry of status.unconfigured) expect(usable.has(entry.id)).toBe(false);
  });
});

describe('provider descriptors are code, not config', () => {
  it('pins each partner to one https origin', () => {
    for (const id of ONRAMP_PROVIDER_ORDER) {
      const url = new URL(ONRAMP_PROVIDERS[id].origin);
      expect(url.protocol).toBe('https:');
      expect(url.search).toBe('');
    }
  });
});
