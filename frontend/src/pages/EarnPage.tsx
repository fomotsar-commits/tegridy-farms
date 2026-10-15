import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { LOCK_SECTION } from '../lib/navConfig';

// Yield routing compares THIRD-PARTY staking and lending venues: the venue deploys nothing,
// every figure is read live from mainnet, and each route deposits straight into that
// protocol's own entry function (lib/yield/venues.ts). A venue that cannot be read says so.
const YieldPage = lazy(() => import('./YieldPage'));
// Both read the island tape (GeckoTerminal's trades for the resident pools), so neither needs a
// key. No wallet carries a profit figure, nothing executes for you and no season pays; a read
// that fails is named by each page's own ledger.
const CopyTradingPage = lazy(() => import('./CopyTradingPage'));
const CompetitionsPage = lazy(() => import('./CompetitionsPage'));
// Merchant checkout: the buyer sees the exact amount and asset before signing, both legs are
// signed in the buyer's wallet to the merchant, and the invoice is an EIP-712 document in the
// link's `#i=` fragment. `021_commerce.sql` gates only the short `?invoice=` form (503 until applied).
const CheckoutPage = lazy(() => import('./CheckoutPage'));
// The pools themselves: staking, locks, LP farming.
const FarmPage = lazy(() => import('./FarmPage'));
// Borrowing against an NFT, and the NFT AMM.
const LendingPage = lazy(() => import('./LendingPage'));

/**
 * The Lock section as one page with tabs (the bar's word is Lock; the page is Earn). Each tab
 * keeps its own route, gate and disclosures: they share the visitor's job, not a contract or a
 * counterparty. A tab that is off is left out of the strip (RouteTabs.tsx).
 */
export default function EarnPage() {
  return (
    <SectionHost
      section={LOCK_SECTION}
      idPrefix="earn"
      ariaLabel="Earn sections"
      panels={{
        '/earn': FarmPage,
        '/nft-finance': LendingPage,
        '/yield': YieldPage,
        '/copy-trading': CopyTradingPage,
        '/competitions': CompetitionsPage,
        '/checkout': CheckoutPage,
      }}
    />
  );
}
