// What may and may not end up in a handoff URL.
//
// A query string is logged by every hop it crosses, so the contents of these URLs are the
// venue's privacy boundary, not a formatting detail. The pins:
//   1. Only the destination address and the asset travel. No personal data, ever — the
//      builder takes no parameter that could carry any, and this file asserts the whole
//      parameter set rather than spot-checking, so a future addition fails here.
//   2. A bad address yields NO URL. A widget opened without a destination lets someone buy
//      crypto into the partner's holding account with nowhere to send it.
//   3. `isPermittedOnrampUrl` is applied to the SIGNER'S answer as well, so it is pinned
//      against the host-confusion tricks a URL parser is prone to.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onrampStatus, type ConfiguredOnrampProvider } from './config';
import {
  buildOnrampUrl,
  isPermittedOnrampUrl,
  isValidOnrampAddress,
  requiresSignature,
} from './widgetUrl';

const EVM = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
const SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function providers(): { transak: ConfiguredOnrampProvider; moonpay: ConfiguredOnrampProvider } {
  vi.stubEnv('VITE_ONRAMP_TRANSAK_KEY', 'transak-key');
  vi.stubEnv('VITE_ONRAMP_TRANSAK_ENV', 'PRODUCTION');
  vi.stubEnv('VITE_ONRAMP_MOONPAY_KEY', 'pk_live_moonkey');
  vi.stubEnv('VITE_ONRAMP_MOONPAY_SIGN_URL', '/api/aggregator?resource=ramp-sign');
  const list = onrampStatus().providers;
  const transak = list.find((p) => p.id === 'transak');
  const moonpay = list.find((p) => p.id === 'moonpay');
  if (!transak || !moonpay) throw new Error('fixture did not configure both providers');
  return { transak, moonpay };
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('address validation gates the whole builder', () => {
  it('accepts a well-formed address on its own chain only', () => {
    expect(isValidOnrampAddress(EVM, 'ethereum')).toBe(true);
    expect(isValidOnrampAddress(EVM, 'solana')).toBe(false);
    expect(isValidOnrampAddress(SOL, 'solana')).toBe(true);
    expect(isValidOnrampAddress(SOL, 'ethereum')).toBe(false);
  });

  it('builds no URL at all for an unusable address', () => {
    const { transak } = providers();
    for (const bad of ['', '   ', '0xnothex', EVM.slice(0, -1), 'not-an-address']) {
      expect(buildOnrampUrl({ provider: transak, chain: 'ethereum', walletAddress: bad })).toBeNull();
    }
  });

  it('refuses to send an EVM address to a Solana purchase', () => {
    const { transak } = providers();
    expect(buildOnrampUrl({ provider: transak, chain: 'solana', walletAddress: EVM })).toBeNull();
  });
});

describe('only the destination and the asset travel in the URL', () => {
  it('sends exactly the Transak parameter set and nothing else', () => {
    const { transak } = providers();
    const url = new URL(buildOnrampUrl({ provider: transak, chain: 'ethereum', walletAddress: EVM })!);
    expect(url.origin).toBe('https://global.transak.com');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'apiKey', 'cryptoCurrencyCode', 'environment', 'network', 'walletAddress',
    ]);
    expect(url.searchParams.get('walletAddress')).toBe(EVM);
    expect(url.searchParams.get('cryptoCurrencyCode')).toBe('ETH');
    expect(url.searchParams.get('network')).toBe('ethereum');
  });

  it('sends exactly the MoonPay parameter set and nothing else', () => {
    const { moonpay } = providers();
    const url = new URL(buildOnrampUrl({ provider: moonpay, chain: 'ethereum', walletAddress: EVM })!);
    expect(url.origin).toBe('https://buy.moonpay.com');
    expect([...url.searchParams.keys()].sort()).toEqual(['apiKey', 'currencyCode', 'walletAddress']);
    expect(url.searchParams.get('currencyCode')).toBe('eth');
  });

  it('carries no field that could be personal data, on either partner', () => {
    const { transak, moonpay } = providers();
    const forbidden = ['email', 'userEmail', 'firstName', 'lastName', 'phone', 'phoneNumber', 'dob', 'country', 'externalCustomerId'];
    for (const provider of [transak, moonpay]) {
      const url = new URL(buildOnrampUrl({ provider, chain: 'ethereum', walletAddress: EVM })!);
      for (const key of forbidden) expect(url.searchParams.has(key)).toBe(false);
    }
  });

  it('carries the Solana asset when the address is a Solana one', () => {
    const { transak } = providers();
    const url = new URL(buildOnrampUrl({ provider: transak, chain: 'solana', walletAddress: SOL })!);
    expect(url.searchParams.get('cryptoCurrencyCode')).toBe('SOL');
    expect(url.searchParams.get('network')).toBe('solana');
    expect(url.searchParams.get('walletAddress')).toBe(SOL);
  });
});

describe('signing is a property of the partner, not of the deployment', () => {
  it('marks MoonPay as needing a signature and Transak as not', () => {
    const { transak, moonpay } = providers();
    expect(requiresSignature(moonpay)).toBe(true);
    expect(requiresSignature(transak)).toBe(false);
  });
});

describe('a signer may append a signature, never choose a destination', () => {
  it('permits the partner origin over https', () => {
    const { moonpay } = providers();
    expect(isPermittedOnrampUrl('https://buy.moonpay.com/?apiKey=x&signature=y', moonpay)).toBe(true);
  });

  const rejected = [
    'http://buy.moonpay.com/?apiKey=x',
    'https://buy.moonpay.com.attacker.example/?apiKey=x',
    'https://attacker.example/?host=buy.moonpay.com',
    'https://global.transak.com/?apiKey=x',
    'javascript:alert(1)',
    '/relative/path',
    '',
  ];
  for (const url of rejected) {
    it(`refuses ${url || '(empty)'}`, () => {
      const { moonpay } = providers();
      expect(isPermittedOnrampUrl(url, moonpay)).toBe(false);
    });
  }

  it('accepts each partner only for itself', () => {
    const { transak, moonpay } = providers();
    expect(isPermittedOnrampUrl('https://global.transak.com/?a=1', transak)).toBe(true);
    expect(isPermittedOnrampUrl('https://buy.moonpay.com/?a=1', transak)).toBe(false);
    expect(isPermittedOnrampUrl('https://global.transak.com/?a=1', moonpay)).toBe(false);
  });
});
