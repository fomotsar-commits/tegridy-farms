// Turning one leader swap into one sized mirror — or into a refusal that says why.
//
// THIS MODULE PLANS. IT DOES NOT EXECUTE, AND NOTHING ELSE HERE DOES EITHER.
// The venue runs no keeper: there is no cron, no worker and no serverless
// function that watches a wallet, so a leader's trade cannot cause a follower's
// trade. Every mirror is placed by the user, in their own wallet, after reading
// the plan. `MIRROR_EXECUTION` states that in one sentence and the surfaces render
// it verbatim, because "copy trading" is a phrase that implies an automaton and
// this build does not have one.
//
// The second thing this module refuses to do is invent a price. Indexed swap rows
// carry `amountIn` in the input token's own smallest unit and nothing else — no
// output amount, no rate, no USD. So a plan can size a trade against a cap
// denominated in the SAME token and can do nothing whatsoever with a leg
// denominated in another. `minOut` is therefore null here and is computed by the
// quoting layer at confirm time against a live quote; a minOut derived from a
// past trade would be a slippage guard aimed at a price that no longer exists.

import type { IndexedSwap } from '../indexer/queries';
import type { FollowConfig } from './follows';

export const MIRROR_EXECUTION =
  'Mirroring is manual. Nothing here watches this wallet or places a trade for you — there is no keeper on this venue, so every mirror is a transaction you review and sign yourself.';

/**
 * How old a leader's swap may be and still be described as a signal, in seconds.
 *
 * This is a bound on how long the plan is willing to stay silent about drift, not
 * a claim that a fresher signal is safe. Fifteen minutes is roughly 75 Ethereum
 * blocks; a price can move arbitrarily far inside it. What the cutoff buys is
 * that the panel never presents an hours-old trade as something a user is about
 * to copy, which is the shape that turns a stale feed into a fabricated
 * opportunity.
 */
export const MAX_SIGNAL_AGE_SECONDS = 900;

export type MirrorRefusal =
  /** The row is not this follow's leader. A guard, not a user-facing case. */
  | 'not-this-leader'
  /** The leader spent a token this follow has no cap denominated in. */
  | 'quote-token-mismatch'
  /** Older than MAX_SIGNAL_AGE_SECONDS. */
  | 'stale-signal'
  /** The row's timestamp is ahead of the clock we were handed. */
  | 'unusable-timestamp'
  /** The leader's own input was zero, so there is nothing to size against. */
  | 'zero-input';

export const MIRROR_REFUSAL_TEXT: Record<MirrorRefusal, string> = {
  'not-this-leader': 'This trade was not made by the followed wallet.',
  'quote-token-mismatch':
    'The leader spent a token this follow does not cap. Converting the cap would need a price the indexer does not store, so no size is proposed.',
  'stale-signal':
    'This trade is older than the signal window. Copying it now would be a different trade at a different price, not a mirror.',
  'unusable-timestamp':
    'This row is timestamped ahead of the current clock, so its age cannot be stated and no plan is offered.',
  'zero-input': 'The leader’s input amount is zero, so there is nothing to size a mirror against.',
};

export interface MirrorPlan {
  leader: string;
  /** Join key back to the indexed row, and the dedupe key for a confirmed intent. */
  leaderTxHash: string;
  /** Always equal to the follow's `quoteToken` — a plan exists only when they match. */
  tokenIn: string;
  tokenOut: string;
  /** What the leader spent, in `tokenIn`'s smallest unit. */
  leaderAmountIn: bigint;
  /** What the follower would spend: `min(leaderAmountIn, cap)`. */
  notionalWei: bigint;
  /** True when the cap, not the leader, decided the size. */
  capped: boolean;
  slippageBps: number;
  /** Seconds between the leader's trade and now. The number the user is buying late by. */
  signalAgeSeconds: number;
  /** Unix seconds of the leader's swap. */
  leaderTimestamp: number;
  /**
   * Never computed here. A minimum-out is a function of a CURRENT quote, and the
   * only price this module can see belongs to a trade that already happened.
   */
  minOut: null;
  minOutReason: string;
}

export type MirrorOutcome =
  | { ok: true; plan: MirrorPlan }
  | { ok: false; reason: MirrorRefusal };

const MIN_OUT_REASON =
  'No minimum-out is set here. The slippage guard is applied to a live quote when you confirm, because a bound derived from the leader’s past fill would protect a price that is already gone.';

/**
 * Size one mirror, or refuse.
 *
 * Pure, and `now` is a parameter for that reason: the refusal that matters most
 * (`stale-signal`) is a function of the clock, and a clock read inside this
 * function would make the one honesty rule here untestable.
 */
export function planMirror(swap: IndexedSwap, follow: FollowConfig, now: number): MirrorOutcome {
  if (swap.user.toLowerCase() !== follow.leader) return { ok: false, reason: 'not-this-leader' };
  if (swap.tokenIn.toLowerCase() !== follow.quoteToken) return { ok: false, reason: 'quote-token-mismatch' };
  if (swap.amountIn <= 0n) return { ok: false, reason: 'zero-input' };

  const timestamp = Number(swap.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > now) return { ok: false, reason: 'unusable-timestamp' };

  const signalAgeSeconds = now - timestamp;
  if (signalAgeSeconds > MAX_SIGNAL_AGE_SECONDS) return { ok: false, reason: 'stale-signal' };

  const capped = swap.amountIn > follow.maxNotionalWei;
  return {
    ok: true,
    plan: {
      leader: follow.leader,
      leaderTxHash: swap.txHash.toLowerCase(),
      tokenIn: follow.quoteToken,
      tokenOut: swap.tokenOut.toLowerCase(),
      leaderAmountIn: swap.amountIn,
      notionalWei: capped ? follow.maxNotionalWei : swap.amountIn,
      capped,
      slippageBps: follow.slippageBps,
      signalAgeSeconds,
      leaderTimestamp: timestamp,
      minOut: null,
      minOutReason: MIN_OUT_REASON,
    },
  };
}

export interface MirrorCandidate {
  swap: IndexedSwap;
  follow: FollowConfig;
  outcome: MirrorOutcome;
}

/**
 * Every followed leader's swaps, each carrying its plan or its refusal.
 *
 * Refusals are RETURNED, not filtered out. A queue that silently drops the
 * stale and mismatched rows shows a short list of clean opportunities and hides
 * that most of what the leader did could not be copied at all — which is the
 * single most flattering thing a copy-trading surface can do to a leader.
 */
export function planMirrors(
  swaps: readonly IndexedSwap[],
  follows: readonly FollowConfig[],
  now: number,
): MirrorCandidate[] {
  const out: MirrorCandidate[] = [];
  for (const swap of swaps) {
    for (const follow of follows) {
      if (swap.user.toLowerCase() !== follow.leader) continue;
      out.push({ swap, follow, outcome: planMirror(swap, follow, now) });
    }
  }
  return out.sort((a, b) => Number(b.swap.timestamp - a.swap.timestamp));
}
