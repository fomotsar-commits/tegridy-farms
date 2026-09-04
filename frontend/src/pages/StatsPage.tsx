import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { STATS_SECTION } from '../lib/navConfig';

// Fixed supply, emissions and the distribution table. Was a tab on LearnPage
// until 2026-09-04; see this file's header for why it moved.
const TokenomicsPage = lazy(() => import('./TokenomicsPage'));
// Live on-chain treasury + POL + lifetime fee reads. Was a tab on InfoPage.
const TreasuryPage = lazy(() => import('./TreasuryPage'));
// Capital-gains and income reports (#71). Ethereum-mainnet history is read through
// /api/etherscan — a same-origin function that ships with every deployment of this repo
// — so a report is built from real history rather than from a whole-period gap; the
// F1 indexer is optional enrichment now. A period the ledger could not read is still a
// declared GAP on the export itself, never an omission and never an empty year. The
// cost-basis method is selected by the filer and stamped on every file, because FIFO and
// specific identification are different numbers and an unlabelled report cannot be
// reproduced. Every surface states it is not tax advice.
const TaxPage = lazy(() => import('./TaxPage'));

/**
 * StatsPage — the Stats section as ONE page with three tabs.
 *
 * ⚠️ THIS HOST TOOK TWO ROUTES OFF OTHER HOSTS, and that is the thing to know
 * before editing it. /tokenomics was a tab on LearnPage and /treasury a tab on
 * InfoPage. A route renders exactly one tab bar, so "Stats is one page with
 * tabs" could not be true while those two hosts owned them — there was no
 * version of this change that left all three files alone.
 *
 * The resulting split is the one the "More" menu already implied, and reads
 * better than what it replaced:
 *   · LearnPage  — Lore / Security / FAQ           (the narrative)
 *   · InfoPage   — Contracts / Risks / Terms / Privacy (the legal + reference shelf)
 *   · StatsPage  — Tokenomics / Treasury / Tax     (the numbers)
 *
 * No URL changed. /tokenomics, /treasury and /tax are the same three routes,
 * still linked from the Footer, still hit directly by e2e/trust-pages.spec.ts,
 * and each still renders its page standalone — with this strip above it.
 */
export default function StatsPage() {
  return (
    <SectionHost
      section={STATS_SECTION}
      idPrefix="stats"
      ariaLabel="Stats sections"
      panels={{
        '/tokenomics': TokenomicsPage,
        '/treasury': TreasuryPage,
        '/tax': TaxPage,
      }}
    />
  );
}
