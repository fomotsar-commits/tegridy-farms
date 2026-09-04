// Turning one island-tape fill into one sized mirror — or into a refusal that
// says why, on its own row.
//
// THIS MODULE PLANS. IT DOES NOT EXECUTE, AND NOTHING ELSE HERE DOES EITHER.
// The venue runs no keeper: there is no cron, no worker and no serverless
// function that watches an address, so a leader's fill cannot cause a follower's
// trade. Every mirror is placed by the reader, in their own wallet, after
// reading the plan. `MIRROR_EXECUTION` (mirror.ts) states that in one sentence
// and every surface renders it verbatim, because "copy trading" is a phrase that
// implies an automaton and this build does not have one.
//
// ─── A PLAN IS SIZED FROM A VERIFIED QUOTE LEG OR NOT AT ALL ─────────────────
//
// A tape fill can fail to be copyable in six different ways and each one is a
// DIFFERENT sentence, because collapsing them into "no plan" hides which of them
// is happening. In particular:
//
//   * a SELL by the followed address is not a missing buy. It is information —
//     they left — and it gets a row saying so. What it does not get is a size:
//     how much of your own position to sell is a decision about YOUR position,
//     which this module knows nothing about.
//   * an UNCLASSIFIED fill is not a small fill. Upstream did not give both token
//     addresses, or the pair is not this pool's pair, so nobody here knows which
//     way it went. Sizing it would be a guess wearing a number.
//
// Refusals are returned, never filtered. A queue that showed only the actionable
// fills would present a leader as a stream of clean opportunities while hiding
// that most of what they did could not be copied at all — the single most
// flattering thing a copy-trading surface can do to a leader.

import { MAX_SIGNAL_AGE_SECONDS, type MirrorRefusal } from './mirror';
import type { FollowConfig } from './follows';
import { findQuoteToken, parseQuoteAmount, truncateToDecimals } from './quoteTokens';
import type { IslandPool, IslandTape, PoolFamily, TapeFill } from './tape';

export type TapeMirrorRefusal =
  | MirrorRefusal
  /** The followed address SOLD. Shown, never sized. */
  | 'exit-signal'
  /** Upstream did not say which way this fill went. */
  | 'unclassified-fill'
  /** No quote-side amount came back, so there is nothing to size against a cap. */
  | 'unpriced-leg'
  /** The row has no usable sender, so it cannot be attributed to anyone. */
  | 'unknown-sender'
  /** The row's transaction hash is not one, so the mirror could not be logged against it. */
  | 'unlinkable-fill';

export const TAPE_MIRROR_REFUSAL_TEXT: Record<TapeMirrorRefusal, string> = {
  'not-this-leader': 'This fill was not sent by the followed address.',
  'quote-token-mismatch':
    'This pool is quoted in a different token from the one this follow caps. WETH on Ethereum, WETH on Base and SOL are three different assets, and converting between them would need a price this page does not have.',
  'stale-signal':
    'This fill is older than the signal window. Copying it now would be a different trade at a different price, not a mirror.',
  'unusable-timestamp':
    'This row is timestamped ahead of the current clock, so its age cannot be stated and no plan is offered.',
  'zero-input': 'The quote-side amount on this fill is zero, so there is nothing to size a mirror against.',
  'exit-signal':
    'The followed address SOLD here. A cap can size a buy; how much of your own position to sell is yours to decide, so no size is proposed — this row exists so you know they left.',
  'unclassified-fill':
    'GeckoTerminal did not return both token addresses for this fill, or they do not match this pool’s pair, so it cannot be called a buy or a sell.',
  'unpriced-leg': 'No quote-side amount came back for this fill, so nothing can be sized against your cap.',
  'unknown-sender':
    'This fill has no usable sender address upstream, so it cannot be attributed to the followed address.',
  'unlinkable-fill':
    'This fill’s transaction reference is not a hash this app will link or record, so a mirror of it could not be logged against anything checkable.',
};

export interface TapeMirrorPlan {
  venue: PoolFamily;
  pool: IslandPool;
  leader: string;
  /** The leader fill's transaction hash — the dedupe key for a confirmed intent. */
  leaderTxHash: string;
  /** Always equal to the follow's `quoteToken`; a plan exists only when they match. */
  tokenIn: string;
  tokenOut: string;
  /** The leader's quote-side amount, in `tokenIn`'s smallest unit. */
  leaderAmountIn: bigint;
  /** What the follower would spend: `min(leaderAmountIn, cap)`. */
  notionalWei: bigint;
  /** True when the cap, not the leader, decided the size. */
  capped: boolean;
  slippageBps: number;
  /** Seconds between the leader's fill and now. The number you are buying late by. */
  signalAgeSeconds: number;
  leaderTimestamp: number;
  /**
   * Never computed here. A minimum-out is a function of a CURRENT quote, and the
   * only price this module can see belongs to a fill that already happened.
   */
  minOut: null;
  minOutReason: string;
}

export type TapeMirrorOutcome =
  | { ok: true; plan: TapeMirrorPlan }
  | { ok: false; reason: TapeMirrorRefusal };

const MIN_OUT_REASON =
  'No minimum-out is set here. The slippage guard is applied to a live quote when you confirm, because a bound derived from the leader’s past fill would protect a price that is already gone.';

/**
 * Size one mirror from one tape fill, or refuse.
 *
 * Pure, and `now` is a parameter for that reason: the refusal that matters most
 * (`stale-signal`) is a function of the clock, and a clock read inside this
 * function would make the one honesty rule here untestable.
 */
export function planTapeMirror(fill: TapeFill, follow: FollowConfig, now: number): TapeMirrorOutcome {
  // Attribution first. Everything below is a statement about a specific address,
  // and there is no point sizing a trade for a row that names nobody.
  if (fill.wallet === null) return { ok: false, reason: 'unknown-sender' };
  if (fill.wallet !== follow.leader) return { ok: false, reason: 'not-this-leader' };

  // A follow's cap is denominated in ONE token on ONE chain. Both halves matter:
  // an EVM cap cannot size a Solana fill, and a mainnet-WETH cap cannot size a
  // Base fill even though the symbol matches.
  if (follow.venue !== fill.pool.family) return { ok: false, reason: 'quote-token-mismatch' };
  if (fill.pool.quoteToken === null || follow.quoteToken !== fill.pool.quoteToken) {
    return { ok: false, reason: 'quote-token-mismatch' };
  }

  if (fill.side === 'unclassified') return { ok: false, reason: 'unclassified-fill' };
  if (fill.side === 'sell') return { ok: false, reason: 'exit-signal' };
  if (fill.quoteAmount === null) return { ok: false, reason: 'unpriced-leg' };
  if (fill.txHash === null) return { ok: false, reason: 'unlinkable-fill' };

  if (!Number.isFinite(fill.at) || fill.at > now) return { ok: false, reason: 'unusable-timestamp' };
  const signalAgeSeconds = now - fill.at;
  if (signalAgeSeconds > MAX_SIGNAL_AGE_SECONDS) return { ok: false, reason: 'stale-signal' };

  const token = findQuoteToken(follow.quoteToken);
  if (!token) return { ok: false, reason: 'quote-token-mismatch' };

  // The upstream leg can carry more precision than the token has. Truncating
  // (never rounding) keeps the derived size at or below the leg it came from;
  // parseQuoteAmount stays strict, so anything that is not a plain decimal is
  // still refused rather than coerced.
  const leaderAmountIn = parseQuoteAmount(truncateToDecimals(fill.quoteAmount, token.decimals), token.address);
  if (leaderAmountIn === null) return { ok: false, reason: 'unpriced-leg' };
  if (leaderAmountIn <= 0n) return { ok: false, reason: 'zero-input' };

  const capped = leaderAmountIn > follow.maxNotionalWei;
  return {
    ok: true,
    plan: {
      venue: follow.venue,
      pool: fill.pool,
      leader: follow.leader,
      leaderTxHash: fill.txHash,
      tokenIn: follow.quoteToken,
      tokenOut: fill.pool.baseToken,
      leaderAmountIn,
      notionalWei: capped ? follow.maxNotionalWei : leaderAmountIn,
      capped,
      slippageBps: follow.slippageBps,
      signalAgeSeconds,
      leaderTimestamp: fill.at,
      minOut: null,
      minOutReason: MIN_OUT_REASON,
    },
  };
}

export interface TapeMirrorCandidate {
  fill: TapeFill;
  follow: FollowConfig;
  outcome: TapeMirrorOutcome;
  /** Stable list key: one fill can be a candidate for more than one follow. */
  key: string;
}

/**
 * Every fill by a followed address, each carrying its plan or its refusal.
 *
 * The pre-filter is deliberately only "same address": every OTHER reason a fill
 * cannot be copied has to survive as a visible row, because the ratio of
 * copyable to refused is the single most useful thing on the page.
 */
export function planTapeMirrors(
  tape: IslandTape,
  follows: readonly FollowConfig[],
  now: number,
): TapeMirrorCandidate[] {
  const out: TapeMirrorCandidate[] = [];
  for (const read of tape.reads) {
    if (read.status !== 'read') continue;
    // The row's position inside its own pool read is part of the key. A single
    // transaction can produce more than one fill in one pool (a batched or
    // multi-hop router call), so a hash alone is not unique — and a duplicate
    // React key silently drops rows from the queue.
    for (let i = 0; i < read.fills.length; i++) {
      const fill = read.fills[i]!;
      if (fill.wallet === null) continue;
      for (const follow of follows) {
        if (fill.wallet !== follow.leader) continue;
        out.push({
          fill,
          follow,
          outcome: planTapeMirror(fill, follow, now),
          key: `${follow.leader}:${follow.quoteToken}:${read.pool.network}:${read.pool.pool}:${i}`,
        });
      }
    }
  }
  return out.sort((a, b) => b.fill.at - a.fill.at);
}
