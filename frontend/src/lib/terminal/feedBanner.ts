// What the market feed IS, in words, before any row is drawn.
//
// This module exists because of one specific lie a discovery feed tells by
// accident: an empty table. "No new pools" is a claim about an entire chain, and
// it is the exact pixel-for-pixel output of a rate-limited request, a schema
// drift, and a dropped connection. So the four states below are kept apart all
// the way to the screen, each with its own sentence:
//
//   unreachable  — we asked and got nothing usable. NOT a market observation.
//   ready, 0 rows — the upstream's own answer for this view. A real, if narrow,
//                  fact, and attributed to the upstream rather than to us.
//   ready, n rows — n pools, read at a fixed time, plus what was dropped.
//   idle/loading — nothing has been asked yet.
//
// PURE, and it is where every rendered word on this feed lives. Keeping the copy
// out of the component means a test can assert that no state was left without
// words, which is the failure mode a component would hide behind a conditional.
//
// FIXED TIME, NOT A TICKING ONE. `readAt` is stamped once when the response was
// parsed and rendered as an ISO string. A relative "12s ago" would keep counting
// while the page sat untouched, implying a stream this venue does not run.

import type { GeckoNetwork, MarketRow } from '../geckoTerminal/pools';
import type { TerminalView } from './terminalParams';

/**
 * The sentence that must appear wherever this page has no rows to show.
 *
 * Moved here from components/terminal/FeedStatus.tsx so the indexer banner and
 * the market banner state it identically — it was the one line both surfaces
 * needed and neither owned.
 */
export const NOT_A_ZERO =
  'Nothing on this page is a statement about what is or is not launching right now.';

/** Views backed by the GeckoTerminal read. 'indexer' has its own banner. */
export type MarketView = Exclude<TerminalView, 'indexer'>;

export type MarketFeedUnreadReason = 'network' | 'http' | 'rate-limited' | 'malformed';

export type MarketFeedState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready';
      rows: MarketRow[];
      /** Entries the upstream sent that had no readable address. Rendered. */
      dropped: number;
      /** Unix SECONDS, captured ONCE when the response was parsed. */
      readAt: number;
    }
  | {
      status: 'unreachable';
      reason: MarketFeedUnreadReason;
      /** The reader's own factual sentence — for `http` it names the code. */
      detail: string;
    };

export type BannerTone = 'neutral' | 'good' | 'warn';

export interface FeedBanner {
  title: string;
  tone: BannerTone;
  lines: string[];
  showRetry: boolean;
  /** True when this state must carry NOT_A_ZERO. Rendered by the component. */
  notAZero: boolean;
}

export const NETWORK_LABEL: Record<GeckoNetwork, string> = {
  eth: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
};

export const MARKET_VIEW_LABEL: Record<MarketView, string> = {
  new: 'new pools',
  trending: 'trending on GeckoTerminal',
  island: 'the island’s residents',
  watchlist: 'your watchlist',
};

/**
 * Why each view's numbers are there at all — the attribution rule, per view.
 *
 * The Trending tab is the one that most needs it: an ordering this venue did not
 * compute, shown on this venue's page, reads as this venue's ranking unless the
 * page says otherwise in words.
 */
const VIEW_ATTRIBUTION: Record<MarketView, string> = {
  new: 'Ordering is GeckoTerminal’s, newest first by its own record of pool creation.',
  trending:
    'The ordering is GeckoTerminal’s trending score, not a ranking by this venue. Nothing here is endorsed, vetted or recommended.',
  island:
    'These are the island’s own residents, read from the same upstream as every other row. Being listed in the registry is a fact about the registry, not a safety result — select a row to read it.',
  watchlist: 'These are the pools you starred, read from the same upstream. Your star is not a rating.',
};

const REASON_SENTENCE: Record<MarketFeedUnreadReason, string> = {
  'rate-limited':
    'GeckoTerminal allows only a handful of reads a minute from one address and refused this one. Wait a moment and re-read — this is a limit on the read, not a statement about the market.',
  malformed:
    'GeckoTerminal answered in a shape this build does not recognise, so nothing was read rather than half-read.',
  http: 'GeckoTerminal refused this request, so nothing was read.',
  network: 'The request to GeckoTerminal did not complete, so nothing was read.',
};

export interface FeedBannerContext {
  network: GeckoNetwork;
  view: MarketView;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function feedBanner(state: MarketFeedState, ctx: FeedBannerContext): FeedBanner {
  const where = `${NETWORK_LABEL[ctx.network]} · ${MARKET_VIEW_LABEL[ctx.view]}`;

  switch (state.status) {
    case 'idle':
      return {
        title: 'The market feed has not been read yet',
        tone: 'neutral',
        lines: ['Nothing has been asked of GeckoTerminal for this view.'],
        showRetry: false,
        notAZero: true,
      };

    case 'loading':
      return {
        title: 'Reading the market feed…',
        tone: 'neutral',
        lines: [`Asking GeckoTerminal for ${where}.`],
        showRetry: false,
        notAZero: false,
      };

    case 'unreachable':
      return {
        title: 'The market feed could not be read',
        tone: 'warn',
        // Two sentences on purpose, and they are not redundant: the first says
        // what the refusal means for a reader, the second is the reader
        // module's own factual account and is the only place an HTTP status
        // code appears. Neither is a substitute for the other.
        lines: [REASON_SENTENCE[state.reason], state.detail],
        showRetry: true,
        notAZero: true,
      };

    case 'ready': {
      const n = state.rows.length;
      const readAtIso = new Date(state.readAt * 1000).toISOString();

      if (n === 0) {
        return {
          title: 'GeckoTerminal returned no pools for this view',
          tone: 'warn',
          lines: [
            `The upstream answered with no pools for ${where}, read at ${readAtIso}. That is its answer for this window — not this venue’s — so no table is drawn.`,
            ...(state.dropped > 0 ? [droppedLine(state.dropped)] : []),
          ],
          showRetry: true,
          notAZero: true,
        };
      }

      return {
        title: 'Live market feed',
        tone: 'good',
        lines: [
          `${n} ${plural(n, 'pool', 'pools')} from GeckoTerminal (${where}), read at ${readAtIso}.`,
          'Nothing here is endorsed, ranked or vetted by this venue; a row is a pool that exists and what the upstream reported about it.',
          VIEW_ATTRIBUTION[ctx.view],
          ...(state.dropped > 0 ? [droppedLine(state.dropped)] : []),
        ],
        showRetry: true,
        notAZero: false,
      };
    }
  }
}

/**
 * The dropped count is RENDERED, never quietly absorbed.
 *
 * `parseGeckoPoolList` guarantees `rows.length + dropped` equals what upstream
 * sent. Showing the rows without the count would present a filtered list as the
 * whole answer — the same class of quiet lie as a fabricated zero, one level up.
 */
function droppedLine(dropped: number): string {
  return `${dropped} ${plural(dropped, 'pool was', 'pools were')} withheld from this table: ${plural(
    dropped,
    'its address',
    'their addresses',
  )} could not be read as an address on this network, so ${plural(
    dropped,
    'it',
    'they',
  )} could not be linked or scanned.`;
}

/**
 * Age at the moment of the read, in words.
 *
 * `null` is NOT zero and not "new": `pool_created_at` is genuinely absent from
 * some upstream rows, and defaulting it is the live bug in lib/launcher's older
 * parser (a missing timestamp became 1970, rendering as fifty-six years).
 */
export function ageAtRead(createdAt: number | null, readAt: number): string | null {
  if (createdAt === null) return null;
  const seconds = readAt - createdAt;
  // A creation stamped after the read is upstream disagreeing with itself; it is
  // reported as unknown rather than as a negative age or a fabricated "0m".
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
