import { lazy } from 'react';
import { SectionHost } from './SectionHost';
import { EARN_SECTION } from '../lib/navConfig';

// Yield routing (#32 / #21 / #34) — a comparison of THIRD-PARTY liquid staking and
// stablecoin lending venues. This venue issues nothing here and deploys no contract:
// every figure is read live from Ethereum mainnet over the public RPC roster, and each
// route sends the deposit straight to that protocol's own permissionless entry function
// in lib/yield/venues.ts. Not flag-gated. The counterparty disclosures and the
// structural refusals (a venue with no on-chain growth rate, or no market leg, says so)
// are as much the product as the routing.
const YieldPage = lazy(() => import('./YieldPage'));
// Copy trading (#7). It reads the ISLAND TAPE —
// GeckoTerminal's pool-trade feed for the registry's resident pools plus the venue's
// own TOWELI/WETH pool — so it needs no env var, key or proxy. NOT flag-gated,
// and the refusals rather than the feed are what make routing it right: no wallet on
// the board carries a profit figure (a pool fill is one leg of a trade) and nothing
// executes for you because this venue runs no keeper. A read that fails is named by
// the page's own ledger, not flattened into an empty table. The trading competitions
// that sat beside it were deleted 2026-10-15 (the owner; island item 4: no seasons).
const CopyTradingPage = lazy(() => import('./CopyTradingPage'));
// Merchant checkout + recurring billing (#68 / #69). NOT flag-gated, because the
// states it can be in are the product: the buyer is shown the exact amount and the
// exact settlement asset before signing, and no signature is offered at all when the
// route cannot guarantee the merchant's exact amount. Non-custodial by construction —
// both legs are signed in the buyer's own wallet with the merchant as the direct
// recipient, and api/_lib/commerce.js holds no key. The invoice itself needs no server:
// it is an EIP-712 document the merchant signs and carries in the link's `#i=` fragment,
// which the buyer's browser verifies against the merchant address. `021_commerce.sql`
// still gates only the optional short `?invoice=` form, and that lookup answers 503
// `schema-missing` rather than "no such invoice" until an operator applies it.
const CheckoutPage = lazy(() => import('./CheckoutPage'));
// The pools themselves — staking, locks, LP farming. Came in from the top bar
// on 2026-09-05, where it was called "Farm": DeFi jargon, and the same idea this
// section was already named after, so one thing wore two names at two levels.
const FarmPage = lazy(() => import('./FarmPage'));
// Borrowing against an NFT, and the NFT AMM. Also came in from the top bar,
// where it was "NFT Finance" — a category, not something anyone wants to do.
const LendingPage = lazy(() => import('./LendingPage'));

/**
 * EarnPage — the Earn section as ONE page with tabs.
 *
 * What these share is the visitor's job: turn attention, capital or a
 * customer into income. What they do NOT share is a contract, a feed or a
 * counterparty, which is why each keeps its own route, its own gating predicate
 * and its own disclosures — /yield's venues are other people's protocols,
 * /copy-trading reads a third-party tape and settles nothing,
 * /checkout is a browser-signed transfer. The tab strip carries each entry's
 * SOON pill straight from navConfig so collapsing the menu cannot quietly
 * un-disclose a gated one.
 */
export default function EarnPage() {
  return (
    <SectionHost
      section={EARN_SECTION}
      idPrefix="earn"
      ariaLabel="Earn sections"
      panels={{
        '/earn': FarmPage,
        '/nft-finance': LendingPage,
        '/yield': YieldPage,
        '/copy-trading': CopyTradingPage,
        '/checkout': CheckoutPage,
      }}
    />
  );
}
