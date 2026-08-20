// Referral link construction.
//
// Two shapes, and the difference is not cosmetic:
//
//   /?ref=0xabc…    self-contained. Resolves with no server, no database, no
//                   migration. Works on a deployment where the code store does
//                   not exist. This is the DEFAULT and the fallback.
//
//   /?r=t3g1d       short. Requires api/_lib/referrals.js AND an applied
//                   migration to resolve. Nicer to paste; strictly weaker,
//                   because it can 404 into "we could not tell who referred
//                   you" on a link that already went out.
//
// A code that cannot be resolved must never silently degrade to no-attribution
// without the visitor being told, which is why `?r=` capture is a distinct
// outcome in attribution.ts and not a quiet no-op.

import { isAddress } from 'viem';
import { SITE_URL } from '../constants';
import { REF_PARAM, REF_CODE_PARAM, REF_CODE_RE } from './attribution';

/** Host without scheme, for truncated display. Derived once. */
export const SITE_HOST = SITE_URL.replace(/^https?:\/\//, '');

/**
 * The always-works link for a referrer address.
 *
 * Lands on `/` rather than a deep route on purpose: the capture that already
 * exists in the app runs on HomePage, and a link into a route that does not
 * capture would be a link that quietly loses its own attribution.
 */
export function referralLinkForAddress(address: string): string {
  if (!isAddress(address)) {
    throw new Error('referralLinkForAddress requires a 20-byte hex address');
  }
  return `${SITE_URL}/?${REF_PARAM}=${encodeURIComponent(address)}`;
}

/** The short link for a minted code. Only valid once the code store answers. */
export function referralLinkForCode(code: string): string {
  const normalised = code.trim().toLowerCase();
  if (!REF_CODE_RE.test(normalised)) {
    throw new Error('referralLinkForCode requires a 4-12 character lowercase alphanumeric code');
  }
  return `${SITE_URL}/?${REF_CODE_PARAM}=${normalised}`;
}

/** `memetic.fun/?ref=0xabcd…1234` — for display in a fixed-width field. */
export function truncatedLinkLabel(address: string): string {
  return `${SITE_HOST}/?${REF_PARAM}=${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Share text for a referral link.
 *
 * HONESTY, carried over from ReferralWidget.tsx's 2026-07-24 correction and
 * restated because this is now the module that generates it: ReferralSplitter
 * pays the REFERRER a carve of the referee's swap fee. The person clicking the
 * link receives nothing extra — no discount, no bonus, no rebate. Any copy here
 * that implies a joiner-side benefit is false about the deployed contract.
 */
export const SHARE_TEXT = "I'm farming on @TegridyFarms \u{1F33F} join me with my referral link";

export function tweetIntentUrl(link: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(link)}`;
}
