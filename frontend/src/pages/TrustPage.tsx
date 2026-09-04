import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { TRUST_SECTION } from '../lib/navConfig';

// Thin hub that frames the three detection surfaces below as one anti-rug suite.
const TrustHubPage = lazy(() => import('./TrustHubPage'));
// Public token scanner (concentration/bundle/holder-quality read; self-gates when
// holder data is unavailable) + wallet exposure view (the scanner pointed inward).
const ScannerPage = lazy(() => import('./ScannerPage'));
const WalletExposurePage = lazy(() => import('./WalletExposurePage'));
// Deployer reputation graph — a deployer's past launches + what happened to each.
const DeployerPage = lazy(() => import('./DeployerPage'));
// The same detection stack pointed at a discovery feed, each row carrying its safety
// read or an explicit statement that it has none. The rows themselves are a
// browser-direct read of GeckoTerminal's market-wide pool feed on an origin the CSP
// already allows, so the page works on every deployment with no env var and no operator
// step. VITE_INDEXER_URL is optional here and decides only whether the venue's own
// "Venue pairs" tab appears beside that feed.
const TerminalPage = lazy(() => import('./TerminalPage'));
// Pro charting (#47). Candles from GeckoTerminal's OHLCV feed, drawn by a
// dependency-free SVG renderer — no charting library, no price oracle. The pool list is
// a registry read, so the picker is fully rendered even when the feed cannot be reached,
// and a timeframe that returned nothing draws NO PLOT: a blank plot area with an axis on
// it reads as a pool that did not trade, which is the one thing it must never say. Not
// flag-gated. VITE_INDEXER_URL adds the venue's own indexed-swap panel when set and
// changes nothing else.
const ChartPage = lazy(() => import('../components/chart/ChartPage'));
// Alert rules over the same subjects (token / wallet / deployer / pool), pushed instead
// of pulled. NOT flag-gated and no longer gated at all: the rule store is this browser's
// own localStorage, so the page works with no wallet, no session and no migration. Each
// panel still prints its own honest state — a rule whose source is dark says so at pick
// time, and a write that did not reach storage is a warning on a form that still works.
const AlertsPage = lazy(() => import('./AlertsPage'));

/**
 * TrustPage — the Trust & Safety section as ONE page with seven tabs.
 *
 * This was a third of the entire "More" dropdown: /trust, /scan, /deployer,
 * /exposure, /terminal, /chart and /alerts, each its own menu row. They are one
 * product — the same three reads (holder concentration, deployer history,
 * wallet exposure) offered on demand, over a discovery feed, over a chart, and
 * as a standing rule — and TrustHubPage was already written to say so. It just
 * had no way to keep a visitor inside the suite once they clicked into a tool.
 *
 * Every route still renders standalone from a deep link; the strip is added
 * above each page, nothing was merged or rewritten. The seven-wide strip scrolls
 * horizontally on a phone (RouteTabs).
 */
export default function TrustPage() {
  return (
    <SectionHost
      section={TRUST_SECTION}
      idPrefix="trust"
      ariaLabel="Trust and safety sections"
      panels={{
        '/trust': TrustHubPage,
        '/scan': ScannerPage,
        '/deployer': DeployerPage,
        '/exposure': WalletExposurePage,
        '/terminal': TerminalPage,
        '/chart': ChartPage,
        '/alerts': AlertsPage,
      }}
    />
  );
}
