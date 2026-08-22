// Handoff URL construction for the fiat on-ramp. Pure — no network, no wallet, no clock.
//
// THE HANDOFF IS A NEW TAB, NOT AN IFRAME. Two reasons, both load-bearing:
//   1. Embedding would need `frame-src https://global.transak.com https://buy.moonpay.com`
//      in the CSP (frontend/vercel.json). Until that header actually ships, an embedded
//      widget renders as a blocked frame — a broken surface, which is the one outcome the
//      unconfigured path exists to avoid. A top-level tab needs no CSP change at all.
//   2. The partner collects card and identity data on their own origin, under their own
//      licence. A top-level navigation makes that boundary visible in the address bar
//      instead of hiding a payment form inside our chrome.
//
// WHAT MAY BE PUT IN A URL: the destination wallet address and the asset. Nothing else.
// No email, no name, no country, no referrer id derived from a session. A query string is
// logged by every hop it crosses, so this module is the enforcement point for that rule —
// `buildOnrampUrl` takes no parameter that could carry personal data, and none may be added.

import type { ConfiguredOnrampProvider } from './config';

/** Chains the venue can honestly hand off for — the two it actually trades on. */
export type OnrampChain = 'ethereum' | 'solana';

/** Matches the validation used by heatClient/middleware, so a bad address never leaves the browser. */
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidOnrampAddress(address: string, chain: OnrampChain): boolean {
  const a = address.trim();
  return chain === 'ethereum' ? ETH_ADDRESS_RE.test(a) : SOLANA_ADDRESS_RE.test(a);
}

interface AssetCodes {
  /** MoonPay `currencyCode` — lower case by their convention. */
  moonpay: string;
  /** Transak `cryptoCurrencyCode` + `network`. */
  transakCurrency: string;
  transakNetwork: string;
}

const ASSETS: Record<OnrampChain, AssetCodes> = {
  ethereum: { moonpay: 'eth', transakCurrency: 'ETH', transakNetwork: 'ethereum' },
  solana: { moonpay: 'sol', transakCurrency: 'SOL', transakNetwork: 'solana' },
};

export interface OnrampRequest {
  provider: ConfiguredOnrampProvider;
  chain: OnrampChain;
  /** The user's own receiving address. The only user-specific value in the URL. */
  walletAddress: string;
}

/**
 * The URL for one handoff, or null when the request cannot be honestly built.
 *
 * Null rather than a partial URL on a bad address: a widget opened without a destination
 * lets a user buy crypto into the provider's holding account and then discover there is
 * nowhere to send it. Callers must render the reason, not the link.
 *
 * For MoonPay this is the UNSIGNED url. MoonPay rejects it in live mode; it is the input
 * to the signing endpoint, never something to open directly. `requiresSignature` says so.
 */
export function buildOnrampUrl(req: OnrampRequest): string | null {
  const address = req.walletAddress.trim();
  if (!isValidOnrampAddress(address, req.chain)) return null;
  const asset = ASSETS[req.chain];

  if (req.provider.id === 'transak') {
    const url = new URL(req.provider.descriptor.origin);
    url.searchParams.set('apiKey', req.provider.apiKey);
    url.searchParams.set('environment', req.provider.environment);
    url.searchParams.set('walletAddress', address);
    url.searchParams.set('cryptoCurrencyCode', asset.transakCurrency);
    url.searchParams.set('network', asset.transakNetwork);
    // The venue does not choose the user's fiat currency or payment method — the partner
    // decides both from the user's own jurisdiction, which is the only party licensed to.
    return url.toString();
  }

  const url = new URL(req.provider.descriptor.origin);
  url.searchParams.set('apiKey', req.provider.apiKey);
  url.searchParams.set('walletAddress', address);
  url.searchParams.set('currencyCode', asset.moonpay);
  return url.toString();
}

/** True when the built URL must be signed server-side before it may be opened. */
export function requiresSignature(provider: ConfiguredOnrampProvider): boolean {
  return provider.id === 'moonpay';
}

/**
 * Whether a URL may be opened as this provider's handoff.
 *
 * Applied to the SIGNER'S ANSWER as well as to locally-built URLs. The signing endpoint is
 * trusted to append a signature, not to choose a destination: a misconfigured or
 * compromised signer that returned some other host would otherwise send a user who is
 * about to type a card number to whatever it named.
 */
export function isPermittedOnrampUrl(url: string, provider: ConfiguredOnrampProvider): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const expected = new URL(provider.descriptor.origin);
  return parsed.protocol === 'https:' && parsed.host === expected.host;
}
