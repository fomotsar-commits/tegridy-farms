// The Solana swap page's words for a trade in one of our pools, kept out of the
// components so a test reads the same strings the page renders.

import { chargedCreatorFeeRate, feeSplit } from '../../lib/solana/cpswap/venue';
import { feeRateText } from '../../lib/solana/lp/format';
import type { OwnCandidate } from '../../lib/solana/swap/ownPools';

/** What a trade in one of our pools says when it stops before the wallet is asked. */
export const OWN_SWAP_COPY = {
  poolGone: 'Our pool can no longer take this trade as it stands. Nothing was sent; both quotes are being read again.',
  unread: 'Our pools could not be read just now, so this trade was not checked against them. Nothing was sent. Try again in a moment.',
  jupiterAhead: 'Jupiter pays more for this trade now. Its new quote is on screen; nothing was sent. Press Buy again to swap through Jupiter.',
  inFlow: 'This trade goes to our pool. What your wallet would sign is the review below, and nothing is sent until you sign it.',
  cannotCheck: "This page could not load what checks it, so look it up in your wallet's activity, then press I checked my wallet.",
  jupiterNow: 'Jupiter now pays more for this trade, so nothing was signed. Both quotes are being read again.',
  unchecked: (detail: string) => `${detail}, so this trade could not be checked against it. Nothing was sent. Try again in a moment.`,
  refused: 'the last try in our pool was refused for this wallet',
  pendingLead: 'Sent, not confirmed yet. Buy stays off until it is checked: it may still go through, and sending it again could make you pay twice.',
} as const;

/** Our pool's fees, as the quote already holds them: none is added on top of what you pay. */
export function ownFeeText(c: OwnCandidate): string {
  const config = c.view.config;
  if (!config) return 'None on top. This pool’s fee settings could not be read.';
  const split = feeSplit(config);
  const pct = (n: number) => `${Number(n.toFixed(4))}%`;
  const creator = chargedCreatorFeeRate(config, c.view.snapshot.pool.enableCreatorFee);
  const also = creator > 0n ? `, and a ${feeRateText(creator)} creator fee` : '';
  return `None on top. Inside the quote: this pool’s ${feeRateText(config.tradeFeeRate)} trade fee, ${pct(split.venueTakesPct)} to the venue and ${pct(split.lpKeepsPct)} to its liquidity providers${also}.`;
}

/** Where our pool's trade goes: the pool's short address and its fee tier. */
export function ownRouteText(c: OwnCandidate): string {
  const a = c.view.address;
  const tier = c.view.config ? `, fee tier ${c.view.config.index}` : '';
  return `our pool ${a.slice(0, 4)}…${a.slice(-4)}${tier}`;
}
