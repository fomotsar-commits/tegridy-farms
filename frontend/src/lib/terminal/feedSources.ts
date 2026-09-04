// Which of the terminal's two feeds this deployment can actually read.
//
// ONE FUNCTION DECIDES, so the tab and the sentence beneath it cannot disagree.
// The Venue-pairs tab is rendered iff `indexer.readable`, and when it is absent
// the page renders `indexer.detail` verbatim — the same value, read once. A
// second source of truth here is how a build ends up showing a tab that leads
// to a permanent "unavailable" banner.
//
// It returns `SourceReadiness` from lib/alerts/sources.ts rather than a shape of
// its own: that module already settled what a readiness claim means here —
// `readable` is "a request would go somewhere real", NOT "it answers" — and the
// terminal must not quietly mean something else by the same word.

import { indexerConfigProblem, isIndexerConfigured } from '../indexer/client';
import type { SourceReadiness } from '../alerts/sources';

export type TerminalFeedSourceId = 'geckoterminal' | 'indexer';

const INDEXER_UNSET_DETAIL =
  'VITE_INDEXER_URL is not set, so the venue’s own pairs — with in-window activity counts and a head-block time — are not read on this deployment. The market feed above does not need it.';

/**
 * Live config, read on every call.
 *
 * A function rather than a module constant for the reason indexer/client.ts and
 * heatGateConfig.ts are: a constant snapshots `import.meta.env` at import time,
 * which makes the value untestable and makes a per-request build indistinguishable
 * from a stale one.
 */
export function terminalSourceReadiness(): Record<TerminalFeedSourceId, SourceReadiness> {
  const indexerReadable = isIndexerConfigured();
  return {
    // A keyless public API, read browser-direct through an origin the CSP
    // already allows (vercel.json connect-src). There is no key, no migration
    // and no operator step that could make it absent from a deployment, so
    // there is nothing here a client could read that would ever be false. A
    // failure is an OUTAGE and is reported as one at read time, by the feed's
    // own banner — the same rule the same-origin entries in alerts/sources.ts
    // follow. This is deliberately not dressed up as a live gate; see the
    // navConfig entry for why the page carries no "soon" pill.
    geckoterminal: { readable: true, detail: null },
    indexer: {
      readable: indexerReadable,
      // `indexerConfigProblem()` distinguishes a typo'd URL from an unset one,
      // because a live misconfiguration deserves different words than the
      // intended pre-deploy state.
      detail: indexerReadable ? null : (indexerConfigProblem() ?? INDEXER_UNSET_DETAIL),
    },
  };
}
