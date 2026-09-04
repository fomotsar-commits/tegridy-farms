// One queue, two sources — the adapter layer.
//
// The island tape and the venue router produce different rows, and MirrorQueue
// renders both through the one shape defined here rather than through two
// components. Everything past this file is identical, so the two sources cannot
// drift into saying the same refusal two different ways.
//
// The refusal is carried as a TAGGED REASON, not as a sentence. MirrorQueue does
// the lookup, which keeps both refusal vocabularies visible in the component the
// honesty guard reads — and means a new refusal added to either source cannot be
// rendered as an empty string by an adapter that forgot it.

import type { MirrorCandidate, MirrorRefusal } from '../../lib/copytrade/mirror';
import type { TapeMirrorCandidate, TapeMirrorRefusal } from '../../lib/copytrade/tapeMirror';
import { formatQuoteAmount } from '../../lib/copytrade/quoteTokens';
import { poolKeyOf, type IslandPool } from '../../lib/copytrade/tape';
import type { MirrorIntent } from '../../lib/copytrade/follows';
import { BUNGALOWS, bungalowTradeRoute } from '../../lib/bungalows';
import { isSolanaSwapLive } from '../../lib/solana';

export interface QueueTradeLink {
  to?: string;
  href?: string;
  label: string;
}

export interface QueuePlanView {
  sizeText: string;
  /** Non-null when the reader's cap, not the leader, decided the size. */
  cappedText: string | null;
  minOutReason: string;
  /** The intent this row would log, or null when there is no address to log it under. */
  intent: MirrorIntent | null;
  /** Why `intent` is null, in one sentence. */
  noIdentityReason: string | null;
  /** Dedupe key against already-logged mirrors. */
  leaderTxHash: string;
  trade: QueueTradeLink | null;
}

export type QueueRefusal =
  | { source: 'router'; reason: MirrorRefusal }
  | { source: 'tape'; reason: TapeMirrorRefusal };

export interface QueueRow {
  key: string;
  leader: string;
  /** Which pool (or which feed) this row came from. */
  sourceLabel: string;
  /** What the address on the row IS — never described as a person. */
  senderLine: string;
  ageSeconds: number;
  plan: QueuePlanView | null;
  refusal: QueueRefusal | null;
}

const SENDER_LINE =
  'This is the address that sent the transaction — not necessarily the party whose position it is.';

const NO_WALLET =
  'Connect a wallet to log this. Without one there is no address to measure a fill against later.';

/** The venue router's own rows. */
export function indexedQueueRows(
  candidates: readonly MirrorCandidate[],
  now: number,
  account: string | null,
): QueueRow[] {
  return candidates.map((c) => ({
    key: `${c.follow.leader}:${c.swap.id}`,
    leader: c.follow.leader,
    sourceLabel: 'Venue router',
    senderLine: 'This is the wallet the venue router recorded as the caller.',
    ageSeconds: now - Number(c.swap.timestamp),
    refusal: c.outcome.ok ? null : { source: 'router', reason: c.outcome.reason },
    plan: c.outcome.ok
      ? {
          sizeText: formatQuoteAmount(c.outcome.plan.notionalWei, c.outcome.plan.tokenIn),
          cappedText: c.outcome.plan.capped
            ? `your cap, not their size (they spent ${formatQuoteAmount(c.outcome.plan.leaderAmountIn, c.outcome.plan.tokenIn)})`
            : null,
          minOutReason: c.outcome.plan.minOutReason,
          leaderTxHash: c.outcome.plan.leaderTxHash,
          trade: { to: '/swap', label: 'Open Trade' },
          intent: account
            ? {
                venue: 'evm',
                leader: c.follow.leader,
                leaderTxHash: c.outcome.plan.leaderTxHash,
                leaderTimestamp: c.outcome.plan.leaderTimestamp,
                confirmedAt: Math.floor(Date.now() / 1000),
                follower: account.toLowerCase(),
                quoteToken: c.outcome.plan.tokenIn,
                tokenOut: c.outcome.plan.tokenOut,
                notionalWei: c.outcome.plan.notionalWei,
                // The router is not a pool on the tape, so this row can never be
                // reconciled there. Null says so instead of naming a pool the
                // fill was not in.
                poolKey: null,
              }
            : null,
          noIdentityReason: account ? null : NO_WALLET,
        }
      : null,
  }));
}

/** Where a reader would actually place this mirror, per the island registry. */
function tradeLinkFor(pool: IslandPool): QueueTradeLink | null {
  const bungalow = BUNGALOWS.find((b) => b.id === pool.bungalowId);
  if (!bungalow) return null;
  const route = bungalowTradeRoute(bungalow, isSolanaSwapLive());
  if (!route) return null;
  if ('to' in route) return { to: route.to, label: `Trade ${bungalow.symbol}` };
  // A Dexscreener page is a CHART, not a swap venue. Calling it "Trade" hands a
  // reader a button that trades nothing.
  return {
    href: route.href,
    label: route.kind === 'swap' ? `Trade ${bungalow.symbol}` : `${bungalow.symbol} chart`,
  };
}

export interface TapeQueueIdentity {
  evmAddress?: string | null;
  solanaAddress?: string | null;
}

/** The island tape's rows. */
export function tapeQueueRows(
  candidates: readonly TapeMirrorCandidate[],
  now: number,
  identity: TapeQueueIdentity,
): QueueRow[] {
  return candidates.map((c) => {
    const pool = c.fill.pool;
    // Each venue's own identity, and never the other one: an EVM address
    // recorded as the follower of a Solana mirror would make that mirror
    // unmatchable forever.
    const follower =
      c.follow.venue === 'solana'
        ? identity.solanaAddress
          ? identity.solanaAddress.trim()
          : null
        : identity.evmAddress
          ? identity.evmAddress.trim().toLowerCase()
          : null;

    return {
      key: c.key,
      leader: c.follow.leader,
      sourceLabel: pool.label,
      senderLine: SENDER_LINE,
      ageSeconds: now - c.fill.at,
      refusal: c.outcome.ok ? null : { source: 'tape', reason: c.outcome.reason },
      plan: c.outcome.ok
        ? {
            sizeText: formatQuoteAmount(c.outcome.plan.notionalWei, c.outcome.plan.tokenIn),
            cappedText: c.outcome.plan.capped
              ? `your cap, not their size (they put in ${formatQuoteAmount(c.outcome.plan.leaderAmountIn, c.outcome.plan.tokenIn)})`
              : null,
            minOutReason: c.outcome.plan.minOutReason,
            leaderTxHash: c.outcome.plan.leaderTxHash,
            trade: tradeLinkFor(pool),
            intent: follower
              ? {
                  venue: c.follow.venue,
                  leader: c.follow.leader,
                  leaderTxHash: c.outcome.plan.leaderTxHash,
                  leaderTimestamp: c.outcome.plan.leaderTimestamp,
                  confirmedAt: Math.floor(Date.now() / 1000),
                  follower,
                  quoteToken: c.outcome.plan.tokenIn,
                  tokenOut: c.outcome.plan.tokenOut,
                  notionalWei: c.outcome.plan.notionalWei,
                  poolKey: poolKeyOf(pool),
                }
              : null,
            noIdentityReason: follower
              ? null
              : c.follow.venue === 'solana'
                ? 'Add your Solana address below to log this. Without one there is no address to look for your own fill under.'
                : NO_WALLET,
          }
        : null,
    };
  });
}
